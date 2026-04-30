/**
 * MLP Core — Entry Point
 *
 * Wires together:
 *   StorageAdapter    — injected, swappable
 *   EmbeddingAdapter  — injected, swappable
 *   ExtractionAdapter — injected, swappable
 *   WatcherAdapters   — injected, zero or many
 *   Encoder + Activator + Surfacer + Consolidator
 *   MCP Server
 *
 * In development:
 *   Uses InMemoryAdapter + StubEmbeddingAdapter + StubExtractionAdapter
 *   No external dependencies required
 *   Server starts immediately
 *
 * In production:
 *   Uses FalkorDBAdapter + AnthropicEmbeddingAdapter + AnthropicExtractionAdapter
 *   Reads all config from environment variables
 *   Watchers start automatically after server is ready
 *
 * To swap any adapter:
 *   Import a different implementation of the interface
 *   Pass it to the constructor
 *   Nothing else changes
 *
 * Environment variables required in production:
 *   ANTHROPIC_API_KEY     — for embedding and extraction
 *   FALKORDB_HOST         — FalkorDB host
 *   FALKORDB_PORT         — FalkorDB port
 *   MLP_ENV               — 'production' or 'development'
 *   MLP_PORT              — port for health check endpoint
 */

import 'dotenv/config'
import { Encoder } from './engine/encoder.js'
import { Activator } from './engine/activator.js'
import { Surfacer } from './engine/surfacer.js'
import { Consolidator } from './engine/consolidator.js'
import { startMLPServer } from './mcp/server.js'
import { InMemoryAdapter } from './adapters/memory.js'
import { StubEmbeddingAdapter } from './adapters/stub-embedder.js'
import { StubExtractionAdapter } from './adapters/stub-extractor.js'
import type { StorageAdapter } from './interfaces/StorageAdapter.js'
import type { EmbeddingAdapter } from './interfaces/EmbeddingAdapter.js'
import type { ExtractionAdapter } from './interfaces/ExtractionAdapter.js'
import type { WatcherAdapter } from './interfaces/WatcherAdapter.js'

const IS_PRODUCTION = process.env.MLP_ENV === 'production'

async function buildAdapters(): Promise<{
  storage: StorageAdapter
  embedder: EmbeddingAdapter
  extractor: ExtractionAdapter
}> {
  if (IS_PRODUCTION) {
    // Production connectors — paths as variables prevent TypeScript from
    // following these imports at compile time. Connectors live outside rootDir.
    const falkordbPath = '../connectors/falkordb/adapter.js'
    const anthropicEmbedderPath = '../connectors/anthropic/embedder.js'
    const anthropicExtractorPath = '../connectors/anthropic/extractor.js'

    const { FalkorDBAdapter } = await import(falkordbPath)
    const { AnthropicEmbeddingAdapter } = await import(anthropicEmbedderPath)
    const { AnthropicExtractionAdapter } = await import(anthropicExtractorPath)

    const storage = new FalkorDBAdapter({
      host: process.env.FALKORDB_HOST ?? 'localhost',
      port: parseInt(process.env.FALKORDB_PORT ?? '6379')
    })

    const embedder = new AnthropicEmbeddingAdapter({
      apiKey: process.env.ANTHROPIC_API_KEY ?? ''
    })

    const extractor = new AnthropicExtractionAdapter({
      apiKey: process.env.ANTHROPIC_API_KEY ?? ''
    })

    return { storage, embedder, extractor }
  }

  // Development adapters — zero external dependencies
  const storage = new InMemoryAdapter()
  const embedder = new StubEmbeddingAdapter()
  const extractor = new StubExtractionAdapter()

  return { storage, embedder, extractor }
}

async function startWatchers(
  watchers: WatcherAdapter[],
  encoder: Encoder
): Promise<void> {
  for (const watcher of watchers) {
    watcher.onSignal(async signal => {
      await encoder.processWatcherSignal(signal)
    })
    await watcher.start()
    console.error(`[MLP] Watcher started: ${watcher.name}`)
  }
}

async function main(): Promise<void> {
  console.error(`[MLP] Starting Memory Life Protocol...`)
  console.error(`[MLP] Environment: ${IS_PRODUCTION ? 'production' : 'development'}`)

  // Build adapters
  const { storage, embedder, extractor } = await buildAdapters()

  // Connect storage
  await storage.connect()
  console.error('[MLP] Storage connected')

  // Build engine
  const encoder = new Encoder(storage, embedder, extractor)
  const activator = new Activator(storage, embedder)
  const surfacer = new Surfacer(storage)
  const consolidator = new Consolidator(storage)

  // Start background consolidation
  consolidator.start()

  // Start watchers — empty by default
  // Connector packages register watchers here
  const watchers: WatcherAdapter[] = []
  await startWatchers(watchers, encoder)

  // Start MCP server
  await startMLPServer(encoder, activator, surfacer, consolidator, storage)

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.error(`[MLP] ${signal} received — shutting down`)
    consolidator.stop()

    for (const watcher of watchers) {
      await watcher.stop()
    }

    await storage.disconnect()
    console.error('[MLP] Shutdown complete')
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch(err => {
  console.error('[MLP] Fatal error:', err)
  process.exit(1)
})
