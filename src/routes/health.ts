import { Hono } from 'hono'
import type { AppEnv } from '../auth/adapter'

export const healthRoute = new Hono<AppEnv>()

// Public config for the Web UI (publishable values only)
healthRoute.get('/config', (c) => {
  return c.json({
    publishable_key: c.env.CLERK_PUBLISHABLE_KEY,
    frontend_api: c.env.CLERK_FRONTEND_API,
    sign_in_url: c.env.CLERK_SIGN_IN_URL,
    environment: c.env.ENVIRONMENT ?? 'unknown',
  })
})

healthRoute.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: Date.now(),
    version: '0.1.0'
  })
})

// Root entry point (also returns basic info)
healthRoute.get('/', (c) => {
  return c.json({
    name: 'context-mixer',
    description: 'AI-accessible knowledge base service',
    version: '0.1.0',
    endpoints: {
      health: '/health',
      // Future endpoints:
      // auth: '/auth/*',
      // collections: '/collections/*',
      // docs: '/docs/*',
      // search: '/search',
      // files: '/files/*',
      // inbox: '/inbox/*',
      // apiKeys: '/api-keys/*',
      // entrypoint: '/entrypoint'
    }
  })
})
