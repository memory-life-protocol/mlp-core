/**
 * Encoder
 *
 * Transforms a raw Signal into a fully formed Cluster and stores it.
 *
 * What it does:
 *   - Validates the incoming signal
 *   - Extracts structured dimensions via the ExtractionAdapter
 *   - Generates a vector embedding via the EmbeddingAdapter
 *   - Builds a complete Cluster matching the protocol spec
 *   - Resolves implied connections against the existing graph
 *   - Stores the cluster via the StorageAdapter
 *
 * What it does not do:
 *   - It never touches a database directly
 *   - It never calls an LLM directly
 *   - It never invents or infers beyond what the signal contains
 *   - It never overwrites existing clusters — upsert is handled by adapter
 *
 * Enrichment comes from signal convergence not inference.
 * Multiple independent sources corroborating the same knowledge
 * raise confidence. One source alone stays provisional.
 *
 * Scientific basis:
 *   Hebbian principle — connections implied by the signal are
 *   established at strength 0.5 and grow through co-activation.
 */

import { randomUUID } from 'crypto'
import type { StorageAdapter } from '../interfaces/StorageAdapter.js'
import type { EmbeddingAdapter } from '../interfaces/EmbeddingAdapter.js'
import type { ExtractionAdapter } from '../interfaces/ExtractionAdapter.js'
import type {
  Signal,
  Cluster,
  ClusterConnection,
  WatcherSignal
} from '../interfaces/types.js'

export class Encoder {

  constructor(
    private storageAdapter: StorageAdapter,
    private embeddingAdapter: EmbeddingAdapter,
    private extractionAdapter: ExtractionAdapter
  ) {}

  async encode(
    signal: Signal
  ): Promise<{ success: boolean; id: string; error?: string }> {

    // STEP 1 — Validate
    if (!signal.raw || signal.raw.trim().length === 0) {
      return { success: false, id: '', error: 'Signal raw content is empty' }
    }

    // STEP 2 — Extract dimensions via LLM
    let extracted
    try {
      extracted = await this.extractionAdapter.extract(signal.raw)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, id: '', error: 'Extraction failed: ' + message }
    }

    // STEP 3 — Generate embedding
    let embedding: number[]
    try {
      embedding = await this.embeddingAdapter.embed(extracted.what)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, id: '', error: 'Embedding failed: ' + message }
    }

    // STEP 4 — Build the cluster
    const now = new Date().toISOString()
    const cluster: Cluster = {
      id: randomUUID(),
      created_at: now,
      updated_at: now,
      what: extracted.what,
      why: extracted.why ?? 'Not specified',
      confidence: 'provisional',
      evidence: [
        {
          source_type: signal.source_type,
          source_tool: signal.source_tool,
          corroborated_at: now,
          detail: 'Initial encoding',
          encoded_by: signal.encoded_by
        }
      ],
      temporal: {
        valid_from: signal.timestamp,
        valid_to: null,
        history: []
      },
      source: {
        type: signal.source_type,
        tool: signal.source_tool,
        encoded_by: signal.encoded_by
      },
      domain: {
        workspace: signal.workspace,
        module: extracted.module ?? null,
        workflow: extracted.workflow ?? null,
        tags: []
      },
      connections: [],
      weight: {
        structural: 0,
        usage: 0,
        combined: 0
      },
      embedding
    }

    // STEP 5 — Resolve implied connections
    for (const implied of extracted.connections_implied) {
      try {
        const impliedEmbedding = await this.embeddingAdapter.embed(implied)
        const activation = await this.storageAdapter.activateCluster(
          {
            query: implied,
            embedding: impliedEmbedding,
            workspace: signal.workspace,
            session_context: []
          },
          1
        )
        if (activation.seed) {
          const connection: ClusterConnection = {
            target_cluster_id: activation.seed.id,
            type: 'references',
            strength: 0.5,
            direction: 'unidirectional',
            context: implied,
            established_at: now,
            last_activated: now,
            activation_count: 1
          }
          cluster.connections.push(connection)
        }
      } catch {
        // Connection resolution failed for this implied concept.
        // Continue — a missing connection is not a fatal error.
        // It will resolve when the referenced cluster is encoded later.
      }
    }

    // STEP 6 — Store
    return await this.storageAdapter.encodeCluster(cluster)
  }

  // Process a signal from a watcher connector.
  // Delegates to the storage adapter which handles
  // enrichment, contradiction detection, and confidence updates.
  async processWatcherSignal(
    signal: WatcherSignal
  ): Promise<{
    action: 'enriched' | 'contradicted' | 'created' | 'ignored'
    cluster_id: string | null
    reason: string
  }> {
    return await this.storageAdapter.processWatcherSignal(signal)
  }

}
