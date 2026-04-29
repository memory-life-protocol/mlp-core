import type { StorageAdapter } from '../interfaces/StorageAdapter.js'

interface CoActivationEvent {
  clusterIdA: string
  clusterIdB: string
  timestamp: number
}

export class Consolidator {
  private storageAdapter: StorageAdapter
  private intervalMs: number
  private events: CoActivationEvent[] = []
  private timer: NodeJS.Timeout | null = null

  constructor(storageAdapter: StorageAdapter, intervalMs = 60_000) {
    this.storageAdapter = storageAdapter
    this.intervalMs = intervalMs
  }

  recordCoActivation(clusterIds: string[]): void {
    const timestamp = Date.now()
    for (let i = 0; i < clusterIds.length; i++) {
      for (let j = i + 1; j < clusterIds.length; j++) {
        this.events.push({ clusterIdA: clusterIds[i], clusterIdB: clusterIds[j], timestamp })
      }
    }
  }

  start(): void {
    this.timer = setInterval(() => this.consolidate(), this.intervalMs)
    console.log(`[Consolidator] Started — interval: ${this.intervalMs}ms`)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    console.log('[Consolidator] Stopped')
  }

  private consolidate(): void {
    if (this.events.length === 0) return

    const batch = this.events
    this.events = []

    const pairCounts = new Map<string, { idA: string; idB: string; count: number }>()

    for (const event of batch) {
      const [idA, idB] = [event.clusterIdA, event.clusterIdB].sort()
      const key = `${idA}::${idB}`
      const existing = pairCounts.get(key)
      if (existing) {
        existing.count++
      } else {
        pairCounts.set(key, { idA, idB, count: 1 })
      }
    }

    for (const { idA, idB } of pairCounts.values()) {
      Promise.allSettled([this.storageAdapter.strengthenPath(idA, idB)])
    }

    console.log(`[Consolidator] Processed ${pairCounts.size} pairs from ${batch.length} events`)
  }
}
