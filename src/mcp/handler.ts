// MCP HTTP handler (Streamable HTTP / JSON-RPC), mounted as the OAuthProvider
// apiHandler. The OAuth library has already verified the access token by the
// time this runs; the granted props arrive via this.ctx.props.
//
// props (set at consent, see oauth-handler.ts) carry the user's chosen scopes
// and collection restriction, which we turn into the same AiAuth context the
// REST routes use — so tools enforce identical rules (scope, isCollectionAllowed,
// signed revisions, link sync).

import { WorkerEntrypoint } from 'cloudflare:workers'
import { toolDefinitions } from './server'
import * as tools from './tools'
import type { Env, AiAuth, McpProps } from '../auth/adapter'

const TOOL_SCOPE: Record<string, 'read' | 'write'> = {
  search_docs: 'read',
  get_doc: 'read',
  list_collections: 'read',
  list_docs: 'read',
  get_entrypoint: 'read',
  write_doc: 'write',
  append_doc: 'write',
  delete_doc: 'write',
  create_collection: 'write',
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

const rpcError = (code: number, message: string, status: number, id?: unknown) =>
  json({ jsonrpc: '2.0', error: { code, message }, id }, status)

export class McpApiHandler extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const props = (this.ctx as any).props as McpProps | undefined

    // TEMP DEBUG: log every request to diagnose ChatGPT (remove after fix).
    // Shows whether tools/call arrives at all and what props the grant carries.
    let rpcMethod = ''
    if (request.method === 'POST') {
      try {
        const peek = request.clone()
        const parsed: any = await peek.json()
        rpcMethod = parsed?.method ?? ''
      } catch { /* not JSON */ }
    }
    console.log('[MCP-DEBUG]', JSON.stringify({
      http: request.method,
      path: new URL(request.url).pathname,
      rpc: rpcMethod,
      hasProps: !!props,
      scopes: props?.scopes ?? null,
      allowedCollections: props?.allowedCollections ?? null,
      keyName: props?.keyName ?? null,
      mcpSessionId: request.headers.get('Mcp-Session-Id'),
      accept: request.headers.get('Accept'),
    }))

    if (!props) return rpcError(-32001, 'Unauthorized', 401)

    // Reconstruct the AiAuth context from the granted props
    const auth: AiAuth = {
      authorType: 'ai',
      // No persisted api_keys row for OAuth grants — created_by_key_id (FK to
      // api_keys) must stay null; the keyName ('oauth:email') carries attribution.
      keyId: null,
      keyName: props.keyName,
      // Fallback: props.scopes can arrive empty for ChatGPT's OAuth grant (the
      // consent UI defaults read on, so this matches intended behavior and keeps
      // read tools callable). TODO: find why props.scopes is empty for ChatGPT.
      scopes: props.scopes?.length ? props.scopes : ['read'],
      allowedCollections: props.allowedCollections ?? null,
      entryDocId: null,
    }

    if (request.method === 'GET') {
      return json({ name: 'context-mixer', version: '0.1.0', transport: 'http', capabilities: { tools: {} } })
    }
    if (request.method !== 'POST') {
      return rpcError(-32600, 'Method not allowed', 405)
    }

    let body: any
    try {
      body = await request.json()
    } catch {
      return rpcError(-32700, 'Parse error', 400, null)
    }

    const { jsonrpc, method, params, id } = body
    if (jsonrpc !== '2.0') return rpcError(-32600, 'Invalid JSON-RPC version', 400, id)

    try {
      switch (method) {
        case 'initialize':
          return json({
            jsonrpc: '2.0',
            result: {
              protocolVersion: params?.protocolVersion ?? '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'context-mixer', version: '0.1.0' },
            },
            id,
          })

        case 'ping':
          return json({ jsonrpc: '2.0', result: {}, id })

        case 'tools/list':
          return json({
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
          if (!required) return rpcError(-32602, `Unknown tool: ${toolName}`, 400, id)
          if (!auth.scopes.includes(required)) {
            return rpcError(-32003, `This grant lacks the "${required}" scope`, 403, id)
          }
          const result = await callTool(this.env, auth, toolName, params?.arguments ?? {})
          return json({ jsonrpc: '2.0', result, id })
        }

        default:
          if (typeof method === 'string' && method.startsWith('notifications/')) {
            return new Response(null, { status: 204 })
          }
          return rpcError(-32601, `Method not found: ${method}`, 404, id)
      }
    } catch (error: any) {
      console.error('MCP error:', error)
      return rpcError(-32603, 'Internal error', 500, id)
    }
  }
}

function callTool(env: Env, auth: AiAuth, name: string, args: any) {
  switch (name) {
    case 'search_docs': return tools.searchDocs(env, auth, args)
    case 'get_doc': return tools.getDoc(env, auth, args)
    case 'write_doc': return tools.writeDoc(env, auth, args)
    case 'append_doc': return tools.appendDoc(env, auth, args)
    case 'list_collections': return tools.listCollections(env, auth)
    case 'list_docs': return tools.listDocs(env, auth, args)
    case 'get_entrypoint': return tools.getEntrypoint(env, auth, args)
    case 'delete_doc': return tools.deleteDoc(env, auth, args)
    case 'create_collection': return tools.createCollection(env, auth, args)
    default:
      return Promise.resolve({ content: [{ type: 'text', text: `Error: Unknown tool "${name}"` }], isError: true })
  }
}
