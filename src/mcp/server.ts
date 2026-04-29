/**
 * MLP MCP Server
 *
 * Exposes three tools over the Model Context Protocol:
 *   encode_memory      — knowledge enters MLP
 *   activate_memory    — query fires relevant clusters
 *   strengthen_connection — explicit Hebbian boost
 *
 * Receives injected Encoder, Activator, Consolidator — no storage details here.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { Encoder } from '../engine/encoder.js';
import type { Activator } from '../engine/activator.js';
import type { Consolidator } from '../engine/consolidator.js';
import type { StorageAdapter } from '../interfaces/StorageAdapter.js';

export interface MLPServerConfig {
  encoder: Encoder;
  activator: Activator;
  consolidator: Consolidator;
  storage: StorageAdapter;
  version?: string;
}

export function createMLPServer(config: MLPServerConfig): McpServer {
  const { encoder, activator, consolidator, storage } = config;
  const version = config.version ?? '0.1.0';

  const server = new McpServer({
    name: 'mlp-core',
    version,
  });

  // ── encode_memory ───────────────────────────────────────────────────────────

  server.tool(
    'encode_memory',
    'Encode knowledge into MLP. Stores a cluster with summary, intent, rationale, and connections. Use when you want MLP to remember a decision, context, or piece of organisational knowledge.',
    {
      content: z.string().describe(
        'The knowledge to encode. Can be free text, or structured with fields: summary:, intent:, rationale:, domain:, tags:'
      ),
      domain: z.string().optional().describe(
        'Domain hint — e.g. engineering, product, ops, finance. If omitted, inferred from content.'
      ),
      tags: z.array(z.string()).optional().describe(
        'Tags to attach. Encoder may add more based on content.'
      ),
      connectTo: z.array(z.string()).optional().describe(
        'Cluster IDs to explicitly connect this to. If omitted, connections are auto-detected via similarity.'
      ),
    },
    async ({ content, domain, tags, connectTo }) => {
      try {
        const result = await encoder.encode({ content, domain, tags, connectTo });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              clusterId: result.cluster.id,
              summary: result.cluster.summary,
              domain: result.cluster.domain,
              tags: result.cluster.tags,
              connectionsCreated: result.connectionsCreated,
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: message }) }],
          isError: true,
        };
      }
    }
  );

  // ── activate_memory ─────────────────────────────────────────────────────────

  server.tool(
    'activate_memory',
    'Query MLP. Fires a query that activates relevant clusters and spreads through connections. Returns ranked context — not just matching fragments, but connected intent and rationale.',
    {
      query: z.string().describe(
        'What you need to know. Natural language. E.g. "incident module task assignment workflow"'
      ),
      domain: z.string().optional().describe(
        'Narrow activation to a specific domain. Omit for cross-domain results.'
      ),
      maxDegrees: z.number().int().min(1).max(6).optional().describe(
        'How far activation spreads from seed clusters. Default 6 (Watts boundary).'
      ),
      topK: z.number().int().min(1).max(50).optional().describe(
        'Max clusters to return. Default 10.'
      ),
    },
    async ({ query, domain, maxDegrees, topK }) => {
      try {
        const result = await activator.activate({ query, domain, maxDegrees, topK });

        // Record co-activations for Hebbian consolidation
        if (result.clusters.length > 1) {
          consolidator.recordCoActivation(result.clusters.map(c => c.id));
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              query: result.query,
              clustersReturned: result.clusters.length,
              clustersConsidered: result.clustersConsidered,
              degreesTraversed: result.degreesTraversed,
              clusters: result.clusters.map(c => ({
                id: c.id,
                summary: c.summary,
                intent: c.intent,
                rationale: c.rationale,
                domain: c.domain,
                tags: c.tags,
                activationScore: Math.round(c.activationScore * 1000) / 1000,
                distance: c.distance,
              })),
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: message }) }],
          isError: true,
        };
      }
    }
  );

  // ── strengthen_connection ───────────────────────────────────────────────────

  server.tool(
    'strengthen_connection',
    'Explicitly strengthen the connection between two clusters. Use when a co-activation was particularly valuable and should be reinforced immediately rather than waiting for background consolidation.',
    {
      fromId: z.string().describe('ID of the source cluster'),
      toId: z.string().describe('ID of the target cluster'),
      delta: z.number().min(0.01).max(1.0).optional().describe(
        'How much to strengthen the connection weight. Default 0.2.'
      ),
    },
    async ({ fromId, toId, delta = 0.2 }) => {
      try {
        await storage.strengthenConnection(fromId, toId, delta);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              fromId,
              toId,
              delta,
              message: `Connection strengthened by ${delta}`,
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: message }) }],
          isError: true,
        };
      }
    }
  );

  return server;
}

/**
 * Start the MCP server over stdio transport.
 * This is how Claude Code, Cursor, and any MCP-compatible tool connects.
 */
export async function startMLPServer(config: MLPServerConfig): Promise<void> {
  const server = createMLPServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MLP] Server running on stdio transport');
}
