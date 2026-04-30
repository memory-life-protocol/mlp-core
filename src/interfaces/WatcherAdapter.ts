import type { WatcherSignal } from './types.js'

// A watcher monitors an external source and emits signals
// when it detects knowledge worth encoding or corroborating.
//
// Sources: GitHub repo, Slack, Claude conversations,
// test suites, Notion, any tool that produces knowledge.
//
// The watcher never touches the graph directly.
// It emits WatcherSignals. The encoder processes them.
// The protocol stays clean. The connector stays specific.

interface WatcherAdapter {

  // Unique identifier for this watcher instance.
  // Example: 'github-watcher-org-repo'
  readonly watcherId: string

  // What type of source this watcher monitors.
  readonly watcherType: 'github' | 'slack' | 'claude' |
                        'notion' | 'test' | 'manual'

  // Which workspace this watcher is scoped to.
  // A watcher can only emit signals for its own workspace.
  // Never crosses workspace boundary.
  readonly workspace: string

  // Start watching the source.
  // Called once when the MLP server starts.
  // Must not block — run async in background.
  start(): Promise<void>

  // Stop watching cleanly.
  // Called on server shutdown.
  stop(): Promise<void>

  // Register a handler that receives signals as they are detected.
  // The protocol calls this to wire the watcher into the encoder.
  // Only one handler per watcher instance.
  onSignal(handler: (signal: WatcherSignal) => Promise<void>): void

  // Human readable name for this watcher — used in logs.
  // Example: 'GitHub Watcher — memory-life-protocol/mlp-core'
  readonly name: string

}

export type { WatcherAdapter }
