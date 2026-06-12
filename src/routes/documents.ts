import { Hono } from 'hono'
import { z } from 'zod'
import { authorOf, isCollectionAllowed } from '../auth/adapter'
import type { AppEnv } from '../auth/adapter'
import { extractSection, findSection, parseSections, replaceSection } from '../services/sections'
import { syncDocumentLinks } from '../services/links'

// Validation schemas
const createDocSchema = z.object({
  title: z.string().min(1),
  content: z.string(),
  collection_id: z.string(),
  parent_id: z.string().optional(),
  priority: z.enum(['high', 'normal', 'archive']).optional(),
  status: z.enum(['published', 'archived']).optional(),
})


const updateDocSchema = z.object({
  title: z.string().min(1).optional(),
  content: z.string().optional(),
  priority: z.enum(['high', 'normal', 'archive']).optional(),
  status: z.enum(['published', 'archived']).optional(),
})

const updateSectionSchema = z.object({
  content: z.string(),
  title: z.string().min(1).optional(),
})

const appendSchema = z.object({
  content: z.string().min(1),
})

export const documentsRoute = new Hono<AppEnv>()

// GET /docs/edit - Get document edit form (for HTMX)
documentsRoute.get('/edit', async (c) => {
  const id = c.req.query('id')
  if (!id) {
    return c.html('<p class="error">ドキュメントIDが指定されていません</p>', 400)
  }

  const doc = await c.env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first() as any
  if (!doc) {
    return c.html('<p class="error">ドキュメントが見つかりません</p>', 404)
  }

  const sections = parseSections(doc.content)

  // Get links and backlinks
  const [linksResult, backlinksResult] = await Promise.all([
    c.env.DB.prepare(`
      SELECT d.id, d.title
      FROM document_links l
      JOIN documents d ON d.id = l.to_doc_id
      WHERE l.from_doc_id = ?
      ORDER BY d.title
    `).bind(id).all(),
    c.env.DB.prepare(`
      SELECT d.id, d.title
      FROM document_links l
      JOIN documents d ON d.id = l.from_doc_id
      WHERE l.to_doc_id = ?
      ORDER BY d.title
    `).bind(id).all(),
  ])

  let html = `
    <div style="display: flex; align-items: baseline; gap: var(--space-4); margin-bottom: var(--space-6)">
      <input type="text" id="title" name="title" value="${doc.title}" class="input" style="font-size: 1.8rem; font-weight: 700; border:none; background:transparent; padding:0; height:auto">
      <div class="spacer"></div>
      <button id="toggle-btn" class="btn" onclick="toggleMode()">Preview</button>
      <button class="btn-primary" hx-put="/docs/${id}" hx-include="#title,#content">Save Changes</button>
    </div>

    <div class="doc-layout">
      <!-- Main Editor -->
      <div class="doc-main">
        <div id="edit-section">
          <textarea id="content" name="content" class="textarea editor" oninput="renderPreview()">${doc.content}</textarea>
        </div>
        <div id="preview-section" style="display:none">
          <article id="preview" class="prose" style="background: var(--surface); padding: var(--space-6); border: 1px solid var(--border); border-radius: var(--radius-md)"></article>
        </div>
      </div>

      <!-- Sidebar: Meta & Outline -->
      <aside class="doc-aside">
        <div class="doc-meta-card">
          <h3>Information</h3>
          <div class="muted" style="font-size: var(--text-xs); line-height: 1.8">
            <div style="display:flex; justify-content:space-between"><span>ID</span><code style="font-size:10px">${doc.id}</code></div>
            <div style="display:flex; justify-content:space-between"><span>Priority</span><span class="badge" style="background:${doc.priority === 'high' ? 'var(--danger)' : 'var(--border)'}">${doc.priority}</span></div>
            <div style="display:flex; justify-content:space-between"><span>Status</span><span>${doc.status}</span></div>
            <div style="display:flex; justify-content:space-between"><span>Updated</span><span>${new Date(doc.updated_at).toLocaleDateString()}</span></div>
          </div>
          
          <hr style="border:0; border-top:1px solid var(--border); margin: var(--space-4) 0">
          
          <h3>Outline</h3>
          <nav class="tree">
  `

  if (sections.length > 0) {
    for (const s of sections) {
      const indent = (s.level - 1) * 12
      html += `<a href="#" class="tree-item" onclick="scrollToSection('${s.slug}')" style="padding-left:${indent + 8}px; font-size:var(--text-xs)">${s.title}</a>`
    }
  } else {
    html += '<div class="muted" style="padding:0 var(--space-2)">No headings found</div>'
  }

  html += `
          </nav>
        </div>
  `

  if (linksResult.results.length > 0 || backlinksResult.results.length > 0) {
    html += '<div class="doc-meta-card"><h3>Links</h3>'
    if (linksResult.results.length > 0) {
      html += '<div class="muted" style="font-size:10px; font-weight:700; margin-bottom:4px">LINKS</div><nav class="tree" style="margin-bottom:var(--space-4)">'
      for (const link of linksResult.results) {
        html += `<a href="/doc.html?id=${link.id}" class="tree-item" style="font-size:var(--text-xs)">${link.title}</a>`
      }
      html += '</nav>'
    }
    if (backlinksResult.results.length > 0) {
      html += '<div class="muted" style="font-size:10px; font-weight:700; margin-bottom:4px">BACKLINKS</div><nav class="tree">'
      for (const link of backlinksResult.results) {
        html += `<a href="/doc.html?id=${link.id}" class="tree-item" style="font-size:var(--text-xs)">${link.title}</a>`
      }
      html += '</nav>'
    }
    html += '</div>'
  }

  html += `
        <div class="doc-meta-card">
          <h3>History</h3>
          <div hx-get="/docs/${id}/history" hx-trigger="load" hx-headers='{"Accept": "text/html"}'>
            <p class="muted">Loading...</p>
          </div>
        </div>

        <button class="btn btn-danger" style="width:100%; justify-content:center" 
                hx-delete="/docs/${id}" hx-confirm="Delete this document?" hx-swap="none" 
                onclick="if (confirm('Are you sure?')) { /* handled by htmx */ } else { return false; }">Delete Document</button>
      </aside>
    </div>
  `

  return c.html(html)
})

// Helper: Record a revision snapshot
const createRevision = async (
  db: D1Database,
  docId: string,
  title: string,
  content: string,
  author: ReturnType<typeof authorOf>,
  now: number
): Promise<void> => {
  await db.prepare(`
    INSERT INTO document_revisions (id, document_id, title, content, author_type, api_key_id, api_key_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(generateId('rev'), docId, title, content, author.authorType, author.apiKeyId, author.apiKeyName, now).run()
}

// Helper: Load a document and check collection access.
// Returns the doc row, or a Response when not found / forbidden.
const loadDoc = async (c: any, id: string): Promise<{ doc: any } | { response: Response }> => {
  const doc = await c.env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first()
  if (!doc) {
    return { response: c.json({ error: { code: 'DOC_NOT_FOUND', message: 'Document not found' } }, 404) }
  }
  if (!isCollectionAllowed(c.get('auth'), doc.collection_id)) {
    return { response: c.json({ error: { code: 'FORBIDDEN', message: 'Collection not allowed for this API key' } }, 403) }
  }
  return { doc }
}

// Helper: Build path from parent
const buildPath = async (db: D1Database, parentId: string | null, collectionId: string, docId: string): Promise<string> => {
  if (!parentId) {
    return `/${collectionId}/${docId}`
  }

  const parent = await db.prepare('SELECT path FROM documents WHERE id = ?').bind(parentId).first() as { path: string } | null

  if (!parent) {
    throw new Error('Parent document not found')
  }

  return `${parent.path}/${docId}`
}

// GET /docs - List documents (meta only)
documentsRoute.get('/', async (c) => {
  const auth = c.get('auth')
  const collectionId = c.req.query('collection')
  const parentId = c.req.query('parent')
  const priority = c.req.query('priority')
  const limit = parseInt(c.req.query('limit') || '20')
  const cursor = c.req.query('cursor')

  let query = 'SELECT id, title, collection_id, parent_id, path, priority, status, created_at, updated_at FROM documents WHERE status = ?'
  const params: any[] = ['published']

  if (collectionId) {
    if (!isCollectionAllowed(auth, collectionId)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Collection not allowed for this API key' } }, 403)
    }
    query += ' AND collection_id = ?'
    params.push(collectionId)
  } else if (auth.authorType === 'ai' && auth.allowedCollections !== null) {
    if (auth.allowedCollections.length === 0) {
      return c.json({ data: [], next_cursor: null, has_more: false })
    }
    query += ` AND collection_id IN (${auth.allowedCollections.map(() => '?').join(', ')})`
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

    await c.env.DB.prepare('UPDATE documents SET content = ?, updated_at = ? WHERE id = ?')
      .bind(newContent, now, id).run()

    await createRevision(c.env.DB, id, doc.title, newContent, authorOf(c.get('auth')), now)
    const linkWarnings = await syncDocumentLinks(c.env.DB, id, newContent)

    // The slug may change when the heading is renamed; re-locate by line
    const newSection = parseSections(newContent).find((s) => s.headingLine === section.headingLine)
    return c.json({
      document_id: id,
      slug: newSection?.slug ?? slug,
      updated_at: now,
      ...(linkWarnings.length > 0 ? { link_warnings: linkWarnings } : {}),
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

    await c.env.DB.prepare('UPDATE documents SET content = ?, updated_at = ? WHERE id = ?')
      .bind(newContent, now, id).run()

    await createRevision(c.env.DB, id, doc.title, newContent, authorOf(c.get('auth')), now)
    const linkWarnings = await syncDocumentLinks(c.env.DB, id, newContent)

    return c.json({
      document_id: id,
      appended_bytes: parsed.content.length,
      updated_at: now,
      ...(linkWarnings.length > 0 ? { link_warnings: linkWarnings } : {}),
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
    for (const rev of revisions) {
      html += `  <li>\n`
      html += `    <span>${new Date(rev.created_at).toLocaleString()}</span>\n`
      html += `    <span class="tag">${rev.author_type}${rev.api_key_name ? ': ' + rev.api_key_name : ''}</span>\n`
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

    if (!isCollectionAllowed(auth, parsed.collection_id)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Collection not allowed for this API key' } }, 403)
    }

    const author = authorOf(auth)
    const id = generateId('doc')
    const now = Date.now()

    // Build path
    const path = await buildPath(c.env.DB, parsed.parent_id || null, parsed.collection_id, id)

    // Create document
    await c.env.DB.prepare(`
      INSERT INTO documents (id, title, content, collection_id, parent_id, path, priority, status, created_by_type, created_by_key_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      parsed.title,
      parsed.content,
      parsed.collection_id,
      parsed.parent_id || null,
      path,
      parsed.priority || 'normal',
      parsed.status || 'published',
      author.authorType,
      author.apiKeyId,
      now,
      now
    ).run()

    // Create initial revision
    await createRevision(c.env.DB, id, parsed.title, parsed.content, author, now)

    const linkWarnings = await syncDocumentLinks(c.env.DB, id, parsed.content)

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

    const existing = await c.env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first() as any
    if (!existing) {
      return c.json({ error: { code: 'DOC_NOT_FOUND', message: 'Document not found' } }, 404)
    }

    if (!isCollectionAllowed(auth, existing.collection_id)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Collection not allowed for this API key' } }, 403)
    }

    const now = Date.now()
    const updates: string[] = ['updated_at = ?']
    const params: any[] = [now]

    if (parsed.title !== undefined) {
      updates.push('title = ?')
      params.push(parsed.title)
    }
    if (parsed.content !== undefined) {
      updates.push('content = ?')
      params.push(parsed.content)
    }
    if (parsed.priority !== undefined) {
      updates.push('priority = ?')
      params.push(parsed.priority)
    }
    if (parsed.status !== undefined) {
      updates.push('status = ?')
      params.push(parsed.status)
    }

    params.push(id)

    await c.env.DB.prepare(`
      UPDATE documents SET ${updates.join(', ')} WHERE id = ?
    `).bind(...params).run()

    // Create revision
    const doc = await c.env.DB.prepare('SELECT title, content FROM documents WHERE id = ?').bind(id).first() as any
    await createRevision(c.env.DB, id, doc.title, doc.content, authorOf(auth), now)

    const linkWarnings = parsed.content !== undefined
      ? await syncDocumentLinks(c.env.DB, id, doc.content)
      : []

    const updated = await c.env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first()
    const accept = c.req.header('Accept') || ''

    // Return HTML for HTMX requests
    if (accept.includes('text/html')) {
      // Return a small success message or just a script to redirect/reload
      // For now, redirecting to the document list or just showing "Saved"
      return c.html('<script>alert("保存しました"); window.location.reload();</script>')
    }

    return c.json(linkWarnings.length > 0 ? { ...updated, link_warnings: linkWarnings } : updated)
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

  const existing = await c.env.DB.prepare('SELECT id, collection_id FROM documents WHERE id = ?').bind(id).first() as any
  if (!existing) {
    return c.json({ error: { code: 'DOC_NOT_FOUND', message: 'Document not found' } }, 404)
  }

  if (!isCollectionAllowed(auth, existing.collection_id)) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Collection not allowed for this API key' } }, 403)
  }

  await c.env.DB.batch([
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
