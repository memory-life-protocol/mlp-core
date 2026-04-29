/**
 * StubEmbeddingAdapter
 *
 * Generates deterministic pseudo-embeddings from text using a hash function.
 * No API calls. No external dependencies.
 *
 * Used for development and testing. Similarity scores will be approximate
 * but directionally correct for text that shares vocabulary.
 *
 * Replace with AnthropicEmbeddingAdapter or OpenAIEmbeddingAdapter in production.
 */

import type { EmbeddingAdapter } from '../interfaces/EmbeddingAdapter.js';

export class StubEmbeddingAdapter implements EmbeddingAdapter {
  readonly dimension = 128; // Small for dev — real adapters use 1536 or 3072
  readonly modelName = 'stub-hash-v1';

  async embed(text: string): Promise<number[]> {
    return stubEmbed(text, this.dimension);
  }
}

/**
 * Produces a deterministic float32 vector from text.
 * Words that appear in both texts will push their vectors closer together.
 * Not semantic, but sufficient for testing activation spreading.
 */
function stubEmbed(text: string, dim: number): number[] {
  const tokens = tokenise(text);
  const vector = new Float32Array(dim);

  for (const token of tokens) {
    const hash = cyrb53(token);
    // Scatter each token across several dimensions
    for (let i = 0; i < 4; i++) {
      const idx = Math.abs((hash >> (i * 8)) & 0xff) % dim;
      vector[idx] += 1.0;
    }
  }

  // L2 normalise
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) vector[i] /= norm;
  }

  return Array.from(vector);
}

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2);
}

// cyrb53 — fast, good distribution, no dependencies
function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;

  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x85ebca77);
    h2 = Math.imul(h2 ^ ch, 0xc2b2ae3d);
  }

  h1 ^= Math.imul(h1 ^ (h2 >>> 15), 0x735a2d97);
  h2 ^= Math.imul(h2 ^ (h1 >>> 15), 0xcaf649a9);
  h1 ^= h2 >>> 16;
  h2 ^= h1 >>> 16;

  return 2097152 * (h2 >>> 0) + (h1 >>> 11);
}
