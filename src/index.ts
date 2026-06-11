import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AppEnv } from './auth/adapter'
import { authMiddleware } from './auth/middleware'
import { healthRoute } from './routes/health'
import { documentsRoute } from './routes/documents'
import { collectionsRoute } from './routes/collections'
import { searchRoute } from './routes/search'
import { apiKeysRoute } from './routes/api-keys'
import { meRoute } from './routes/me'

const app = new Hono<AppEnv>()

// CORS for development
app.use('*', cors())

// Auth (skips public paths: /, /health, POST /inbox/:token)
app.use('*', authMiddleware)

// Health check
app.route('/', healthRoute)

// API routes
app.route('/docs', documentsRoute)
app.route('/collections', collectionsRoute)
app.route('/search', searchRoute)
app.route('/api-keys', apiKeysRoute)
app.route('/me', meRoute)

// Placeholder for future routes
// app.route('/files', filesRoute)
// app.route('/inbox', inboxRoute)

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
