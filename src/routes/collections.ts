import { Hono } from 'hono'
import { z } from 'zod'
import { authorOf, isCollectionAllowed, ownerUserIdOf } from '../auth/adapter'
import type { AppEnv, AuthContext } from '../auth/adapter'

// Validation schemas
const createCollectionSchema = z.object({
  name: z.string().min(1),
  parent_id: z.string().optional(),
  description: z.string().optional(),
  is_system: z.boolean().optional(),
  entrypoint_doc_id: z.string().optional(),
})

const updateCollectionSchema = z.object({
  name: z.string().min(1).optional(),
  parent_id: z.string().optional(),
  description: z.string().optional(),
  entrypoint_doc_id: z.string().optional(),
})

export const collectionsRoute = new Hono<AppEnv>()

// Helper: Generate unique ID
const generateId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

// Helper: Build tree structure from flat list
export const buildTree = (collections: any[], parentId: string | null = null): any[] => {
  return collections
    .filter((c: any) => c.parent_id === parentId)
    .map((c: any) => ({
      ...c,
      children: buildTree(collections, c.id)
    }))
}

// GET /collections - List collections (tree structure)
collectionsRoute.get('/', async (c) => {
  const auth = c.get('auth')
  const uid = ownerUserIdOf(auth)

  const result = await c.env.DB.prepare(`
    SELECT id, name, parent_id, description, is_system, entrypoint_doc_id,
           created_by_type, updated_by_type, created_at, updated_at
    FROM collections
    WHERE owner_user_id = ?
    ORDER BY name
  `).bind(uid).all()

  // Restricted API keys only see their allowed collections (flat list, no tree)
  if (auth.authorType === 'ai' && auth.allowedCollections !== null) {
    const visible = result.results.filter((col: any) => isCollectionAllowed(auth, col.id))
    return c.json(visible.map((col: any) => ({ ...col, children: [] })))
  }

  // Build tree structure
  const tree = buildTree(result.results)

  return c.json(tree)
})

// Helper: collection のオーナーチェック（DBアクセスあり）
// returns collection row (without owner_user_id) or null when not found/not owned
const loadOwnedCollection = async (db: D1Database, auth: AuthContext, id: string): Promise<any | null> => {
  const uid = ownerUserIdOf(auth)
  const col = await db.prepare('SELECT * FROM collections WHERE id = ? AND owner_user_id = ?')
    .bind(id, uid).first() as any
  return col ?? null
}

// GET /collections/:id - Get collection
collectionsRoute.get('/:id', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')

  const collection = await loadOwnedCollection(c.env.DB, auth, id)
  if (!collection) {
    return c.json({ error: { code: 'COLLECTION_NOT_FOUND', message: 'Collection not found' } }, 404)
  }
  if (!isCollectionAllowed(auth, id)) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Collection not allowed for this API key' } }, 403)
  }

  return c.json(collection)
})

// GET /collections/:id/entrypoint - Get entry point document
collectionsRoute.get('/:id/entrypoint', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')

  const collection = await loadOwnedCollection(c.env.DB, auth, id) as any
  if (!collection) {
    return c.json({ error: { code: 'COLLECTION_NOT_FOUND', message: 'Collection not found' } }, 404)
  }
  if (!isCollectionAllowed(auth, id)) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Collection not allowed for this API key' } }, 403)
  }

  if (!collection.entrypoint_doc_id) {
    return c.json({ error: { code: 'NO_ENTRYPONT', message: 'No entry point document set' } }, 404)
  }

  const doc = await c.env.DB.prepare(`
    SELECT * FROM documents WHERE id = ?
  `).bind(collection.entrypoint_doc_id).first()

  if (!doc) {
    return c.json({ error: { code: 'DOC_NOT_FOUND', message: 'Entry point document not found' } }, 404)
  }

  return c.json(doc)
})

// GET /collections/:id/export - Export collection (flatten)
collectionsRoute.get('/:id/export', async (c) => {
  // const id = c.req.param('id')
  // const format = c.req.query('format') || 'text'
  // const flatten = c.req.query('flatten') === 'true'

  // TODO: Implement export logic
  return c.json({ error: { code: 'NOT_IMPLEMENTED', message: 'Export not yet implemented' } }, 501)
})

// POST /collections - Create collection
collectionsRoute.post('/', async (c) => {
  try {
    const auth = c.get('auth')
    const contentType = c.req.header('Content-Type') || ''
    let body: any

    if (contentType.includes('application/json')) {
      body = await c.req.json()
    } else {
      body = await c.req.parseBody()
    }

    const parsed = createCollectionSchema.parse(body)

    // Collection-restricted API keys cannot create new collections
    if (auth.authorType === 'ai' && auth.allowedCollections !== null) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'This API key cannot create collections' } }, 403)
    }

    const author = authorOf(auth)
    const uid = ownerUserIdOf(auth)
    const id = generateId('col')
    const now = Date.now()

    await c.env.DB.prepare(`
      INSERT INTO collections (
        id, name, parent_id, description, is_system, entrypoint_doc_id, owner_user_id,
        created_by_type, created_by_key_id, updated_by_type, updated_by_key_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      parsed.name,
      parsed.parent_id || null,
      parsed.description || null,
      parsed.is_system ? 1 : 0,
      parsed.entrypoint_doc_id || null,
      uid,
      author.authorType,
      author.apiKeyId,
      author.authorType,
      author.apiKeyId,
      now,
      now
    ).run()

    const accept = c.req.header('Accept') || ''
    if (accept.includes('text/html')) {
      // Return fresh collections list for HTMX
      return c.redirect('/collections/html')
    }

    const collection = await c.env.DB.prepare('SELECT * FROM collections WHERE id = ?').bind(id).first()
    return c.json(collection, 201)
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: error.errors } }, 400)
    }
    console.error('Error creating collection:', error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create collection' } }, 500)
  }
})

// PATCH /collections/:id - Update collection
collectionsRoute.patch('/:id', async (c) => {
  const id = c.req.param('id')

  try {
    const auth = c.get('auth')
    const body = await c.req.json()
    const parsed = updateCollectionSchema.parse(body)

    const existing = await loadOwnedCollection(c.env.DB, auth, id)
    if (!existing) {
      return c.json({ error: { code: 'COLLECTION_NOT_FOUND', message: 'Collection not found' } }, 404)
    }
    if (!isCollectionAllowed(auth, id)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Collection not allowed for this API key' } }, 403)
    }

    const author = authorOf(auth)
    const now = Date.now()
    const updates: string[] = ['updated_at = ?', 'updated_by_type = ?', 'updated_by_key_id = ?']
    const params: any[] = [now, author.authorType, author.apiKeyId]

    if (parsed.name !== undefined) {
      updates.push('name = ?')
      params.push(parsed.name)
    }
    if (parsed.description !== undefined) {
      updates.push('description = ?')
      params.push(parsed.description)
    }
    if (parsed.parent_id !== undefined) {
      updates.push('parent_id = ?')
      params.push(parsed.parent_id)
    }
    if (parsed.entrypoint_doc_id !== undefined) {
      updates.push('entrypoint_doc_id = ?')
      params.push(parsed.entrypoint_doc_id)
    }

    params.push(id)

    await c.env.DB.prepare(`
      UPDATE collections SET ${updates.join(', ')} WHERE id = ?
    `).bind(...params).run()

    const updated = await c.env.DB.prepare('SELECT * FROM collections WHERE id = ?').bind(id).first()
    return c.json(updated)
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: error.errors } }, 400)
    }
    console.error('Error updating collection:', error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update collection' } }, 500)
  }
})

// DELETE /collections/:id - Delete collection
collectionsRoute.delete('/:id', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')

  const existing = await loadOwnedCollection(c.env.DB, auth, id)
  if (!existing) {
    return c.json({ error: { code: 'COLLECTION_NOT_FOUND', message: 'Collection not found' } }, 404)
  }
  if (!isCollectionAllowed(auth, id)) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Collection not allowed for this API key' } }, 403)
  }

  // Check if collection has documents
  const docsCount = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM documents WHERE collection_id = ?'
  ).bind(id).first() as any

  if (docsCount.count > 0) {
    return c.json({
      error: { code: 'COLLECTION_NOT_EMPTY', message: 'Cannot delete collection with documents' }
    }, 400)
  }

  // Check if collection has children
  const childrenCount = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM collections WHERE parent_id = ?'
  ).bind(id).first() as any

  if (childrenCount.count > 0) {
    return c.json({
      error: { code: 'COLLECTION_HAS_CHILDREN', message: 'Cannot delete collection with sub-collections' }
    }, 400)
  }

  await c.env.DB.prepare('DELETE FROM collections WHERE id = ? AND owner_user_id = ?')
    .bind(id, ownerUserIdOf(auth)).run()

  return c.json({ success: true, id })
})
