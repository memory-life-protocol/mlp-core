/**
 * Consolidator
 *
 * Runs in the background. Strengthens connections between clusters
 * that are frequently co-activated together.
 *
 * This is the Hebbian layer: "neurons that fire together, wire together."
 * The more two clusters appear together in activation results,
 * the stronger their connection becomes — making future activations
 * surface them faster and with higher scores.
 *
 * In v1 this is lightweight: it processes a co-activation log
 * and updates connection weights. No external dependencies.
 */

import type { StorageAdapter } from '../interfaces/StorageAdapter.js';

interface CoActivationEvent {
  clusterId1: string;
  clusterId2: string;
  timestamp: number;
}

export class Consolidator {
  private storage: StorageAdapter;
  private coActivationLog: CoActivationEvent[] = [];
  private intervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(storage: StorageAdapter, intervalMs = 60_000) {
    this.storage = storage;
    this.intervalMs = intervalMs;
  }

  /**
   * Record that two clusters appeared together in an activation result.
   * Called by the Activator after each successful activation.
   */
  recordCoActivation(clusterIds: string[]): void {
    const now = Date.now();

    // Record every pair in this activation as co-activated
    for (let i = 0; i < clusterIds.length; i++) {
      for (let j = i + 1; j < clusterIds.length; j++) {
        this.coActivationLog.push({
          clusterId1: clusterIds[i],
          clusterId2: clusterIds[j],
          timestamp: now,
        });
      }
    }
  }

  /**
   * Start background consolidation loop.
   */
  start(): void {
    this.timer = setInterval(() => this.consolidate(), this.intervalMs);
    console.log(`[Consolidator] Started — running every ${this.intervalMs / 1000}s`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Process the co-activation log and strengthen connections.
   * Counts co-activations per pair and applies Hebbian delta.
   */
  private async consolidate(): Promise<void> {
    if (this.coActivationLog.length === 0) return;

    const batch = [...this.coActivationLog];
    this.coActivationLog = [];

    // Count co-activations per pair
    const pairCounts = new Map<string, number>();

    for (const event of batch) {
      const key = [event.clusterId1, event.clusterId2].sort().join('::');
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    }

    // Strengthen each pair proportionally
    let strengthened = 0;
    for (const [key, count] of pairCounts) {
      const [id1, id2] = key.split('::');
      const delta = count * 0.05; // 0.05 per co-activation

      try {
        await this.storage.strengthenConnection(id1, id2, delta);
        await this.storage.strengthenConnection(id2, id1, delta);
        strengthened++;
      } catch {
        // Connection may not exist yet — that's fine, skip it
      }
    }

    if (strengthened > 0) {
      console.log(`[Consolidator] Strengthened ${strengthened} connection pairs`);
    }
  }
}
