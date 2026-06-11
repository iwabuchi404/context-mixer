// Clerk adapter. All Clerk dependencies live in this file only.
import { clerkMiddleware, getAuth } from '@hono/clerk-auth'
import type { Context, MiddlewareHandler } from 'hono'
import type { AppEnv } from './adapter'

// Verifies the Clerk session token (cookie or Authorization: Bearer <jwt>)
// and exposes the result to getAuth(). Does not reject unauthenticated requests.
export const clerkSession: MiddlewareHandler = clerkMiddleware()

// Returns the Clerk user ID if the request carries a valid session, else null.
export const verifySession = (c: Context<AppEnv>): string | null => {
  const auth = getAuth(c as any)
  return auth?.userId ?? null
}

// Registers the user in D1 on first authenticated request.
export const ensureUser = async (c: Context<AppEnv>, userId: string): Promise<void> => {
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first()
  if (existing) return

  let email = ''
  try {
    const clerk = (c as any).get('clerk')
    const user = await clerk.users.getUser(userId)
    email = user.primaryEmailAddress?.emailAddress
      ?? user.emailAddresses?.[0]?.emailAddress
      ?? ''
  } catch (e) {
    console.error('Failed to fetch user from Clerk:', e)
  }

  await c.env.DB.prepare(
    'INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)'
  ).bind(userId, email, Date.now()).run()
}
