import { Hono } from 'hono'
import { z } from 'zod'
import { isCollectionAllowed, ownerUserIdOf } from '../auth/adapter'
import type { AppEnv, AuthContext } from '../auth/adapter'
import { extractSection, findSection, parseSections, replaceSection } from '../services/sections'
import { createDocument, updateDocument } from '../services/revisions'
import { escapeHtml } from '../services/markdown'

// Validation schemas
const MAX_DOC_CONTENT = 1_000_000 // 1 MB

const createDocSchema = z.object({
  title: z.string().min(1),
  content: z.string().max(MAX_DOC_CONTENT),
  collection_id: z.string(),
  parent_id: z.string().optional(),
  priority: z.enum(['high', 'normal', 'archive']).optional(),
  status: z.enum(['published', 'archived']).optional(),
})


const updateDocSchema = z.object({
  title: z.string().min(1).optional(),
  content: z.string().max(MAX_DOC_CONTENT).optional(),
  priority: z.enum(['high', 'normal', 'archive']).optional(),
  status: z.enum(['published', 'archived']).optional(),
  expected_version: z.number().int().optional(),
})

const updateSectionSchema = z.object({
  content: z.string().max(MAX_DOC_CONTENT),
  title: z.string().min(1).optional(),
  expected_version: z.number().int().optional(),
})

const appendSchema = z.object({
  content: z.string().min(1).max(MAX_DOC_CONTENT),
  expected_version: z.number().int().optional(),
})

export const documentsRoute = new Hono<AppEnv>()

// Helper: Generate unique ID
const generateId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

// Helper: Load a document and check collection access + ownership.
// Returns the doc row, or a Response when not found / forbidden.
// マルチテナント: collections.owner_user_id が認証ユーザーと一致することを確認
const loadDoc = async (c: any, id: string): Promise<{ doc: any } | { response: Response }> => {
  const auth = c.get('auth') as AuthContext
  const uid = ownerUserIdOf(auth)
  const doc = await c.env.DB.prepare(`
    SELECT d.*, c.owner_user_id
    FROM documents d JOIN collections c ON d.collection_id = c.id
    WHERE d.id = ?
  `).bind(id).first() as any
  if (!doc) {
    return { response: c.json({ error: { code: 'DOC_NOT_FOUND', message: 'Document not found' } }, 404) }
  }
  if (doc.owner_user_id !== uid) {
    return { response: c.json({ error: { code: 'FORBIDDEN', message: 'Document not owned by this user' } }, 403) }
  }
  if (!isCollectionAllowed(auth, doc.collection_id)) {
    return { response: c.json({ error: { code: 'FORBIDDEN', message: 'Collection not allowed for this API key' } }, 403) }
  }
  // owner_user_id は外部キー用に残すが、レスポンスでは取り除く
  delete doc.owner_user_id
  return { doc }
}

// Helper: Build path from parent
const buildPath = async (db: D1Database, parentId: string | null, collectionId: string, docId: string, ownerUserId: string): Promise<string> => {
  if (!parentId) {
    return `/${collectionId}/${docId}`
  }

  const parent = await db.prepare(`
    SELECT d.path FROM documents d JOIN collections c ON d.collection_id = c.id
    WHERE d.id = ? AND c.owner_user_id = ?
  `).bind(parentId, ownerUserId).first() as { path: string } | null

  if (!parent) {
    throw new Error('Parent document not found')
  }

  return `${parent.path}/${docId}`
}

// GET /docs - List documents (meta only)
documentsRoute.get('/', async (c) => {
  const auth = c.get('auth')
  const uid = ownerUserIdOf(auth)
  const collectionId = c.req.query('collection')
  const parentId = c.req.query('parent')
  const priority = c.req.query('priority')
  const limit = parseInt(c.req.query('limit') || '20')
  const cursor = c.req.query('cursor')

  let query = `SELECT d.id, d.title, d.collection_id, d.parent_id, d.path, d.priority, d.status, d.created_at, d.updated_at
    FROM documents d JOIN collections c ON d.collection_id = c.id
    WHERE d.status = ? AND c.owner_user_id = ?`
  const params: any[] = ['published', uid]

  if (collectionId) {
    if (!isCollectionAllowed(auth, collectionId)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Collection not allowed for this API key' } }, 403)
    }
    query += ' AND d.collection_id = ?'
    params.push(collectionId)
  } else if (auth.authorType === 'ai' && auth.allowedCollections !== null) {
    if (auth.allowedCollections.length === 0) {
      return c.json({ data: [], next_cursor: null, has_more: false })
    }
    query += ` AND d.collection_id IN (${auth.allowedCollections.map(() => '?').join(', ')})`
    params.push(...auth.allowedCollections)
  }

  // parent= (empty) means "root documents only"
  if (parentId !== undefined) {
    if (parentId === '') {
      query += ' AND parent_id IS NULL'
    } else {
      query += ' AND parent_id = ?'
      params.push(parentId)
    }
  }

  if (priority) {
    query += ' AND priority = ?'
    params.push(priority)
  }

  // Cursor matches the sort order (updated_at DESC, id DESC): "updatedAt:id"
  if (cursor) {
    const sep = cursor.lastIndexOf(':')
    const cursorUpdatedAt = parseInt(cursor.slice(0, sep))
    const cursorId = cursor.slice(sep + 1)
    query += ' AND (updated_at < ? OR (updated_at = ? AND id < ?))'
    params.push(cursorUpdatedAt, cursorUpdatedAt, cursorId)
  }

  query += ' ORDER BY updated_at DESC, id DESC LIMIT ?'
  params.push(limit + 1) // Fetch one extra to determine if there are more

  const result = await c.env.DB.prepare(query).bind(...params).all()

  const docs = result.results.slice(0, limit)
  const hasMore = result.results.length > limit
  const last = docs[docs.length - 1] as any
  const nextCursor = hasMore ? `${last.updated_at}:${last.id}` : null

  return c.json({
    data: docs,
    next_cursor: nextCursor,
    has_more: hasMore
  })
})

// GET /docs/:id - Get document
documentsRoute.get('/:id', async (c) => {
  const id = c.req.param('id')
  const view = c.req.query('view') || 'full'

  const loaded = await loadDoc(c, id)
  if ('response' in loaded) return loaded.response
  const doc = loaded.doc

  if (view === 'meta') {
    const sections = parseSections(doc.content).map((s) => ({
      slug: s.slug,
      title: s.title,
      level: s.level,
    }))

    return c.json({
      id: doc.id,
      title: doc.title,
      collection_id: doc.collection_id,
      parent_id: doc.parent_id,
      path: doc.path,
      priority: doc.priority,
      status: doc.status,
      sections,
      created_at: doc.created_at,
      updated_at: doc.updated_at
    })
  }

  if (view === 'outline') {
    const outline = parseSections(doc.content).map((s) => ({
      slug: s.slug,
      title: s.title,
      level: s.level,
    }))

    return c.json({ outline })
  }

  // view === 'full' (default)
  return c.json(doc)
})

// GET /docs/:id/sections/:slug - Get a single section (heading included)
documentsRoute.get('/:id/sections/:slug', async (c) => {
  const id = c.req.param('id')
  const slug = c.req.param('slug')

  const loaded = await loadDoc(c, id)
  if ('response' in loaded) return loaded.response
  const doc = loaded.doc

  const section = findSection(doc.content, slug)
  if (!section) {
    return c.json({ error: { code: 'SECTION_NOT_FOUND', message: 'Section not found' } }, 404)
  }

  return c.json({
    document_id: doc.id,
    slug: section.slug,
    title: section.title,
    level: section.level,
    content: extractSection(doc.content, section),
  })
})

// PATCH /docs/:id/sections/:slug - Replace a section body (and optionally rename it)
// body: { content: "text below the heading", title?: "new heading text" }
documentsRoute.patch('/:id/sections/:slug', async (c) => {
  const id = c.req.param('id')
  const slug = c.req.param('slug')

  try {
    const body = await c.req.json()
    const parsed = updateSectionSchema.parse(body)

    const loaded = await loadDoc(c, id)
    if ('response' in loaded) return loaded.response
    const doc = loaded.doc

    const section = findSection(doc.content, slug)
    if (!section) {
      return c.json({ error: { code: 'SECTION_NOT_FOUND', message: 'Section not found' } }, 404)
    }

    const newContent = replaceSection(doc.content, section, parsed.content, parsed.title)
    const now = Date.now()
    const expectedVersion = parsed.expected_version ?? doc.version
    const result = await updateDocument(
      c.env.DB,
      c.get('auth'),
      id,
      { title: doc.title, content: doc.content, version: doc.version },
      { content: newContent },
      expectedVersion,
      now
    )
    if (!result.ok) {
      if (result.code === 'NOT_FOUND') {
        return c.json({ error: { code: 'DOC_NOT_FOUND', message: 'Document not found' } }, 404)
      }
      return c.json({ error: { code: 'CONFLICT', message: 'Document was modified by another request; please refresh and retry' } }, 409)
    }

    // The slug may change when the heading is renamed; re-locate by line
    const newSection = parseSections(newContent).find((s) => s.headingLine === section.headingLine)
    return c.json({
      document_id: id,
      slug: newSection?.slug ?? slug,
      updated_at: now,
      ...(result.warnings.length > 0 ? { link_warnings: result.warnings } : {}),
    })
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: error.errors } }, 400)
    }
    console.error('Error updating section:', error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update section' } }, 500)
  }
})

// POST /docs/:id/append - Append to the end of the document
documentsRoute.post('/:id/append', async (c) => {
  const id = c.req.param('id')

  try {
    const body = await c.req.json()
    const parsed = appendSchema.parse(body)

    const loaded = await loadDoc(c, id)
    if ('response' in loaded) return loaded.response
    const doc = loaded.doc

    const separator = doc.content === '' || doc.content.endsWith('\n\n') ? '' : doc.content.endsWith('\n') ? '\n' : '\n\n'
    const newContent = doc.content + separator + parsed.content
    const now = Date.now()
    const expectedVersion = parsed.expected_version ?? doc.version
    const result = await updateDocument(
      c.env.DB,
      c.get('auth'),
      id,
      { title: doc.title, content: doc.content, version: doc.version },
      { content: newContent },
      expectedVersion,
      now
    )
    if (!result.ok) {
      if (result.code === 'NOT_FOUND') {
        return c.json({ error: { code: 'DOC_NOT_FOUND', message: 'Document not found' } }, 404)
      }
      return c.json({ error: { code: 'CONFLICT', message: 'Document was modified by another request; please refresh and retry' } }, 409)
    }

    return c.json({
      document_id: id,
      appended_bytes: parsed.content.length,
      updated_at: now,
      ...(result.warnings.length > 0 ? { link_warnings: result.warnings } : {}),
    })
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: error.errors } }, 400)
    }
    console.error('Error appending to document:', error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to append' } }, 500)
  }
})

// GET /docs/:id/history - List revisions (meta only, newest first)
documentsRoute.get('/:id/history', async (c) => {
  const id = c.req.param('id')
  const limit = parseInt(c.req.query('limit') || '20')
  const cursor = c.req.query('cursor')
  const accept = c.req.header('Accept') || ''

  const loaded = await loadDoc(c, id)
  if ('response' in loaded) return loaded.response

  let query = `
    SELECT id, title, author_type, api_key_id, api_key_name, created_at, length(content) AS content_bytes
    FROM document_revisions WHERE document_id = ?
  `
  const params: any[] = [id]

  if (cursor) {
    query += ' AND created_at < ?'
    params.push(parseInt(cursor))
  }

  query += ' ORDER BY created_at DESC LIMIT ?'
  params.push(limit + 1)

  const result = await c.env.DB.prepare(query).bind(...params).all()

  const revisions = result.results.slice(0, limit)
  const hasMore = result.results.length > limit

  // Return HTML for HTMX requests
  if (accept.includes('text/html')) {
    let html = '<ul class="plain">\n'
    for (const rev of revisions as any[]) {
      html += `  <li>\n`
      html += `    <span>${new Date(rev.created_at).toLocaleString()}</span>\n`
      html += `    <span class="tag">${escapeHtml(rev.author_type)}${rev.api_key_name ? ': ' + escapeHtml(rev.api_key_name) : ''}</span>\n`
      html += `    <span class="muted">${rev.content_bytes} bytes</span>\n`
      html += `  </li>\n`
    }
    if (revisions.length === 0) {
      html += '  <li class="muted">履歴がありません</li>\n'
    }
    html += '</ul>\n'
    return c.html(html)
  }

  return c.json({
    data: revisions,
    next_cursor: hasMore ? String((revisions[revisions.length - 1] as any).created_at) : null,
    has_more: hasMore,
  })
})

// GET /docs/:id/history/:rev - Get a specific revision (full content)
documentsRoute.get('/:id/history/:rev', async (c) => {
  const id = c.req.param('id')
  const rev = c.req.param('rev')

  const loaded = await loadDoc(c, id)
  if ('response' in loaded) return loaded.response

  const revision = await c.env.DB.prepare(
    'SELECT * FROM document_revisions WHERE id = ? AND document_id = ?'
  ).bind(rev, id).first()

  if (!revision) {
    return c.json({ error: { code: 'REVISION_NOT_FOUND', message: 'Revision not found' } }, 404)
  }

  return c.json(revision)
})

// POST /docs - Create document
documentsRoute.post('/', async (c) => {
  try {
    const auth = c.get('auth')
    const contentType = c.req.header('Content-Type') || ''
    let body: any

    if (contentType.includes('application/json')) {
      body = await c.req.json()
    } else {
      body = await c.req.parseBody()
    }

    // Default content if not provided
    if (body.content === undefined) {
      body.content = ''
    }

    const parsed = createDocSchema.parse(body)

    // マルチテナント: collection のオーナーが認証ユーザーと一致することを確認
    const uid = ownerUserIdOf(auth)
    const col = await c.env.DB.prepare('SELECT id FROM collections WHERE id = ? AND owner_user_id = ?')
      .bind(parsed.collection_id, uid).first()
    if (!col) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Collection not found or not owned by this user' } }, 403)
    }
    if (!isCollectionAllowed(auth, parsed.collection_id)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Collection not allowed for this API key' } }, 403)
    }

    const id = generateId('doc')
    const now = Date.now()

    // Build path
    const path = await buildPath(c.env.DB, parsed.parent_id || null, parsed.collection_id, id, uid)

    // Create document + initial revision + links atomically
    const { warnings: linkWarnings } = await createDocument(
      c.env.DB, auth, id, parsed.title, parsed.content, parsed.collection_id, parsed.parent_id || null, path, now
    )

    const accept = c.req.header('Accept') || ''
    if (accept.includes('text/html')) {
      // Return a script to redirect to the new document's page
      return c.html(`<script>window.location.href="/doc.html?id=${id}";</script>`)
    }

    const doc = await c.env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first()

    return c.json(linkWarnings.length > 0 ? { ...doc, link_warnings: linkWarnings } : doc, 201)
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: error.errors } }, 400)
    }
    console.error('Error creating document:', error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create document' } }, 500)
  }
})

// PUT /docs/:id - Update entire document
documentsRoute.put('/:id', async (c) => {
  const id = c.req.param('id')

  try {
    const auth = c.get('auth')
    const contentType = c.req.header('Content-Type') || ''
    let body: any

    if (contentType.includes('application/json')) {
      body = await c.req.json()
    } else {
      body = await c.req.parseBody()
    }

    const parsed = updateDocSchema.parse(body)

    // マルチテナント: documents を collections 経由でオーナーチェック
    const uid = ownerUserIdOf(auth)
    const existing = await c.env.DB.prepare(`
      SELECT d.* FROM documents d JOIN collections c ON d.collection_id = c.id
      WHERE d.id = ? AND c.owner_user_id = ?
    `).bind(id, uid).first() as any
    if (!existing) {
      return c.json({ error: { code: 'DOC_NOT_FOUND', message: 'Document not found' } }, 404)
    }

    if (!isCollectionAllowed(auth, existing.collection_id)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Collection not allowed for this API key' } }, 403)
    }

    const now = Date.now()
    const expectedVersion = parsed.expected_version ?? existing.version
    const result = await updateDocument(
      c.env.DB,
      auth,
      id,
      { title: existing.title, content: existing.content, version: existing.version },
      {
        title: parsed.title,
        content: parsed.content,
        priority: parsed.priority,
        status: parsed.status,
      },
      expectedVersion,
      now
    )
    if (!result.ok) {
      if (result.code === 'NOT_FOUND') {
        return c.json({ error: { code: 'DOC_NOT_FOUND', message: 'Document not found' } }, 404)
      }
      return c.json({ error: { code: 'CONFLICT', message: 'Document was modified by another request; please refresh and retry' } }, 409)
    }

    const updated = await c.env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first()
    const accept = c.req.header('Accept') || ''

    // Return HTML for HTMX requests
    if (accept.includes('text/html')) {
      return c.html('<script>alert("保存しました"); window.location.reload();</script>')
    }

    return c.json(result.warnings.length > 0 ? { ...updated, link_warnings: result.warnings } : updated)
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: error.errors } }, 400)
    }
    console.error('Error updating document:', error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update document' } }, 500)
  }
})

// DELETE /docs/:id - Delete document
documentsRoute.delete('/:id', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')

  // マルチテナント: documents を collections 経由でオーナーチェック
  const uid = ownerUserIdOf(auth)
  const existing = await c.env.DB.prepare(`
    SELECT d.id, d.collection_id FROM documents d JOIN collections c ON d.collection_id = c.id
    WHERE d.id = ? AND c.owner_user_id = ?
  `).bind(id, uid).first() as any
  if (!existing) {
    return c.json({ error: { code: 'DOC_NOT_FOUND', message: 'Document not found' } }, 404)
  }

  if (!isCollectionAllowed(auth, existing.collection_id)) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Collection not allowed for this API key' } }, 403)
  }

  await c.env.DB.batch([
    // Orphan children: keep them but detach from the deleted parent.
    // Matches the ON DELETE SET NULL constraint in schema.sql (which applies
    // to fresh D1 instances; this statement also covers existing prod D1
    // where the constraint has not yet been applied via migration).
    c.env.DB.prepare('UPDATE documents SET parent_id = NULL WHERE parent_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM document_links WHERE from_doc_id = ? OR to_doc_id = ?').bind(id, id),
    c.env.DB.prepare('DELETE FROM documents WHERE id = ?').bind(id),
  ])

  const accept = c.req.header('Accept') || ''

  // Return HTML for HTMX requests
  if (accept.includes('text/html')) {
    return c.html('<script>window.location.href="/";</script>')
  }

  return c.json({ success: true, id })
})

// GET /docs/:id/links - Outgoing links
documentsRoute.get('/:id/links', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')

  const loaded = await loadDoc(c, id)
  if ('response' in loaded) return loaded.response

  const result = await c.env.DB.prepare(`
    SELECT d.id, d.title, d.collection_id, d.path, l.created_at AS linked_at
    FROM document_links l
    JOIN documents d ON d.id = l.to_doc_id
    WHERE l.from_doc_id = ?
    ORDER BY l.created_at
  `).bind(id).all()

  // Hide targets in collections this key cannot access
  const links = result.results.filter((r: any) => isCollectionAllowed(auth, r.collection_id))

  return c.json({ data: links })
})

// GET /docs/:id/backlinks - Incoming links (which documents reference this one)
documentsRoute.get('/:id/backlinks', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')

  const loaded = await loadDoc(c, id)
  if ('response' in loaded) return loaded.response

  const result = await c.env.DB.prepare(`
    SELECT d.id, d.title, d.collection_id, d.path, l.created_at AS linked_at
    FROM document_links l
    JOIN documents d ON d.id = l.from_doc_id
    WHERE l.to_doc_id = ?
    ORDER BY l.created_at
  `).bind(id).all()

  const backlinks = result.results.filter((r: any) => isCollectionAllowed(auth, r.collection_id))

  return c.json({ data: backlinks })
})
