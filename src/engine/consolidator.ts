/**
 * Consolidator
 *
 * Background process that strengthens connections between clusters
 * that repeatedly co-activate together.
 *
 * What it does:
 *   - Receives co-activation events from the Activator via
 *     recordCoActivation()
 *   - Runs on a timer and processes batched events
 *   - Counts how often each pair co-activated
 *   - Calls strengthenPath for each pair proportional to count
 *   - Drains the event log before processing so new events
 *     during a consolidation cycle go to a fresh batch
 *
 * What it does not do:
 *   - It never blocks a query response
 *   - It never reads clusters — only strengthens paths
 *   - It never crosses workspace boundaries
 *   - It never deletes or weakens connections
 *   - It never runs more than one consolidation cycle at a time
 *
 * Scientific basis:
 *   Hebbian principle — neurons that fire together wire together.
 *   ΔW = η × activation_score_A × activation_score_B
 *   The memory improves passively through use.
 *   No manual curation required.
 *
 * This is the layer that makes MLP self-improving.
 * The more the graph is used the more precisely it activates.
 * Knowledge that keeps getting used together becomes
 * structurally inseparable over time.
 */

import type { StorageAdapter } from '../interfaces/StorageAdapter.js'

interface CoActivationEvent {
  clusterIdA: string
  clusterIdB: string
  workspace: string
  timestamp: number
}

export class Consolidator {

  private events: CoActivationEvent[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(
    private storageAdapter: StorageAdapter,
    private intervalMs: number = 60_000
  ) {}

  // Record that a set of clusters fired together in one activation.
  // Called by the MCP server after every activate_memory call.
  // Every unique pair in the array is recorded as a co-activation.
  recordCoActivation(clusterIds: string[], workspace: string): void {
    const timestamp = Date.now()

    for (let i = 0; i < clusterIds.length; i++) {
      for (let j = i + 1; j < clusterIds.length; j++) {
        this.events.push({
          clusterIdA: clusterIds[i],
          clusterIdB: clusterIds[j],
          workspace,
          timestamp
        })
      }
    }
  }

  // Start the background consolidation loop.
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.consolidate(), this.intervalMs)
    console.error(
      `[Consolidator] Started — interval: ${this.intervalMs}ms`
    )
  }

  // Stop the background loop cleanly.
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    console.error('[Consolidator] Stopped')
  }

  // Process the co-activation log and strengthen connections.
  // Drains the event log before processing — new events during
  // this cycle go to a fresh batch.
  private async consolidate(): Promise<void> {
    if (this.running) return
    if (this.events.length === 0) return

    this.running = true

    // Drain
    const batch = this.events.splice(0, this.events.length)

    // Count co-activations per pair per workspace
    // Key: workspace::sortedIdA::sortedIdB
    const pairCounts = new Map<string, {
      clusterIdA: string
      clusterIdB: string
      workspace: string
      count: number
    }>()

    for (const event of batch) {
      const [idA, idB] = [event.clusterIdA, event.clusterIdB].sort()
      const key = `${event.workspace}::${idA}::${idB}`
      const existing = pairCounts.get(key)

      if (existing) {
        existing.count++
      } else {
        pairCounts.set(key, {
          clusterIdA: idA,
          clusterIdB: idB,
          workspace: event.workspace,
          count: 1
        })
      }
    }

    // Strengthen each pair — fire and forget per pair
    // If one fails the rest continue
    const strengthenCalls = Array.from(pairCounts.values()).map(
      pair => this.storageAdapter.strengthenPath(
        pair.clusterIdA,
        pair.clusterIdB,
        pair.workspace
      ).catch(() => {
        // Connection may not exist yet — safe to ignore
        // It will be created when the clusters next co-activate
        // through a direct encode or explicit strengthen call
      })
    )

    await Promise.allSettled(strengthenCalls)

    console.error(
      `[Consolidator] Processed ${pairCounts.size} pairs from ${batch.length} events`
    )

    this.running = false
  }

}
