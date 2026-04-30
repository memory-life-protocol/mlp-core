interface EmbeddingAdapter {

  // Generate a vector embedding for a piece of text.
  // Dimension must be consistent across all calls.
  // Same model must be used at encode time and query time.
  embed(text: string): Promise<number[]>

  // The vector dimension this adapter produces.
  // Anthropic voyage-3 = 1024
  // OpenAI text-embedding-3-large = 3072
  // Must match the dimension used when clusters were stored.
  readonly dimension: number

  // Human readable model name — stored with clusters for auditability.
  // Example: 'voyage-3', 'text-embedding-3-large', 'local-nomic-embed'
  readonly modelName: string

  // Provider name — stored for auditability.
  // Example: 'anthropic', 'openai', 'ollama'
  readonly provider: string

}

export type { EmbeddingAdapter }
