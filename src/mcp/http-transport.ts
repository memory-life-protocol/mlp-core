/**
 * HTTP/SSE Transport for MLP
 *
 * Exposes MLP tools over HTTP with Server-Sent Events.
 * Allows any MCP-compatible tool to connect via a URL
 * without running anything locally.
 *
 * Authentication:
 *   Every request must include a workspace API key:
 *   Authorization: Bearer your-workspace-api-key
 *
 *   The key is validated against the workspace.
 *   All tool calls are scoped to that workspace only.
 *   Requests without a valid key are rejected with 401.
 *
 * Transport:
 *   POST /mcp        — MCP message endpoint
 *   GET  /mcp        — SSE stream endpoint
 *   GET  /health     — health check
 *
 * What it does not do:
 *   It never bypasses workspace isolation.
 *   It never exposes clusters from other workspaces.
 *   It never accepts unauthenticated requests.
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { StorageAdapter } from '../interfaces/StorageAdapter.js'

interface AuthResult {
  valid: boolean
  workspaceId: string | null
  error?: string
}

// Validate workspace API key from Authorization header
// Format: Bearer workspace-id:api-key-hash
async function validateAuth(
  req: IncomingMessage,
  storage: StorageAdapter
): Promise<AuthResult> {
  const authHeader = req.headers['authorization']

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { valid: false, workspaceId: null, error: 'Missing Authorization header' }
  }

  const token = authHeader.slice(7).trim()

  // Token format: workspaceId:apiKey
  const colonIndex = token.indexOf(':')
  if (colonIndex === -1) {
    return { valid: false, workspaceId: null, error: 'Invalid token format. Use workspaceId:apiKey' }
  }

  const workspaceId = token.slice(0, colonIndex)
  const apiKey = token.slice(colonIndex + 1)

  if (!workspaceId || !apiKey) {
    return { valid: false, workspaceId: null, error: 'Invalid token format' }
  }

  // Validate workspace exists
  const workspace = await storage.getWorkspace(workspaceId)
  if (!workspace) {
    return { valid: false, workspaceId: null, error: 'Workspace not found' }
  }

  // Simple hash comparison — in production use bcrypt or similar
  const { createHash } = await import('node:crypto')
  const keyHash = createHash('sha256').update(apiKey).digest('hex')

  if (keyHash !== workspace.api_key_hash) {
    return { valid: false, workspaceId: null, error: 'Invalid API key' }
  }

  return { valid: true, workspaceId }
}

function sendJSON(res: ServerResponse, status: number, data: object): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  })
  res.end(JSON.stringify(data))
}

export interface HTTPTransportConfig {
  port: number
  storage: StorageAdapter
  createServer: (workspaceId: string) => any // McpServer instance
  version: string
}

export function startHTTPTransport(config: HTTPTransportConfig): void {
  const { port, storage, version } = config

  // Active SSE connections keyed by session id
  const sessions = new Map<string, {
    res: ServerResponse
    workspaceId: string
    server: any
  }>()

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`)

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
      })
      res.end()
      return
    }

    // Health check — no auth required
    if (url.pathname === '/health') {
      sendJSON(res, 200, {
        status: 'ok',
        version,
        env: process.env.MLP_ENV ?? 'development',
        timestamp: new Date().toISOString(),
        transport: 'http-sse',
        active_sessions: sessions.size
      })
      return
    }

    // All /mcp routes require auth
    if (url.pathname === '/mcp') {

      // GET /mcp — establish SSE stream
      if (req.method === 'GET') {
        const auth = await validateAuth(req, storage)
        if (!auth.valid) {
          sendJSON(res, 401, { error: auth.error })
          return
        }

        const sessionId = randomUUID()
        const mcpServer = config.createServer(auth.workspaceId!)

        // Set SSE headers
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
          'Mcp-Session-Id': sessionId
        })

        // Send session established event
        res.write(`data: ${JSON.stringify({
          type: 'session',
          sessionId,
          workspaceId: auth.workspaceId
        })}\n\n`)

        sessions.set(sessionId, {
          res,
          workspaceId: auth.workspaceId!,
          server: mcpServer
        })

        console.error(
          `[HTTP Transport] SSE session opened: ${sessionId} workspace: ${auth.workspaceId}`
        )

        // Clean up on disconnect
        req.on('close', () => {
          sessions.delete(sessionId)
          console.error(`[HTTP Transport] SSE session closed: ${sessionId}`)
        })

        return
      }

      // POST /mcp — handle MCP message
      if (req.method === 'POST') {
        const auth = await validateAuth(req, storage)
        if (!auth.valid) {
          sendJSON(res, 401, { error: auth.error })
          return
        }

        // Read request body
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', async () => {
          try {
            const message = JSON.parse(body)
            const sessionId = req.headers['mcp-session-id'] as string

            // Get or create server for this workspace
            let session = sessionId ? sessions.get(sessionId) : null
            if (!session) {
              // Stateless request — create ephemeral server
              const mcpServer = config.createServer(auth.workspaceId!)
              session = {
                res,
                workspaceId: auth.workspaceId!,
                server: mcpServer
              }
            }

            // Process the MCP message through the server
            const result = await session.server.processMessage(message)
            sendJSON(res, 200, result ?? { status: 'ok' })

          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            sendJSON(res, 400, { error: message })
          }
        })

        return
      }

      sendJSON(res, 405, { error: 'Method not allowed' })
      return
    }

    sendJSON(res, 404, { error: 'Not found' })
  })

  httpServer.listen(port, () => {
    console.error(`[HTTP Transport] Listening on port ${port}`)
    console.error(`[HTTP Transport] MCP endpoint: http://localhost:${port}/mcp`)
    console.error(`[HTTP Transport] Health check: http://localhost:${port}/health`)
  })
}
