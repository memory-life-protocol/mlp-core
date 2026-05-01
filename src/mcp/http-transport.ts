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

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer } from 'node:http'
import { randomUUID, createHash } from 'node:crypto'
import type { StorageAdapter } from '../interfaces/StorageAdapter.js'

export interface HTTPTransportConfig {
  port: number
  storage: StorageAdapter
  createMLPServer: (workspaceId: string) => any
  version: string
}

export function startHTTPTransport(config: HTTPTransportConfig): void {
  const { port, storage, version } = config

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`)

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

    // MCP endpoint
    if (url.pathname === '/mcp') {

      // Validate auth
      const authHeader = req.headers['authorization']
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Missing Authorization header' }))
        return
      }

      const token = authHeader.slice(7).trim()
      const colonIndex = token.indexOf(':')
      if (colonIndex === -1) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid token format. Use workspaceId:apiKey' }))
        return
      }

      const workspaceId = token.slice(0, colonIndex)
      const apiKey = token.slice(colonIndex + 1)

      const workspace = await storage.getWorkspace(workspaceId)
      if (!workspace) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Workspace not found' }))
        return
      }

      const keyHash = createHash('sha256').update(apiKey).digest('hex')
      if (keyHash !== workspace.api_key_hash) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid API key' }))
        return
      }

      // Create MCP server and transport for this request
      const server = config.createMLPServer(workspaceId)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          console.error(`[HTTP Transport] Session initialized: ${sessionId}`)
        }
      })

      // Connect server to transport
      await server.connect(transport)

      // Force Accept header before MCP SDK validates it.
      // Hono (used internally by the SDK) reads rawHeaders, not req.headers,
      // so we must patch rawHeaders directly.
      const acceptIdx = req.rawHeaders.findIndex(
        (h, i) => i % 2 === 0 && h.toLowerCase() === 'accept'
      )
      if (acceptIdx === -1) {
        req.rawHeaders.push('accept', 'application/json, text/event-stream')
      } else {
        req.rawHeaders[acceptIdx + 1] = 'application/json, text/event-stream'
      }

      // Handle the request
      await transport.handleRequest(req, res)

      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  })

  httpServer.listen(port, () => {
    console.error(`[HTTP Transport] Listening on port ${port}`)
    console.error(`[HTTP Transport] MCP endpoint: http://localhost:${port}/mcp`)
    console.error(`[HTTP Transport] Health check: http://localhost:${port}/health`)
  })
}
