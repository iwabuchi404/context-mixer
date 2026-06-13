// MCP HTTP handler for ContextMixer
// Implements Streamable HTTP transport for remote MCP connections

import { Hono } from 'hono'
import { toolDefinitions } from './server'
import * as tools from './tools'
import { verifyToken } from './tokens'
import type { AppEnv } from '../auth/adapter'

export const mcpRoute = new Hono<{ Bindings: AppEnv['Bindings'] }>()

// GET /mcp - MCP server info (for discovery)
mcpRoute.get('/', (c) => {
  return c.json({
    name: 'context-mixer',
    version: '0.1.0',
    transport: 'http',
    capabilities: {
      tools: {}
    }
  })
})

// POST /mcp - MCP protocol endpoint
// This handles MCP requests over HTTP (streamable JSON-RPC)
mcpRoute.post('/', async (c) => {
  try {
    // Verify OAuth bearer token using D1
    const authHeader = c.req.header('Authorization') || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null

    if (!token || !(await verifyToken(c.env.DB, token))) {
      return c.json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized: Invalid or missing token' }
      }, 401)
    }

    const body = await c.req.json()
    const { jsonrpc, method, params, id } = body

    if (jsonrpc !== '2.0') {
      return c.json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Invalid JSON-RPC version' },
        id
      }, 400)
    }

    // Handle request based on method
    let result
    switch (method) {
      case 'tools/list':
        result = {
          tools: Object.entries(toolDefinitions).map(([name, def]) => ({
            name,
            description: def.description,
            inputSchema: def.inputSchema
          }))
        }
        break

      case 'tools/call':
        const toolResult = await handleToolCall(c.env, params.name, params.arguments)
        result = toolResult
        break

      default:
        return c.json({
          jsonrpc: '2.0',
          error: { code: -32601, message: `Method not found: ${method}` },
          id
        }, 404)
    }

    return c.json({
      jsonrpc: '2.0',
      result,
      id
    })
  } catch (error: any) {
    console.error('MCP error:', error)
    return c.json({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: 'Internal error',
        data: error.message
      }
    }, 500)
  }
})

// Handle tool execution
async function handleToolCall(env: AppEnv['Bindings'], name: string, args: any) {
  switch (name) {
    case 'search_docs':
      return await tools.searchDocs(env, args)
    case 'get_doc':
      return await tools.getDoc(env, args)
    case 'write_doc':
      return await tools.writeDoc(env, args)
    case 'append_doc':
      return await tools.appendDoc(env, args)
    case 'list_collections':
      return await tools.listCollections(env)
    case 'get_entrypoint':
      return await tools.getEntrypoint(env, args)
    default:
      return {
        content: [{ type: 'text', text: `Error: Unknown tool "${name}"` }],
        isError: true
      }
  }
}

