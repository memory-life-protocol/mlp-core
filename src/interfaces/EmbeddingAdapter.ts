/**
 * EmbeddingAdapter Interface
 *
 * MLP needs vector embeddings to do semantic similarity search.
 * It does not care who generates them.
 *
 * Implement this to use: Anthropic, OpenAI, Cohere, a local model, anything.
 */

export interface EmbeddingAdapter {

  /**
   * Generate an embedding vector for a piece of text.
   * The dimension of the returned array must be consistent
   * with what was used when clusters were stored.
   */
  embed(text: string): Promise<number[]>;

  /**
   * The dimension of vectors this adapter produces.
   * Used for validation and storage configuration.
   */
  dimension: number;

  /**
   * Human-readable name of the model/provider.
   * Stored alongside clusters for auditability.
   */
  modelName: string;
}
