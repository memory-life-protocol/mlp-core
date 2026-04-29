/**
 * InMemoryAdapter
 *
 * A complete StorageAdapter implementation backed by plain Maps.
 * No database. No dependencies. Used for:
 *   - Local development
 *   - Testing
 *   - Demonstrating MLP behaviour before wiring a real backend
 *
 * Activation spreading uses BFS with weight-product scoring.
 * This is the same algorithm a graph DB would execute — just in process.
 */

import type { StorageAdapter } from '../interfaces/StorageAdapter.js';
import type { Cluster, Connection, ActivatedCluster } from '../interfaces/types.js';

export class InMemoryAdapter implements StorageAdapter {
  private clusters = new Map<string, Cluster>();
  private connections = new Map<string, Connection>(); // key: `${fromId}::${toId}`
  private adjacency = new Map<string, string[]>(); // fromId → [toId, ...]

  async connect(): Promise<void> {
    console.error('[InMemoryAdapter] Ready');
  }

  async disconnect(): Promise<void> {
    this.clusters.clear();
    this.connections.clear();
    this.adjacency.clear();
  }

  async storeCluster(cluster: Cluster): Promise<string> {
    this.clusters.set(cluster.id, { ...cluster });
    return cluster.id;
  }

  async getCluster(id: string): Promise<Cluster | null> {
    return this.clusters.get(id) ?? null;
  }

  async vectorSearch(
    embedding: number[],
    topK: number
  ): Promise<Array<Cluster & { score: number }>> {
    const results: Array<Cluster & { score: number }> = [];

    for (const cluster of this.clusters.values()) {
      if (!cluster.embedding) continue;
      const score = cosineSimilarity(embedding, cluster.embedding);
      results.push({ ...cluster, score });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async storeConnection(connection: Connection): Promise<void> {
    const key = `${connection.fromId}::${connection.toId}`;
    const existing = this.connections.get(key);

    if (existing) {
      existing.weight += 0.1;
      existing.activations += 1;
    } else {
      this.connections.set(key, { ...connection });
      const neighbours = this.adjacency.get(connection.fromId) ?? [];
      neighbours.push(connection.toId);
      this.adjacency.set(connection.fromId, neighbours);
    }
  }

  async strengthenConnection(fromId: string, toId: string, delta: number): Promise<void> {
    const key = `${fromId}::${toId}`;
    const conn = this.connections.get(key);
    if (conn) {
      conn.weight += delta;
      conn.activations += 1;
    }
  }

  async spreadActivation(
    seedIds: string[],
    maxDegrees: number,
    topK: number
  ): Promise<ActivatedCluster[]> {
    // BFS with weight-product scoring.
    // Each node carries: { clusterId, score, distance }
    // score = product of edge weights along the path
    const visited = new Map<string, { score: number; distance: number }>();
    const queue: Array<{ id: string; score: number; distance: number }> = [];

    for (const seedId of seedIds) {
      if (!this.clusters.has(seedId)) continue;
      queue.push({ id: seedId, score: 1.0, distance: 0 });
      visited.set(seedId, { score: 1.0, distance: 0 });
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.distance >= maxDegrees) continue;

      const neighbours = this.adjacency.get(current.id) ?? [];

      for (const neighbourId of neighbours) {
        const connKey = `${current.id}::${neighbourId}`;
        const conn = this.connections.get(connKey);
        if (!conn) continue;

        const newScore = current.score * conn.weight;
        const existing = visited.get(neighbourId);

        if (!existing || newScore > existing.score) {
          visited.set(neighbourId, { score: newScore, distance: current.distance + 1 });
          queue.push({ id: neighbourId, score: newScore, distance: current.distance + 1 });
        }
      }
    }

    // Build result — exclude seeds (distance 0), they're handled by Activator
    const results: ActivatedCluster[] = [];

    for (const [id, { score, distance }] of visited) {
      if (distance === 0) continue;
      const cluster = this.clusters.get(id);
      if (!cluster) continue;

      results.push({
        ...cluster,
        activationScore: score * cluster.strength,
        distance,
      });
    }

    return results
      .sort((a, b) => b.activationScore - a.activationScore)
      .slice(0, topK);
  }
}

// ── Cosine Similarity ──────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
