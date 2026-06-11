import { Hono } from 'hono'
import type { AppEnv } from '../auth/adapter'

export const meRoute = new Hono<AppEnv>()

// GET /me/entrypoint - Entry point document bound to the calling API key
meRoute.get('/entrypoint', async (c) => {
  const auth = c.get('auth')

  if (auth.authorType !== 'ai') {
    return c.json({ error: { code: 'NOT_API_KEY', message: 'This endpoint is for API key clients' } }, 400)
  }

  if (!auth.entryDocId) {
    return c.json({ error: { code: 'NO_ENTRYPOINT', message: 'No entry point document set for this key' } }, 404)
  }

  const doc = await c.env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(auth.entryDocId).first()
  if (!doc) {
    return c.json({ error: { code: 'DOC_NOT_FOUND', message: 'Entry point document not found' } }, 404)
  }

  return c.json(doc)
})
