import { randomUUID } from 'crypto'
import type { Signal, Cluster, ClusterConnection, Trigger } from '../interfaces/types.js'
import type { StorageAdapter } from '../interfaces/StorageAdapter.js'
import type { EmbeddingAdapter } from '../interfaces/EmbeddingAdapter.js'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'

interface Extracted {
  what: string
  why: string | null
  module: string | null
  workflow: string | null
  connections_implied: string[]
  significance_hint: 'high' | 'medium' | 'low'
}

export class Encoder {
  private storageAdapter: StorageAdapter
  private embeddingAdapter: EmbeddingAdapter

  constructor(storageAdapter: StorageAdapter, embeddingAdapter: EmbeddingAdapter) {
    this.storageAdapter = storageAdapter
    this.embeddingAdapter = embeddingAdapter
  }

  async encode(signal: Signal): Promise<{ success: boolean; id: string; error?: string }> {
    // STEP 1 — Validate
    if (!signal.raw.trim()) {
      return { success: false, id: '', error: 'Signal raw content is empty' }
    }

    // STEP 2 — Extract dimensions via LLM
    const extracted = await this.extractDimensions(signal.raw)
    if (!extracted.ok) {
      return { success: false, id: '', error: extracted.error }
    }
    const dims = extracted.value

    // STEP 3 — Generate embedding
    const embedding = await this.embeddingAdapter.embed(dims.what)

    // STEP 4 — Build cluster
    const cluster: Cluster = {
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      what: dims.what,
      why: dims.why ?? 'Not specified',
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
        module: dims.module ?? null,
        workflow: dims.workflow ?? null,
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
    for (const implied of dims.connections_implied) {
      const trigger: Trigger = {
        query: implied,
        embedding: await this.embeddingAdapter.embed(implied),
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

  private async extractDimensions(
    raw: string
  ): Promise<{ ok: true; value: Extracted } | { ok: false; error: string }> {
    const prompt =
      `You are an encoding engine for a memory protocol.\n` +
      `Extract the following from the input exactly as present.\n` +
      `Do not invent. Do not infer beyond what is stated.\n\n` +
      `Input: ${raw}\n\n` +
      `Return only valid JSON with no markdown, no backticks, no explanation:\n` +
      `{\n` +
      `  "what": "the core knowledge — one to three sentences",\n` +
      `  "why": "the intent or reason — one to three sentences, null if not present",\n` +
      `  "module": "which domain area this belongs to or null",\n` +
      `  "workflow": "which workflow this relates to or null",\n` +
      `  "connections_implied": ["list of concepts this explicitly references"],\n` +
      `  "significance_hint": "high|medium|low based on language used"\n` +
      `}`

    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    const body = await response.json() as {
      content?: Array<{ type: string; text: string }>
    }

    const text = body.content?.[0]?.text ?? ''

    try {
      const parsed = JSON.parse(text) as Extracted
      return { ok: true, value: parsed }
    } catch {
      return { ok: false, error: `Extraction failed: ${text}` }
    }
  }
}
