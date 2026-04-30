/**
 * AnthropicEmbeddingAdapter
 *
 * Implements EmbeddingAdapter using the Anthropic Voyage API.
 * Uses voyage-3 — Anthropic's best embedding model.
 * Dimension: 1024.
 *
 * What it does:
 *   - Makes one API call per embed operation
 *   - Returns a normalised float array of dimension 1024
 *   - Uses native fetch only — zero extra dependencies
 *
 * What it does not do:
 *   - It does not import the Anthropic SDK
 *   - It does not cache or batch requests
 *   - It does not retry on failure
 *
 * Critical constraint:
 *   The same model must be used at encode time and query time.
 *   If you change the model after encoding clusters, all existing
 *   embeddings become incomparable. The dimension is stored with
 *   the adapter for validation — check it matches your storage
 *   vector index dimension before deploying.
 *
 * To use a different embedding provider:
 *   Implement EmbeddingAdapter with a different fetch target.
 *   Nothing else in the protocol changes.
 */

import type { EmbeddingAdapter } from '../../src/interfaces/EmbeddingAdapter.js'

interface AnthropicEmbeddingConfig {
  apiKey: string
  model?: string
}

export class AnthropicEmbeddingAdapter implements EmbeddingAdapter {
  readonly dimension = 1024
  readonly modelName: string
  readonly provider = 'anthropic'

  private apiKey: string

  constructor(config: AnthropicEmbeddingConfig) {
    if (!config.apiKey) {
      throw new Error(
        'AnthropicEmbeddingAdapter requires ANTHROPIC_API_KEY'
      )
    }
    this.apiKey = config.apiKey
    this.modelName = config.model ?? 'voyage-3'
  }

  async embed(text: string): Promise<number[]> {
    if (!text || text.trim().length === 0) {
      throw new Error('Cannot embed empty text')
    }

    const response = await fetch('https://api.anthropic.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: this.modelName,
        input: text.trim()
      })
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(
        `Anthropic Embeddings API error ${response.status}: ${error}`
      )
    }

    const data = await response.json() as {
      embeddings: Array<{ embedding: number[] }>
    }

    const embedding = data.embeddings?.[0]?.embedding

    if (!embedding || embedding.length === 0) {
      throw new Error('Anthropic API returned empty embedding')
    }

    if (embedding.length !== this.dimension) {
      throw new Error(
        `Expected embedding dimension ${this.dimension} but got ${embedding.length}`
      )
    }

    return embedding
  }
}
