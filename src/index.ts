import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AppEnv } from './auth/adapter'
import { authMiddleware } from './auth/middleware'
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

const app = new Hono<AppEnv>()

// CORS for development
app.use('*', cors())

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
