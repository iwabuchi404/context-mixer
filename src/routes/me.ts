import { Hono } from 'hono'
import { ownerUserIdOf } from '../auth/adapter'
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

  // マルチテナント: collections 経由でオーナーチェック
  const uid = ownerUserIdOf(auth)
  const doc = await c.env.DB.prepare(`
    SELECT d.* FROM documents d JOIN collections c ON d.collection_id = c.id
    WHERE d.id = ? AND c.owner_user_id = ?
  `).bind(auth.entryDocId, uid).first()
  if (!doc) {
    return c.json({ error: { code: 'DOC_NOT_FOUND', message: 'Entry point document not found' } }, 404)
  }

  return c.json(doc)
})
