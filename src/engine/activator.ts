import type { ActivationResult, Trigger } from '../interfaces/types.js'
import type { StorageAdapter } from '../interfaces/StorageAdapter.js'
import type { EmbeddingAdapter } from '../interfaces/EmbeddingAdapter.js'

export class Activator {
  private storageAdapter: StorageAdapter
  private embeddingAdapter: EmbeddingAdapter

  constructor(storageAdapter: StorageAdapter, embeddingAdapter: EmbeddingAdapter) {
    this.storageAdapter = storageAdapter
    this.embeddingAdapter = embeddingAdapter
  }

  async activate(
    query: string,
    workspace: string,
    session_context: string[],
    depth?: number
  ): Promise<ActivationResult> {
    // STEP 1 — Clamp depth, default to 6 (Watts small-world boundary)
    const resolvedDepth = Math.min(6, Math.max(1, depth ?? 6))

    // STEP 2 — Vectorise the query
    const embedding = await this.embeddingAdapter.embed(query)

    // STEP 3 — Build trigger and activate
    const trigger: Trigger = {
      query,
      embedding,
      workspace,
      session_context,
    }

    const result = await this.storageAdapter.activateCluster(trigger, resolvedDepth)

    if (!result.seed) {
      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        seed: null as any,
        activated: [],
        total_activated: 0,
        depth_reached: 0,
      }
    }

    // STEP 4 — Strengthen co-activated paths (Hebbian, fire and forget)
    const ids = result.activated.map(e => e.cluster.id)
    const pairs: Array<Promise<unknown>> = []
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        pairs.push(this.storageAdapter.strengthenPath(ids[i], ids[j]))
      }
    }
    Promise.allSettled(pairs)

    // STEP 5 — Return result as received from the adapter
    return result
  }
}
