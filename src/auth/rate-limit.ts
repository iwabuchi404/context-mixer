// Lightweight in-memory rate limiter.
//
// Scope & caveats: state lives in a single Worker isolate's memory, so limits
// are per-isolate, not global. This is a deliberate first line of defense — it
// blunts naive floods (a script hammering /inbox or /auth) cheaply and without
// extra infrastructure. It is NOT a substitute for edge protection against
// distributed attacks; pair it with Cloudflare WAF Rate Limiting Rules in prod.
import type { Context, MiddlewareHandler } from 'hono'
import type { AppEnv } from './adapter'

type Bucket = { count: number; resetAt: number }

const WINDOW_MS = 60_000

// Per-minute request ceilings. Unauthenticated paths are the tightest since
// they are reachable without a key.
const LIMITS: Array<{ test: (method: string, path: string) => boolean; max: number; name: string }> = [
  { name: 'inbox-submit', max: 20, test: (m, p) => m === 'POST' && /^\/inbox\/[^/]+$/.test(p) },
  { name: 'auth', max: 30, test: (_m, p) => p.startsWith('/auth/') },
  { name: 'authed', max: 600, test: () => true }, // everything else (key/session required anyway)
]

// Map is bounded by pruning expired buckets on each lookup wave.
const buckets = new Map<string, Bucket>()

const clientIp = (c: Context<AppEnv>): string =>
  c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown'

export const rateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method
  const path = c.req.path
  const rule = LIMITS.find((r) => r.test(method, path))!

  const now = Date.now()
  const key = `${rule.name}:${clientIp(c)}`
  const bucket = buckets.get(key)

  if (!bucket || bucket.resetAt <= now) {
    // Opportunistic prune so the map can't grow unbounded across windows
    if (buckets.size > 5000) {
      for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k)
    }
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS })
    return next()
  }

  if (bucket.count >= rule.max) {
    const retry = Math.ceil((bucket.resetAt - now) / 1000)
    c.header('Retry-After', String(retry))
    return c.json({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } }, 429)
  }

  bucket.count++
  return next()
}
