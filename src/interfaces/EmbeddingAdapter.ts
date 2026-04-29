interface EmbeddingAdapter {

  // Generate a vector embedding for a piece of text
  // Returns a flat number array
  // Dimension must be consistent across all calls
  embed(text: string): Promise<number[]>

  // The vector dimension this adapter produces
  // Must match the dimension used when clusters were stored
  // Anthropic voyage-3 = 1024
  readonly dimension: number

  // Human readable model name — stored with clusters for auditability
  readonly modelName: string

}

export type { EmbeddingAdapter }
