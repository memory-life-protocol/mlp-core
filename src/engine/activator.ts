/**
 * Activator
 *
 * Takes a query, finds seed clusters via vector similarity,
 * spreads activation through weighted connections (Watts + Hebb),
 * and returns a ranked activation result.
 *
 * This is the retrieve side of MLP. Not keyword search. Not RAG.
 * Activation — context surfaces because it's connected, not just because
 * it matches.
 */

import type { ActivateInput, ActivationResult, ActivatedCluster } from '../interfaces/types.js';
import type { StorageAdapter } from '../interfaces/StorageAdapter.js';
import type { EmbeddingAdapter } from '../interfaces/EmbeddingAdapter.js';

export interface ActivatorConfig {
  storage: StorageAdapter;
  embedder: EmbeddingAdapter;

  /** How many seed clusters to find via vector search before spreading */
  seedTopK?: number;
}

export class Activator {
  private storage: StorageAdapter;
  private embedder: EmbeddingAdapter;
  private seedTopK: number;

  constructor(config: ActivatorConfig) {
    this.storage = config.storage;
    this.embedder = config.embedder;
    this.seedTopK = config.seedTopK ?? 3;
  }

  async activate(input: ActivateInput): Promise<ActivationResult> {
    const maxDegrees = input.maxDegrees ?? 6;
    const topK = input.topK ?? 10;

    // 1. Embed the query
    const queryEmbedding = await this.embedder.embed(input.query);

    // 2. Find seed clusters via vector similarity
    const seeds = await this.storage.vectorSearch(queryEmbedding, this.seedTopK);

    if (seeds.length === 0) {
      return {
        clusters: [],
        query: input.query,
        degreesTraversed: 0,
        clustersConsidered: 0,
      };
    }

    const seedIds = seeds.map(s => s.id);

    // 3. Spread activation from seeds through the graph
    const activated = await this.storage.spreadActivation(seedIds, maxDegrees, topK * 3);

    // 4. Merge seeds into activated (seeds may not appear in spread results)
    const activatedIds = new Set(activated.map(a => a.id));
    const seedClusters: ActivatedCluster[] = seeds
      .filter(s => !activatedIds.has(s.id))
      .map(s => ({ ...s, activationScore: s.score * s.strength, distance: 0 }));

    const allActivated = [...seedClusters, ...activated];

    // 5. Domain filter if requested
    const filtered = input.domain
      ? allActivated.filter(c => c.domain === input.domain)
      : allActivated;

    // 6. Score, deduplicate, and rank
    const ranked = this.rankClusters(filtered).slice(0, topK);

    return {
      clusters: ranked,
      query: input.query,
      degreesTraversed: maxDegrees,
      clustersConsidered: allActivated.length,
    };
  }

  /**
   * Rank by activation score descending.
   * Deduplicate by cluster ID — keep highest score.
   */
  private rankClusters(clusters: ActivatedCluster[]): ActivatedCluster[] {
    const seen = new Map<string, ActivatedCluster>();

    for (const cluster of clusters) {
      const existing = seen.get(cluster.id);
      if (!existing || cluster.activationScore > existing.activationScore) {
        seen.set(cluster.id, cluster);
      }
    }

    return Array.from(seen.values())
      .sort((a, b) => b.activationScore - a.activationScore);
  }
}
