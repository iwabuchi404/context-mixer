// OAuth handler for MCP server
// Implements OAuth 2.1 authorization endpoints

import { Hono } from 'hono'
import type { AppEnv } from '../auth/adapter'
import { generateToken } from './tokens'

export const oauthRoute = new Hono<{ Bindings: AppEnv['Bindings'] }>()

// GET /oauth/authorize - Authorization endpoint
oauthRoute.get('/authorize', (c) => {
  const { client_id, redirect_uri, response_type, state } = c.req.query()

  if (!client_id || !redirect_uri || response_type !== 'code') {
    return c.json({ error: 'invalid_request' }, 400)
  }

  // Verify client_id
  if (client_id !== c.env.OAUTH_CLIENT_ID) {
    return c.json({ error: 'invalid_client' }, 401)
  }

  // In a real app, redirect to login page
  // For now, auto-approve for testing
  const authCode = `code_${Date.now()}_${Math.random().toString(36).substr(2, 16)}`
  const authUrl = new URL(redirect_uri)
  authUrl.searchParams.set('code', authCode)
  if (state) authUrl.searchParams.set('state', state)

  return c.redirect(authUrl.toString())
})

// POST /oauth/token - Token endpoint
oauthRoute.post('/token', async (c) => {
  const body = await c.req.json()
  const { grant_type, client_id, client_secret } = body

  if (grant_type !== 'authorization_code') {
    return c.json({ error: 'unsupported_grant_type' }, 400)
  }

  // Verify client credentials
  if (client_id !== c.env.OAUTH_CLIENT_ID || client_secret !== c.env.OAUTH_CLIENT_SECRET) {
    return c.json({ error: 'invalid_client' }, 401)
  }

  // Issue a token stored in D1
  const accessToken = await generateToken(c.env.DB)

  return c.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'all'
  })
})

// GET /oauth/.well-known/oauth-authorization-server - Discovery endpoint
oauthRoute.get('/.well-known/oauth-authorization-server', (c) => {
  const baseUrl = `${c.req.header('X-Forwarded-Proto') || 'https'}://${c.req.header('Host')}`
  return c.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['all']
  })
})
