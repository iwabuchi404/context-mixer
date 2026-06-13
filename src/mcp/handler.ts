// MCP HTTP handler for ContextMixer (Streamable HTTP / JSON-RPC).
//
// Auth: MCP reuses the existing API keys (kb_...). The client sends
//   Authorization: Bearer kb_xxxx
// which is verified by verifyApiKey, giving the same AiAuth context (scopes +
// collection restrictions) used everywhere else. There is no separate OAuth
// token store — one credential model for the whole app.

import { Hono } from 'hono'
import { toolDefinitions } from './server'
import * as tools from './tools'
import { verifyApiKey, API_KEY_PREFIX } from '../auth/apikey'
import type { AppEnv, AiAuth } from '../auth/adapter'

export const mcpRoute = new Hono<{ Bindings: AppEnv['Bindings'] }>()

// Per-tool scope requirement
const TOOL_SCOPE: Record<string, 'read' | 'write'> = {
  search_docs: 'read',
  get_doc: 'read',
  list_collections: 'read',
  get_entrypoint: 'read',
  write_doc: 'write',
  append_doc: 'write',
}

const rpcError = (c: any, code: number, message: string, status: 400 | 401 | 403 | 404 | 500, id?: unknown) =>
  c.json({ jsonrpc: '2.0', error: { code, message }, id }, status)

// GET /mcp - discovery info (still requires a valid key)
mcpRoute.get('/', async (c) => {
  const auth = await authFromHeader(c)
  if (!auth) return rpcError(c, -32001, 'Unauthorized: valid API key required', 401)
  return c.json({ name: 'context-mixer', version: '0.1.0', transport: 'http', capabilities: { tools: {} } })
})

// POST /mcp - JSON-RPC endpoint
mcpRoute.post('/', async (c) => {
  try {
    const auth = await authFromHeader(c)
    if (!auth) return rpcError(c, -32001, 'Unauthorized: valid API key required', 401)

    const body = await c.req.json()
    const { jsonrpc, method, params, id } = body
    if (jsonrpc !== '2.0') return rpcError(c, -32600, 'Invalid JSON-RPC version', 400, id)

    switch (method) {
      case 'initialize':
        // Echo the client's protocol version for max compatibility
        return c.json({
          jsonrpc: '2.0',
          result: {
            protocolVersion: params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'context-mixer', version: '0.1.0' },
          },
          id,
        })

      case 'ping':
        return c.json({ jsonrpc: '2.0', result: {}, id })

      case 'tools/list':
        return c.json({
          jsonrpc: '2.0',
          result: {
            tools: Object.entries(toolDefinitions).map(([name, def]) => ({
              name, description: def.description, inputSchema: def.inputSchema,
            })),
          },
          id,
        })

      case 'tools/call': {
        const toolName = params?.name
        const required = TOOL_SCOPE[toolName]
        if (!required) return rpcError(c, -32602, `Unknown tool: ${toolName}`, 400, id)
        if (!auth.scopes.includes(required)) {
          return rpcError(c, -32003, `This key lacks the "${required}" scope`, 403, id)
        }
        const result = await callTool(c.env, auth, toolName, params?.arguments ?? {})
        return c.json({ jsonrpc: '2.0', result, id })
      }

      default:
        // Notifications (no id, no response expected) — ack with 204
        if (typeof method === 'string' && method.startsWith('notifications/')) {
          return c.body(null, 204)
        }
        return rpcError(c, -32601, `Method not found: ${method}`, 404, id)
    }
  } catch (error: any) {
    console.error('MCP error:', error)
    return rpcError(c, -32603, 'Internal error', 500)
  }
})

// Verify the Bearer API key and return the AiAuth context (or null).
async function authFromHeader(c: any): Promise<AiAuth | null> {
  const header = c.req.header('Authorization') || ''
  const bearer = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
  if (!bearer.startsWith(API_KEY_PREFIX)) return null
  return verifyApiKey(c.env.DB, bearer)
}

function callTool(env: AppEnv['Bindings'], auth: AiAuth, name: string, args: any) {
  switch (name) {
    case 'search_docs': return tools.searchDocs(env, auth, args)
    case 'get_doc': return tools.getDoc(env, auth, args)
    case 'write_doc': return tools.writeDoc(env, auth, args)
    case 'append_doc': return tools.appendDoc(env, auth, args)
    case 'list_collections': return tools.listCollections(env, auth)
    case 'get_entrypoint': return tools.getEntrypoint(env, auth, args)
    default:
      return Promise.resolve({ content: [{ type: 'text', text: `Error: Unknown tool "${name}"` }], isError: true })
  }
}
