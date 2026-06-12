// Entrypoint endpoints.
// Returns a structured overview for AI agents to start exploring.
import { Hono } from 'hono'
import { isCollectionAllowed } from '../auth/adapter'
import type { AppEnv } from '../auth/adapter'

export const entrypointRoute = new Hono<AppEnv>()

// GET /entrypoint - Workspace-wide entry point
// Returns a structured overview of the workspace for AI agents
entrypointRoute.get('/', async (c) => {
  const auth = c.get('auth')

  // Get all collections this auth context can access
  let collections: any[] = []

  if (auth.authorType === 'ai' && auth.allowedCollections !== null) {
    // AI key with restricted collections
    if (auth.allowedCollections.length > 0) {
      const placeholders = auth.allowedCollections.map(() => '?').join(', ')
      const result = await c.env.DB.prepare(`
        SELECT id, name, description, parent_id, entrypoint_doc_id
        FROM collections
        WHERE id IN (${placeholders})
        ORDER BY name
      `).bind(...auth.allowedCollections).all()
      collections = result.results
    }
  } else {
    // Human or unrestricted AI key
    const result = await c.env.DB.prepare(`
      SELECT id, name, description, parent_id, entrypoint_doc_id
      FROM collections
      ORDER BY name
    `).all()
    collections = result.results
  }

  // Build tree structure
  const buildTree = (parentId: string | null): any[] => {
    return collections
      .filter((c: any) => c.parent_id === parentId)
      .map((c: any) => ({
        ...c,
        children: buildTree(c.id),
      }))
  }

  const tree = buildTree(null)

  // Get recent documents (up to 10)
  let recentDocs: any[] = []

  if (auth.authorType === 'ai' && auth.allowedCollections !== null) {
    if (auth.allowedCollections.length > 0) {
      const placeholders = auth.allowedCollections.map(() => '?').join(', ')
      const result = await c.env.DB.prepare(`
        SELECT id, title, collection_id, updated_at
        FROM documents
        WHERE status = 'published' AND collection_id IN (${placeholders})
        ORDER BY updated_at DESC
        LIMIT 10
      `).bind(...auth.allowedCollections).all()
      recentDocs = result.results
    }
  } else {
    const result = await c.env.DB.prepare(`
      SELECT id, title, collection_id, updated_at
      FROM documents
      WHERE status = 'published'
      ORDER BY updated_at DESC
      LIMIT 10
    `).all()
    recentDocs = result.results
  }

  return c.json({
    collections: tree,
    recent_documents: recentDocs,
  })
})

// GET /collections/:id/entrypoint - Collection-specific entry point
// Returns the entry point document for a collection
entrypointRoute.get('/collections/:id', async (c) => {
  const auth = c.get('auth')
  const collectionId = c.req.param('id')

  // Check collection access
  if (!isCollectionAllowed(auth, collectionId)) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Collection not allowed for this API key' } }, 403)
  }

  // Get collection
  const collection = await c.env.DB.prepare('SELECT * FROM collections WHERE id = ?').bind(collectionId).first() as any
  if (!collection) {
    return c.json({ error: { code: 'COLLECTION_NOT_FOUND', message: 'Collection not found' } }, 404)
  }

  // Get entry point document if set
  let entrypointDoc = null
  if (collection.entrypoint_doc_id) {
    entrypointDoc = await c.env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(collection.entrypoint_doc_id).first() as any
  }

  // If no entry point is set, return a basic overview
  if (!entrypointDoc) {
    // Get child collections
    const childCollections = await c.env.DB.prepare(`
      SELECT id, name, description
      FROM collections
      WHERE parent_id = ?
      ORDER BY name
    `).bind(collectionId).all()

    // Get recent documents in this collection
    const recentDocs = await c.env.DB.prepare(`
      SELECT id, title, updated_at
      FROM documents
      WHERE collection_id = ? AND status = 'published'
      ORDER BY updated_at DESC
      LIMIT 10
    `).bind(collectionId).all()

    return c.json({
      collection: {
        id: collection.id,
        name: collection.name,
        description: collection.description,
      },
      child_collections: childCollections.results,
      recent_documents: recentDocs.results,
    })
  }

  return c.json({
    collection: {
      id: collection.id,
      name: collection.name,
      description: collection.description,
    },
    entrypoint_document: entrypointDoc,
  })
})
