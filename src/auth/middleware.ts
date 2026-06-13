// Unified auth middleware.
// - `Authorization: Bearer kb_...` → API key auth (AI clients)
// - otherwise → Clerk session auth (humans)
// Public paths are skipped explicitly.
import type { Context, MiddlewareHandler, Next } from 'hono'
import type { AppEnv } from './adapter'
import { API_KEY_PREFIX, verifyApiKey } from './apikey'
import { clerkSession, ensureUser, verifySession } from './clerk'

const isPublic = (method: string, path: string): boolean => {
  if (path === '/health' || path === '/' || path === '/config' || path === '/favicon.svg') return true
  if (path.startsWith('/auth/') || path.startsWith('/public/')) return true
  // /mcp skips the shared middleware and verifies the API key itself, so it can
  // apply per-tool scope (this gate's GET=read/POST=write rule is too coarse for
  // JSON-RPC, where a POST may be a read). The handler rejects missing/invalid keys.
  if (path.startsWith('/mcp')) return true
  // External submission endpoint only. NOT /inbox/tokens (auth-required management).
  if (method === 'POST' && /^\/inbox\/[^/]+$/.test(path) && path !== '/inbox/tokens') return true
  return false
}

const unauthorized = (c: Context<AppEnv>, message: string) =>
  c.json({ error: { code: 'UNAUTHORIZED', message } }, 401)

const forbidden = (c: Context<AppEnv>, message: string) =>
  c.json({ error: { code: 'FORBIDDEN', message } }, 403)

export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (isPublic(c.req.method, c.req.path)) {
    return next()
  }

  const header = c.req.header('Authorization') ?? ''
  const bearer = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''

  if (bearer.startsWith(API_KEY_PREFIX)) {
    const auth = await verifyApiKey(c.env.DB, bearer)
    if (!auth) {
      return unauthorized(c, 'Invalid or expired API key')
    }

    // Scope check: GET/HEAD need "read", everything else needs "write"
    const required = c.req.method === 'GET' || c.req.method === 'HEAD' ? 'read' : 'write'
    if (!auth.scopes.includes(required)) {
      return forbidden(c, `API key lacks "${required}" scope`)
    }

    // Key management is human-only
    if (c.req.path.startsWith('/api-keys')) {
      return forbidden(c, 'API keys cannot manage API keys')
    }

    c.set('auth', auth)
    return next()
  }

  return humanAuth(c, next)
}

// Runs the Clerk middleware, then promotes the session into our auth context.
const humanAuth = async (c: Context<AppEnv>, next: Next) => {
  let result: Response | undefined
  const clerkResponse = await clerkSession(c, async () => {
    const userId = verifySession(c)
    if (!userId) {
      result = unauthorized(c, 'Authentication required')
      return
    }
    await ensureUser(c, userId)
    c.set('auth', { authorType: 'human', userId })
    await next()
  })
  return result ?? clerkResponse ?? undefined
}
