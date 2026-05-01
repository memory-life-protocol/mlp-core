/**
 * HTTP/SSE Transport for MLP
 *
 * Exposes MLP tools over two transports on the same port:
 *
 * REST API (browser-friendly, stateless):
 *   POST /api/encode    — encode a memory signal
 *   POST /api/activate  — activate and surface memory
 *   GET  /api/domains   — list domains in workspace
 *   GET  /api/stats     — workspace stats
 *
 * MCP Transport (MCP-compatible clients):
 *   POST /mcp           — MCP message endpoint
 *   GET  /mcp           — SSE stream endpoint
 *
 * Shared:
 *   GET  /health        — health check
 *
 * Authentication:
 *   Every request must include a workspace API key:
 *   Authorization: Bearer workspaceId:apiKey
 *
 *   The key is validated against the workspace.
 *   All calls are scoped to that workspace only.
 *   Requests without a valid key are rejected with 401.
 *
 * Sessions (MCP only):
 *   The MCP protocol requires a multi-step handshake before tools
 *   can be called. Sessions are keyed by Mcp-Session-Id header.
 *   The first request (initialize) creates a session. Subsequent
 *   requests reuse the same transport instance for that session.
 *
 * What it does not do:
 *   It never bypasses workspace isolation.
 *   It never exposes clusters from other workspaces.
 *   It never accepts unauthenticated requests.
 */

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer, type IncomingMessage } from 'node:http'
import { randomUUID, createHash } from 'node:crypto'
import type { StorageAdapter } from '../interfaces/StorageAdapter.js'
import type { Encoder } from '../engine/encoder.js'
import type { Activator } from '../engine/activator.js'
import type { Surfacer } from '../engine/surfacer.js'

export interface HTTPTransportConfig {
  port: number
  storage: StorageAdapter
  encoder: Encoder
  activator: Activator
  surfacer: Surfacer
  createMLPServer: (workspaceId: string) => any
  version: string
}

interface Session {
  transport: StreamableHTTPServerTransport
  workspaceId: string
}

interface AuthResult {
  valid: boolean
  workspaceId: string | null
  error?: string
}

async function validateRequest(
  req: IncomingMessage,
  storage: StorageAdapter
): Promise<AuthResult> {
  const authHeader = req.headers['authorization']
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { valid: false, workspaceId: null, error: 'Missing Authorization header' }
  }

  const token = authHeader.slice(7).trim()
  const colonIndex = token.indexOf(':')
  if (colonIndex === -1) {
    return { valid: false, workspaceId: null, error: 'Invalid token format. Use workspaceId:apiKey' }
  }

  const workspaceId = token.slice(0, colonIndex)
  const apiKey = token.slice(colonIndex + 1)

  const workspace = await storage.getWorkspace(workspaceId)
  if (!workspace) {
    return { valid: false, workspaceId: null, error: 'Workspace not found' }
  }

  const keyHash = createHash('sha256').update(apiKey).digest('hex')
  if (keyHash !== workspace.api_key_hash) {
    return { valid: false, workspaceId: null, error: 'Invalid API key' }
  }

  return { valid: true, workspaceId }
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        reject(new Error('Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function patchAcceptHeader(req: any): void {
  // Hono (used internally by StreamableHTTPServerTransport) builds the Fetch
  // Request from rawHeaders, not req.headers. Patch rawHeaders so clients
  // that omit the required Accept value aren't rejected with 406.
  const acceptIdx = req.rawHeaders.findIndex(
    (h: string, i: number) => i % 2 === 0 && h.toLowerCase() === 'accept'
  )
  if (acceptIdx === -1) {
    req.rawHeaders.push('accept', 'application/json, text/event-stream')
  } else {
    req.rawHeaders[acceptIdx + 1] = 'application/json, text/event-stream'
  }
}

export function startHTTPTransport(config: HTTPTransportConfig): void {
  const { port, storage, encoder, activator, surfacer, version } = config

  // Session map: sessionId → { transport, workspaceId }
  const sessions = new Map<string, Session>()

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`)

    console.error(`[HTTP] ${req.method} ${url.pathname}`)

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // Health check
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'ok',
        version,
        env: process.env.MLP_ENV ?? 'development',
        timestamp: new Date().toISOString(),
        transport: 'http-sse'
      }))
      return
    }

    // ── REST API ────────────────────────────────────────────────────

    if (url.pathname === '/api/encode' && req.method === 'POST') {
      const auth = await validateRequest(req, storage)
      if (!auth.valid) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: auth.error }))
        return
      }

      let body: any
      try {
        body = await readBody(req)
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid JSON body' }))
        return
      }

      if (!body.raw) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Missing required field: raw' }))
        return
      }

      try {
        const result = await encoder.encode({
          raw: body.raw,
          source_type: body.source_type ?? 'conversation',
          source_tool: body.source_tool ?? 'manual',
          workspace: auth.workspaceId!,
          encoded_by: body.encoded_by ?? 'api',
          timestamp: new Date().toISOString()
        })
        res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error('[HTTP] /api/encode error:', message)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, id: '', error: message }))
      }
      return
    }

    if (url.pathname === '/api/activate' && req.method === 'POST') {
      const auth = await validateRequest(req, storage)
      if (!auth.valid) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: auth.error }))
        return
      }

      let body: any
      try {
        body = await readBody(req)
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid JSON body' }))
        return
      }

      if (!body.query) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Missing required field: query' }))
        return
      }

      try {
        const activationResult = await activator.activate(
          body.query,
          auth.workspaceId!,
          [],
          body.depth
        )
        const fullResult = await surfacer.surface(
          activationResult,
          auth.workspaceId!,
          body.query
        )
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(fullResult))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error('[HTTP] /api/activate error:', message)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: message }))
      }
      return
    }

    if (url.pathname === '/api/domains' && req.method === 'GET') {
      const auth = await validateRequest(req, storage)
      if (!auth.valid) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: auth.error }))
        return
      }

      try {
        const domains = await storage.listDomains(auth.workspaceId!)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ domains }))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: message }))
      }
      return
    }

    if (url.pathname === '/api/stats' && req.method === 'GET') {
      const auth = await validateRequest(req, storage)
      if (!auth.valid) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: auth.error }))
        return
      }

      try {
        const stats = await storage.getWorkspaceStats(auth.workspaceId!)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(stats))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: message }))
      }
      return
    }

    // ── MCP Transport ───────────────────────────────────────────────

    if (url.pathname === '/mcp') {

      patchAcceptHeader(req)

      // Check for existing session
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!
        await session.transport.handleRequest(req, res)
        return
      }

      // New session — validate auth before creating anything
      const auth = await validateRequest(req, storage)
      if (!auth.valid) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: auth.error }))
        return
      }

      const workspaceId = auth.workspaceId!

      // Create transport and server for this session
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, { transport, workspaceId })
          console.error(`[HTTP Transport] Session initialized: ${sid} (workspace: ${workspaceId})`)
        }
      })

      transport.onclose = () => {
        for (const [sid, session] of sessions) {
          if (session.transport === transport) {
            sessions.delete(sid)
            console.error(`[HTTP Transport] Session closed: ${sid}`)
            break
          }
        }
      }

      const server = config.createMLPServer(workspaceId)
      await server.connect(transport)
      await transport.handleRequest(req, res)

      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  })

  httpServer.listen(port, () => {
    console.error(`[HTTP Transport] Listening on port ${port}`)
    console.error(`[HTTP Transport] REST API:    http://localhost:${port}/api/{encode,activate,domains,stats}`)
    console.error(`[HTTP Transport] MCP endpoint: http://localhost:${port}/mcp`)
    console.error(`[HTTP Transport] Health check: http://localhost:${port}/health`)
  })
}
