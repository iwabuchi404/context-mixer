import { Hono } from 'hono'

export const healthRoute = new Hono()

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
