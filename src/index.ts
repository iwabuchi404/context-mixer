import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AppEnv } from './auth/adapter'
import { authMiddleware } from './auth/middleware'
import { rateLimit } from './auth/rate-limit'
import { healthRoute } from './routes/health'
import { authRoute } from './routes/auth'
import { entrypointRoute } from './routes/entrypoint'
import { documentsRoute } from './routes/documents'
import { collectionsRoute } from './routes/collections'
import { searchRoute } from './routes/search'
import { filesRoute } from './routes/files'
import { inboxRoute } from './routes/inbox'
import { apiKeysRoute } from './routes/api-keys'
import { meRoute } from './routes/me'
import { uiRoute } from './routes/ui'
import { mcpRoute } from './mcp/handler'

const app = new Hono<AppEnv>()

// CORS for development
app.use('*', cors())

// Rate limiting (runs before auth so unauthenticated floods are cheap to reject)
app.use('*', rateLimit)

// Auth (skips public paths: /, /health, /auth/*, POST /inbox/:token)
app.use('*', authMiddleware)

// Auth routes (public)
app.route('/auth', authRoute)

// Health check
app.route('/', healthRoute)

// API routes
app.route('/entrypoint', entrypointRoute)
app.route('/docs', documentsRoute)
app.route('/collections', collectionsRoute)
app.route('/search', searchRoute)
app.route('/files', filesRoute)
app.route('/inbox', inboxRoute)
app.route('/api-keys', apiKeysRoute)
app.route('/me', meRoute)

// Web UI fragments (HTMX)
app.route('/ui', uiRoute)

// MCP endpoint (JSON-RPC). Auth = existing API keys (Bearer kb_...),
// verified inside the handler with per-tool scope + collection enforcement.
app.route('/mcp', mcpRoute)

// 404 handler
app.notFound((c) => {
  return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404)
})

// Error handler
app.onError((err, c) => {
  console.error('Error:', err)
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500)
})

export default app
