/**
 * Activator
 *
 * Takes a natural language query and returns a raw ActivationResult.
 *
 * What it does:
 *   - Embeds the query via EmbeddingAdapter
 *   - Builds a Trigger scoped to the workspace
 *   - Calls storageAdapter.activateCluster to find seed and spread
 *   - Applies Hebbian strengthening to co-activated pairs
 *   - Returns the raw ActivationResult for the Surfacer to enrich
 *
 * What it does not do:
 *   - It never surfaces structural or temporal context — that is the Surfacer
 *   - It never touches a database directly
 *   - It never crosses workspace boundaries
 *   - It never returns superseded clusters
 *
 * Scientific basis:
 *   Watts small world — depth clamped to 6, the natural boundary
 *   beyond which activation scores decay below signal threshold.
 *
 *   Hebbian principle — every pair of clusters that co-activates
 *   gets its connection strengthened asynchronously after the
 *   result is assembled. Fire and forget — never blocks response.
 *
 *   Activation score formula:
 *     score = seed_similarity
 *           × connection_strength_along_path
 *           × (1 / degree)
 *           × cluster.weight.combined
 */

import type { StorageAdapter } from '../interfaces/StorageAdapter.js'
import type { EmbeddingAdapter } from '../interfaces/EmbeddingAdapter.js'
import type { ActivationResult } from '../interfaces/types.js'

export class Activator {

  private queryCache: Map<string, { embedding: number[], expires_at: number }> = new Map()
  private readonly QUERY_TTL_MS = 1000 * 60 * 60 // 1 hour

  constructor(
    private storageAdapter: StorageAdapter,
    private embeddingAdapter: EmbeddingAdapter
  ) {}

  async activate(
    query: string,
    workspace: string,
    session_context: string[],
    depth?: number
  ): Promise<ActivationResult> {

    // Clamp depth between 1 and 6 — Watts boundary
    const resolvedDepth = Math.min(Math.max(depth ?? 6, 1), 6)

    // Embed the query — cache by normalised text for 1 hour
    const cacheKey = query.trim().toLowerCase()
    const cached = this.queryCache.get(cacheKey)
    const now = Date.now()

    let embedding: number[]
    if (cached && cached.expires_at > now) {
      embedding = cached.embedding
    } else {
      embedding = await this.embeddingAdapter.embed(query)
      this.queryCache.set(cacheKey, { embedding, expires_at: now + this.QUERY_TTL_MS })

      // Evict expired entries periodically — keep cache clean
      if (this.queryCache.size > 1000) {
        for (const [key, value] of this.queryCache.entries()) {
          if (value.expires_at <= now) this.queryCache.delete(key)
        }
      }
    }

    // Build trigger scoped to workspace
    const trigger = {
      query,
      embedding,
      workspace,
      session_context
    }

    // Activate through the graph
    const result = await this.storageAdapter.activateCluster(
      trigger,
      resolvedDepth
    )

    // Hebbian strengthening — fire and forget, never blocks response
    // Every pair that co-activated gets their connection strengthened
    if (result.seed && result.activated.length > 0) {
      const allIds = [
        result.seed.id,
        ...result.activated.map(a => a.cluster.id)
      ]

      const pairs: Array<[string, string]> = []
      for (let i = 0; i < allIds.length; i++) {
        for (let j = i + 1; j < allIds.length; j++) {
          pairs.push([allIds[i], allIds[j]])
        }
      }

      Promise.allSettled(
        pairs.map(([idA, idB]) =>
          this.storageAdapter.strengthenPath(idA, idB, workspace)
        )
      )
      // Intentionally not awaited — Hebbian strengthening is background work
    }

    return result
  }

}
