// Clerk authentication routes.
// Handles login redirect and callback for Clerk Hosted UI.
import { Hono } from 'hono'
import type { AppEnv } from '../auth/adapter'
import { deleteCookie } from 'hono/cookie'

export const authRoute = new Hono<AppEnv>()

// GET /auth/login - Redirect to Clerk Hosted UI
authRoute.get('/login', (c) => {
  const frontendApi = c.env.CLERK_FRONTEND_API

  if (!frontendApi) {
    return c.json({ error: { code: 'INVALID_CONFIG', message: 'CLERK_FRONTEND_API not configured' } }, 500)
  }

  // Build the authorization URL with redirect callback
  // Clerk's sign-in page handles the redirect after authentication
  const origin = c.req.header('origin') || 'http://localhost:8787'
  const redirectUrl = `${frontendApi}/v1/client?after_sign_in_url=${encodeURIComponent(
    `${origin}/auth/callback`
  )}&after_sign_up_url=${encodeURIComponent(
    `${origin}/auth/callback`
  )}&sign_up_force_redirect_url=${encodeURIComponent(
    `${origin}/auth/callback`
  )}`

  return c.redirect(redirectUrl)
})

// GET /auth/callback - Handle Clerk authentication callback
// Clerk sets the session token in a cookie, which will be validated
// by the clerkMiddleware on subsequent requests.
authRoute.get('/callback', async (c) => {
  // After Clerk authentication, the user is redirected here with session token.
  // The clerkMiddleware in authMiddleware.ts will validate the token.
  // We just redirect to the main app page.
  const origin = c.req.header('origin') || 'http://localhost:8787'
  return c.redirect(`${origin}/`)
})

// POST /auth/logout - Clear the session
authRoute.post('/logout', (c) => {
  deleteCookie(c, '__session')
  return c.json({ success: true })
})
