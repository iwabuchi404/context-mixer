import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { OAuthProvider } from '@cloudflare/workers-oauth-provider'
import type { AppEnv, Env } from './auth/adapter'
import { isProduction } from './auth/adapter'
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
import { McpApiHandler } from './mcp/handler'
import { oauthRoute } from './mcp/oauth-handler'

const app = new Hono<AppEnv>()

// CORS — restrict to the configured public origin in prod; allow any in dev.
// Set CORS_ORIGIN=https://your-app.example in production dashboard Secrets.
// Use ENVIRONMENT=development in .dev.vars and ENVIRONMENT=production as a Secret.
app.use('*', cors({
  origin: (_origin, c) => {
    const env = c.env as Env
    if (!isProduction(env)) return '*'
    // In production, require an explicit CORS_ORIGIN; reject if unset.
    return env.CORS_ORIGIN ?? null
  },
  allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'If-Match'],
  credentials: true,
}))

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

// MCP OAuth consent UI. token/register/metadata + token validation are handled
// by the OAuthProvider wrapper below; only the consent screen lives in the app.
app.route('/oauth', oauthRoute)

// 404 handler
app.notFound((c) => {
  return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404)
})

// Error handler
app.onError((err, c) => {
  console.error('Error:', err)
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500)
})

// Wrap the whole app in the OAuth provider. Requests to /mcp (apiRoute) are
// gated by access-token validation and forwarded to McpApiHandler with the
// granted props; everything else (UI, REST, /oauth/authorize consent, the
// .well-known metadata) flows through the Hono app as the defaultHandler.
// token/register endpoints are served by the provider itself.
export default new OAuthProvider({
  apiRoute: '/mcp',
  apiHandler: McpApiHandler as any,
  defaultHandler: app as unknown as ExportedHandler<Env>,
  authorizeEndpoint: '/oauth/authorize',
  tokenEndpoint: '/oauth/token',
  clientRegistrationEndpoint: '/oauth/register',
  scopesSupported: ['read', 'write'],
})
