// Clerk authentication routes.
// Handles login redirect and callback for Clerk Hosted UI.
import { Hono } from 'hono'
import type { AppEnv } from '../auth/adapter'
import { deleteCookie } from 'hono/cookie'

export const authRoute = new Hono<AppEnv>()

// GET /auth/login - Redirect to Clerk Hosted UI (Account Portal)
authRoute.get('/login', (c) => {
  const signInUrl = c.env.CLERK_SIGN_IN_URL

  if (!signInUrl) {
    return c.json({ error: { code: 'INVALID_CONFIG', message: 'CLERK_SIGN_IN_URL not configured' } }, 500)
  }

  // Origin must come from the request URL: browsers don't send an Origin
  // header on plain GET navigations
  const origin = new URL(c.req.url).origin
  const redirectUrl = `${signInUrl}?redirect_url=${encodeURIComponent(`${origin}/auth/callback`)}`

  return c.redirect(redirectUrl)
})

// GET /auth/callback - Handle Clerk authentication callback
// Clerk sets the session token in a cookie, which will be validated
// by the clerkMiddleware on subsequent requests.
authRoute.get('/callback', async (c) => {
  // After Clerk authentication, the user is redirected here with session token.
  // The clerkMiddleware in authMiddleware.ts will validate the token.
  // We just redirect to the main app page.
  const origin = new URL(c.req.url).origin
  return c.redirect(`${origin}/`)
})

// POST /auth/logout - Clear the session
authRoute.post('/logout', (c) => {
  deleteCookie(c, '__session')
  return c.json({ success: true })
})
