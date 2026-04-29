import { randomUUID } from 'crypto'
import type { Signal, Cluster, ClusterConnection, Trigger } from '../interfaces/types.js'
import type { StorageAdapter } from '../interfaces/StorageAdapter.js'
import type { EmbeddingAdapter } from '../interfaces/EmbeddingAdapter.js'
import type { ExtractionAdapter } from '../interfaces/ExtractionAdapter.js'

export class Encoder {
  private storageAdapter: StorageAdapter
  private embeddingAdapter: EmbeddingAdapter
  private extractionAdapter: ExtractionAdapter

  constructor(
    storageAdapter: StorageAdapter,
    embeddingAdapter: EmbeddingAdapter,
    extractionAdapter: ExtractionAdapter
  ) {
    this.storageAdapter = storageAdapter
    this.embeddingAdapter = embeddingAdapter
    this.extractionAdapter = extractionAdapter
  }

  async encode(signal: Signal): Promise<{ success: boolean; id: string; error?: string }> {
    // STEP 1 — Validate
    if (!signal.raw.trim()) {
      return { success: false, id: '', error: 'Signal raw content is empty' }
    }

    // STEP 2 — Extract dimensions
    let extracted
    try {
      extracted = await this.extractionAdapter.extract(signal.raw)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, id: '', error: `Extraction failed: ${message}` }
    }

    // STEP 3 — Generate embedding
    let embedding: number[]
    try {
      embedding = await this.embeddingAdapter.embed(extracted.what)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, id: '', error: `Embedding failed: ${message}` }
    }

    // STEP 4 — Build cluster
    const cluster: Cluster = {
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      what: extracted.what,
      why: extracted.why ?? 'Not specified',
      temporal: {
        valid_from: signal.timestamp,
        valid_to: null,
        history: [],
      },
      source: {
        type: signal.source_type,
        tool: signal.source_tool,
        encoded_by: signal.encoded_by,
      },
      domain: {
        workspace: signal.workspace,
        module: extracted.module ?? null,
        workflow: extracted.workflow ?? null,
        tags: [],
      },
      connections: [],
      weight: {
        structural: 0,
        usage: 0,
        combined: 0,
      },
      embedding,
    }

    // STEP 5 — Resolve connections
    for (const implied of extracted.connections_implied) {
      const impliedEmbedding = await this.embeddingAdapter.embed(implied)

      const trigger: Trigger = {
        query: implied,
        embedding: impliedEmbedding,
        workspace: signal.workspace,
        session_context: [],
      }

      const activation = await this.storageAdapter.activateCluster(trigger, 1)

      if (activation.seed) {
        const connection: ClusterConnection = {
          target_cluster_id: activation.seed.id,
          type: 'references',
          strength: 0.5,
          direction: 'unidirectional',
          context: implied,
          established_at: new Date().toISOString(),
          last_activated: new Date().toISOString(),
          activation_count: 1,
        }
        cluster.connections.push(connection)
      }
    }

    // STEP 6 — Store
    return this.storageAdapter.encodeCluster(cluster)
  }
}
