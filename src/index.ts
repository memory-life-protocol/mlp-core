/**
 * MLP Core — Entry Point
 *
 * Wires together:
 *   StorageAdapter   (injected — default: in-memory for dev)
 *   EmbeddingAdapter (injected — default: hash-based stub for dev)
 *   Encoder + Activator + Consolidator
 *   MCP Server
 *
 * To use a real storage backend:
 *   import { FalkorDBAdapter } from './adapters/falkordb.js'
 *   and pass it here. Nothing else changes.
 */

import 'dotenv/config';
import { Encoder } from './engine/encoder.js';
import { Activator } from './engine/activator.js';
import { Consolidator } from './engine/consolidator.js';
import { startMLPServer } from './mcp/server.js';
import { InMemoryAdapter } from './adapters/memory.js';
import { StubEmbeddingAdapter } from './adapters/stub-embedder.js';

async function main() {
  console.error('[MLP] Starting Memory Life Protocol...');

  // ── Adapters ────────────────────────────────────────────────────────────────
  // Swap these out for real implementations without touching anything else.

  const storage = new InMemoryAdapter();
  await storage.connect();

  const embedder = new StubEmbeddingAdapter();

  // ── Engine ──────────────────────────────────────────────────────────────────

  const encoder = new Encoder({ storage, embedder });
  const activator = new Activator({ storage, embedder });
  const consolidator = new Consolidator(storage, 60_000);

  consolidator.start();

  // ── MCP Server ──────────────────────────────────────────────────────────────

  await startMLPServer({ encoder, activator, consolidator, storage });

  // ── Shutdown ─────────────────────────────────────────────────────────────────

  process.on('SIGINT', async () => {
    consolidator.stop();
    await storage.disconnect();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[MLP] Fatal error:', err);
  process.exit(1);
});
