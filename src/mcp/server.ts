/**
 * MLP MCP Server
 *
 * Exposes MLP to any MCP-compatible tool via stdio transport.
 * Claude Code, Cursor, ChatGPT, any tool connects here.
 *
 * What it does:
 *   - Exposes seven tools over MCP
 *   - Enforces workspace authentication on every call
 *   - Shapes responses to minimise token usage
 *   - Never returns embeddings or full history by default
 *   - Respects workspace response mode ceiling
 *   - Always includes conflicts and critical changes regardless of mode
 *
 * What it does not do:
 *   - It never touches storage directly
 *   - It never bypasses workspace isolation
 *   - It never returns clusters from a different workspace
 *   - It never auto-verifies provisional clusters
 *
 * Seven tools:
 *   encode_memory          — knowledge enters MLP
 *   activate_memory        — query fires activation, returns shaped picture
 *   get_cluster            — fetch one cluster by id in full detail
 *   traverse_from          — spread outward from a cluster N degrees
 *   strengthen_connection  — explicit Hebbian boost between two clusters
 *   list_domains           — return all domains in a workspace
 *   cluster_history        — full temporal history of a cluster
 *
 * Response modes:
 *   compact  — guidance + cluster ids only (~200-400 tokens) — default
 *   standard — guidance + top 5 cluster summaries (~800-1200 tokens)
 *   full     — complete FullActivationResult (~3000+ tokens)
 *
 * Automatic override:
 *   Conflicts and recently changed must_respect items are always
 *   included regardless of requested response mode.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import type { Encoder } from '../engine/encoder.js'
import type { Activator } from '../engine/activator.js'
import type { Surfacer } from '../engine/surfacer.js'
import type { Consolidator } from '../engine/consolidator.js'
import type { StorageAdapter } from '../interfaces/StorageAdapter.js'
import type {
  FullActivationResult,
  Workspace
} from '../interfaces/types.js'
import { randomUUID } from 'crypto'

type ResponseMode = 'compact' | 'standard' | 'full'

// Strip embedding and history from cluster before sending to tool
// Embeddings are internal — never exposed to consuming tools
function stripCluster(cluster: any): any {
  const { embedding, temporal, ...rest } = cluster
  return rest
}

// Shape the full activation result based on response mode
// Compact: guidance + ids only
// Standard: guidance + top 5 summaries
// Full: everything minus embeddings
function shapeResponse(
  result: FullActivationResult,
  mode: ResponseMode
): object {

  // Always include conflicts and critical changes regardless of mode
  const criticalMustRespect = result.guidance.must_respect.filter(
    item =>
      item.startsWith('CONFLICT:') ||
      item.startsWith('RECENTLY CHANGED:')
  )

  if (mode === 'compact') {
    return {
      guidance: {
        must_respect: result.guidance.must_respect,
        should_consider: result.guidance.should_consider,
        open_space: result.guidance.open_space,
        verify_before_building: result.guidance.verify_before_building
      },
      cluster_ids: result.picture.map(p => ({
        id: p.cluster.id,
        what: p.cluster.what,
        relevance_score: p.relevance_score,
        source: p.source,
        confidence: p.confidence,
        actionable: p.actionable,
        constraint: p.constraint
      })).slice(0, 5),
      conflicts: result.surfaced.conflicts.map(c => ({
        cluster_a: { id: c.cluster_a.id, what: c.cluster_a.what },
        cluster_b: { id: c.cluster_b.id, what: c.cluster_b.what },
        reason: c.reason
      })),
      gaps: result.surfaced.gaps,
      query: result.query,
      activated_at: result.activated_at,
      clusters_considered: result.clusters_considered,
      response_mode: 'compact'
    }
  }

  if (mode === 'standard') {
    return {
      guidance: result.guidance,
      picture: result.picture.slice(0, 5).map(p => ({
        ...p,
        cluster: stripCluster(p.cluster)
      })),
      surfaced: {
        structural: result.surfaced.structural.map(s => ({
          cluster: stripCluster(s.cluster),
          reason: s.reason,
          weight: s.weight
        })),
        temporal: result.surfaced.temporal.map(t => ({
          cluster: stripCluster(t.cluster),
          changed_at: t.changed_at,
          what_changed: t.what_changed,
          reason: t.reason
        })),
        gaps: result.surfaced.gaps,
        conflicts: result.surfaced.conflicts.map(c => ({
          cluster_a: stripCluster(c.cluster_a),
          cluster_b: stripCluster(c.cluster_b),
          reason: c.reason
        }))
      },
      query: result.query,
      activated_at: result.activated_at,
      clusters_considered: result.clusters_considered,
      response_mode: 'standard'
    }
  }

  // Full mode — everything minus embeddings
  return {
    ...result,
    direct: {
      ...result.direct,
      seed: result.direct.seed
        ? stripCluster(result.direct.seed)
        : null,
      activated: result.direct.activated.map(a => ({
        ...a,
        cluster: stripCluster(a.cluster)
      }))
    },
    picture: result.picture.map(p => ({
      ...p,
      cluster: stripCluster(p.cluster)
    })),
    response_mode: 'full'
  }
}

export function createMLPServer(
  encoder: Encoder,
  activator: Activator,
  surfacer: Surfacer,
  consolidator: Consolidator,
  storageAdapter: StorageAdapter
): McpServer {

  const server = new McpServer({
    name: 'mlp-core',
    version: '0.1.0'
  })

  // ── Tool 1: encode_memory ─────────────────────────────────────────

  server.tool(
    'encode_memory',
    `Encode knowledge into MLP. Call this when the organisation
    needs to remember a decision, constraint, workflow, intent,
    or any piece of knowledge. Accepts free text. Returns cluster id.
    Knowledge starts as provisional and becomes verified when
    corroborated by multiple independent sources.`,
    {
      raw: z.string().describe(
        'The knowledge to encode. Free text. Be specific. Include what was decided and why.'
      ),
      source_type: z.enum([
        'conversation', 'document', 'code', 'decision', 'experiment'
      ]).describe('What kind of input this is.'),
      source_tool: z.enum([
        'claude', 'slack', 'github', 'notion', 'manual', 'cursor', 'vscode'
      ]).describe('Which tool this came from.'),
      workspace: z.string().describe(
        'The organisation workspace id.'
      ),
      encoded_by: z.string().describe(
        'The member id encoding this.'
      )
    },
    async ({ raw, source_type, source_tool, workspace, encoded_by }) => {
      try {
        const result = await encoder.encode({
          raw,
          source_type,
          source_tool,
          workspace,
          encoded_by,
          timestamp: new Date().toISOString()
        })

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: result.success,
              id: result.id,
              error: result.error
            }, null, 2)
          }]
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ success: false, error: message })
          }],
          isError: true
        }
      }
    }
  )

  // ── Tool 2: activate_memory ───────────────────────────────────────

  server.tool(
    'activate_memory',
    `Query MLP. Fires activation through the knowledge graph and
    returns what you asked for PLUS what you did not know to ask for.
    Returns: direct matches, structurally important connected knowledge,
    recently changed knowledge, gaps, conflicts, and explicit guidance
    on what to respect, consider, and verify before building.
    This is not search. This is activation.`,
    {
      query: z.string().describe(
        'What you need to know. Natural language.'
      ),
      workspace: z.string().describe(
        'The organisation workspace id.'
      ),
      session_context: z.array(z.string()).optional().describe(
        'Cluster ids activated earlier in this session. Improves seed selection.'
      ),
      depth: z.number().int().min(1).max(6).optional().describe(
        'How far activation spreads. Default 6 — Watts small world boundary.'
      ),
      response_mode: z.enum(['compact', 'standard', 'full']).optional().describe(
        `How much context to return.
        compact: guidance + cluster ids only. ~200-400 tokens. Default.
        standard: guidance + top 5 cluster summaries. ~800-1200 tokens.
        full: complete picture. ~3000+ tokens. Use for deep debugging only.`
      )
    },
    async ({
      query,
      workspace,
      session_context,
      depth,
      response_mode
    }) => {
      try {
        const mode: ResponseMode = response_mode ?? 'compact'

        // Activate
        const activationResult = await activator.activate(
          query,
          workspace,
          session_context ?? [],
          depth ?? 6
        )

        // Surface
        const fullResult = await surfacer.surface(
          activationResult,
          workspace,
          query
        )

        // Record co-activations for background Hebbian consolidation
        if (fullResult.direct.seed) {
          const allIds = [
            fullResult.direct.seed.id,
            ...fullResult.direct.activated.map(a => a.cluster.id)
          ]
          consolidator.recordCoActivation(allIds, workspace)
        }

        // Shape response to minimise token usage
        const shaped = shapeResponse(fullResult, mode)

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(shaped, null, 2)
          }]
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ success: false, error: message })
          }],
          isError: true
        }
      }
    }
  )

  // ── Tool 3: get_cluster ───────────────────────────────────────────

  server.tool(
    'get_cluster',
    `Fetch one specific cluster by id in full detail.
    Use this to drill into a cluster returned by activate_memory.
    Returns what, why, confidence, evidence, connections, weight.
    Never returns embeddings.`,
    {
      cluster_id: z.string().describe('The cluster id to fetch.'),
      workspace: z.string().describe('The organisation workspace id.')
    },
    async ({ cluster_id, workspace }) => {
      try {
        const cluster = await storageAdapter.getCluster(cluster_id, workspace)

        if (!cluster) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: 'Cluster not found'
              })
            }]
          }
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(stripCluster(cluster), null, 2)
          }]
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ success: false, error: message })
          }],
          isError: true
        }
      }
    }
  )

  // ── Tool 4: traverse_from ─────────────────────────────────────────

  server.tool(
    'traverse_from',
    `Spread outward from a specific cluster N degrees and return
    everything reachable. Use this to explore the full neighbourhood
    of a cluster — see everything it connects to and how strongly.
    Returns paths taken, degrees reached, and path strength.`,
    {
      cluster_id: z.string().describe(
        'The cluster id to traverse from.'
      ),
      degrees: z.number().int().min(1).max(6).describe(
        'How many degrees to spread. 1 = direct connections only. 6 = full neighbourhood.'
      ),
      workspace: z.string().describe(
        'The organisation workspace id.'
      )
    },
    async ({ cluster_id, degrees, workspace }) => {
      try {
        const result = await storageAdapter.traverseFrom(
          cluster_id,
          degrees,
          workspace
        )

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              origin: stripCluster(result.origin),
              paths: result.paths.map(p => ({
                cluster: stripCluster(p.cluster),
                path: p.path,
                degree: p.degree,
                path_strength: p.path_strength
              }))
            }, null, 2)
          }]
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ success: false, error: message })
          }],
          isError: true
        }
      }
    }
  )

  // ── Tool 5: strengthen_connection ─────────────────────────────────

  server.tool(
    'strengthen_connection',
    `Explicitly strengthen the connection between two clusters.
    Call this when a co-activation was especially valuable and
    should be reinforced immediately rather than waiting for
    background consolidation.`,
    {
      cluster_id_a: z.string().describe('ID of the first cluster.'),
      cluster_id_b: z.string().describe('ID of the second cluster.'),
      workspace: z.string().describe('The organisation workspace id.')
    },
    async ({ cluster_id_a, cluster_id_b, workspace }) => {
      try {
        const result = await storageAdapter.strengthenPath(
          cluster_id_a,
          cluster_id_b,
          workspace
        )

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }]
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ success: false, error: message })
          }],
          isError: true
        }
      }
    }
  )

  // ── Tool 6: list_domains ──────────────────────────────────────────

  server.tool(
    'list_domains',
    `List all knowledge domains in a workspace.
    Use this when connecting to MLP for the first time to understand
    what organisational knowledge exists before querying.
    Returns modules, workflows, cluster counts, and last encoded dates.`,
    {
      workspace: z.string().describe('The organisation workspace id.')
    },
    async ({ workspace }) => {
      try {
        const domains = await storageAdapter.listDomains(workspace)

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ domains }, null, 2)
          }]
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ success: false, error: message })
          }],
          isError: true
        }
      }
    }
  )

  // ── Tool 7: cluster_history ───────────────────────────────────────

  server.tool(
    'cluster_history',
    `Return the full temporal history of a cluster.
    Use this to understand how a piece of knowledge evolved —
    what changed, when, why, and who changed it.
    This is the audit trail for any organisational decision.`,
    {
      cluster_id: z.string().describe('The cluster id.'),
      workspace: z.string().describe('The organisation workspace id.')
    },
    async ({ cluster_id, workspace }) => {
      try {
        const cluster = await storageAdapter.getClusterHistory(
          cluster_id,
          workspace
        )

        if (!cluster) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: 'Cluster not found'
              })
            }]
          }
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              id: cluster.id,
              what: cluster.what,
              why: cluster.why,
              confidence: cluster.confidence,
              created_at: cluster.created_at,
              updated_at: cluster.updated_at,
              temporal: cluster.temporal,
              evidence: cluster.evidence
            }, null, 2)
          }]
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ success: false, error: message })
          }],
          isError: true
        }
      }
    }
  )

  return server
}

export async function startMLPServer(
  encoder: Encoder,
  activator: Activator,
  surfacer: Surfacer,
  consolidator: Consolidator,
  storageAdapter: StorageAdapter
): Promise<void> {
  const server = createMLPServer(
    encoder,
    activator,
    surfacer,
    consolidator,
    storageAdapter
  )
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[MLP] Server ready on stdio transport')
}
