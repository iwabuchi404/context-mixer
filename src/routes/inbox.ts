// Inbox approval flow routes.
// External services can submit content to a document via a token.
// Submissions must be approved before they are applied to the document.
import { Hono } from 'hono'
import { z } from 'zod'
import { authorOf, isCollectionAllowed } from '../auth/adapter'
import type { AppEnv } from '../auth/adapter'

export const inboxRoute = new Hono<AppEnv>()

// Helper: Generate unique ID
const generateId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

// Validation schemas
const createTokenSchema = z.object({
  document_id: z.string(),
  expires_at: z.number().optional(), // Unix timestamp
})

const updateTokenSchema = z.object({
  is_active: z.boolean(),
})

// POST /inbox-tokens - Create an inbox token for a document
inboxRoute.post('/tokens', async (c) => {
  try {
    const auth = c.get('auth')
    const body = await c.req.json()
    const parsed = createTokenSchema.parse(body)

    // Verify document exists and is accessible
    const doc = await c.env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(parsed.document_id).first() as any
    if (!doc) {
      return c.json({ error: { code: 'DOC_NOT_FOUND', message: 'Document not found' } }, 404)
    }

    if (!isCollectionAllowed(auth, doc.collection_id)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Collection not allowed for this API key' } }, 403)
    }

    // Generate token
    const tokenId = generateId('token')
    const token = crypto.randomUUID().replace(/-/g, '')
    const now = Date.now()

    await c.env.DB.prepare(`
      INSERT INTO inbox_tokens (id, token, document_id, is_active, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(tokenId, token, parsed.document_id, 1, parsed.expires_at || null, now).run()

    const tokenRecord = await c.env.DB.prepare('SELECT * FROM inbox_tokens WHERE id = ?').bind(tokenId).first()

    return c.json(tokenRecord, 201)
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: error.errors } }, 400)
    }
    console.error('Error creating inbox token:', error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create inbox token' } }, 500)
  }
})

// PATCH /inbox-tokens/:id - Update token (activate/deactivate)
inboxRoute.patch('/tokens/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json()
    const parsed = updateTokenSchema.parse(body)

    const token = await c.env.DB.prepare('SELECT * FROM inbox_tokens WHERE id = ?').bind(id).first() as any
    if (!token) {
      return c.json({ error: { code: 'TOKEN_NOT_FOUND', message: 'Token not found' } }, 404)
    }

    await c.env.DB.prepare('UPDATE inbox_tokens SET is_active = ? WHERE id = ?')
      .bind(parsed.is_active ? 1 : 0, id).run()

    const updated = await c.env.DB.prepare('SELECT * FROM inbox_tokens WHERE id = ?').bind(id).first()

    return c.json(updated)
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: error.errors } }, 400)
    }
    console.error('Error updating inbox token:', error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update inbox token' } }, 500)
  }
})

// GET /inbox-tokens - List tokens (with optional document_id filter)
inboxRoute.get('/tokens', async (c) => {
  const documentId = c.req.query('document_id')
  const limit = parseInt(c.req.query('limit') || '20')

  let query = 'SELECT * FROM inbox_tokens WHERE 1=1'
  const params: any[] = []

  if (documentId) {
    query += ' AND document_id = ?'
    params.push(documentId)
  }

  query += ' ORDER BY created_at DESC LIMIT ?'
  params.push(limit)

  const result = await c.env.DB.prepare(query).bind(...params).all()

  return c.json({ data: result.results })
})

// POST /inbox/:token - Submit content to inbox (no auth required)
// This is the endpoint external services use to submit content
inboxRoute.post('/:token', async (c) => {
  try {
    const token = c.req.param('token')

    // Verify token exists and is active
    const tokenRecord = await c.env.DB.prepare(`
      SELECT * FROM inbox_tokens WHERE token = ? AND is_active = 1
    `).bind(token).first() as any

    if (!tokenRecord) {
      return c.json({ error: { code: 'INVALID_TOKEN', message: 'Invalid or inactive token' } }, 401)
    }

    // Check if expired
    if (tokenRecord.expires_at && tokenRecord.expires_at < Date.now()) {
      return c.json({ error: { code: 'TOKEN_EXPIRED', message: 'Token has expired' } }, 401)
    }

    const body = await c.req.json()
    const content = body.content

    if (typeof content !== 'string' || content.length === 0) {
      return c.json({ error: { code: 'INVALID_CONTENT', message: 'Content is required' } }, 400)
    }

    const sourceHint = body.source_hint || null

    // Get IP hash for rate limiting/audit
    const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown'
    const ipHash = Array.from(ip).reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0).toString(16)

    // Create inbox item
    const itemId = generateId('item')
    const now = Date.now()

    await c.env.DB.prepare(`
      INSERT INTO inbox_items (id, inbox_token_id, document_id, content, source_hint, status, submitted_at, ip_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(itemId, tokenRecord.id, tokenRecord.document_id, content, sourceHint, 'pending', now, ipHash).run()

    const item = await c.env.DB.prepare('SELECT * FROM inbox_items WHERE id = ?').bind(itemId).first()

    return c.json(item, 201)
  } catch (error: any) {
    console.error('Error submitting to inbox:', error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to submit to inbox' } }, 500)
  }
})

// GET /inbox - List pending items
inboxRoute.get('/', async (c) => {
  const status = c.req.query('status') || 'pending'
  const limit = parseInt(c.req.query('limit') || '20')
  const accept = c.req.header('Accept') || ''

  const result = await c.env.DB.prepare(`
    SELECT i.*, d.title as document_title
    FROM inbox_items i
    JOIN documents d ON i.document_id = d.id
    WHERE i.status = ?
    ORDER BY i.submitted_at DESC
    LIMIT ?
  `).bind(status, limit).all()

  if (accept.includes('text/html')) {
    let html = '<div style="display:flex; flex-direction:column; gap:var(--space-4)">\n'
    for (const item of result.results) {
      html += `  <div class="doc-meta-card">\n`
      html += `    <div style="display:flex; align-items:center; gap:var(--space-3); margin-bottom:var(--space-3)">\n`
      html += `      <strong style="font-size:var(--text-sm)">${item.document_title}</strong>\n`
      html += `      <span class="muted" style="font-size:var(--text-xs)">(${item.document_id})</span>\n`
      html += `      <div class="spacer"></div>\n`
      html += `      <button class="btn-primary btn-sm" hx-post="/inbox/${item.id}/approve" hx-target="#inbox-list">Approve</button>\n`
      html += `      <button class="btn btn-danger btn-sm" hx-post="/inbox/${item.id}/reject" hx-target="#inbox-list">Reject</button>\n`
      html += `    </div>\n`
      html += `    <div class="muted" style="font-size:var(--text-xs); margin-bottom:var(--space-3)">Submitted: ${new Date(item.submitted_at).toLocaleString()} ${item.source_hint ? '・ Source: ' + item.source_hint : ''}</div>\n`
      html += `    <pre style="margin:0; font-size:var(--text-xs); background:var(--surface-dim); padding:var(--space-3); border-radius:var(--radius-sm)"><code>${item.content}</code></pre>\n`
      html += `  </div>\n`
    }
    if (result.results.length === 0) {
      html += '  <div class="muted" style="padding:var(--space-6); text-align:center; border:1px dashed var(--border); border-radius:var(--radius-md)">No pending submissions.</div>\n'
    }
    html += '</div>\n'
    return c.html(html)
  }

  return c.json({ data: result.results })
})

// POST /inbox/:id/approve - Approve and apply to document
inboxRoute.post('/:id/approve', async (c) => {
  try {
    const id = c.req.param('id')
    const accept = c.req.header('Accept') || ''

    const item = await c.env.DB.prepare('SELECT * FROM inbox_items WHERE id = ?').bind(id).first() as any
    if (!item) {
      return c.json({ error: { code: 'ITEM_NOT_FOUND', message: 'Item not found' } }, 404)
    }

    if (item.status !== 'pending') {
      return c.json({ error: { code: 'INVALID_STATUS', message: 'Item is not pending' } }, 400)
    }

    const auth = c.get('auth')
    const author = authorOf(auth)
    const now = Date.now()

    // Get current document
    const doc = await c.env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(item.document_id).first() as any

    if (!doc) {
      return c.json({ error: { code: 'DOC_NOT_FOUND', message: 'Document not found' } }, 404)
    }

    if (!isCollectionAllowed(auth, doc.collection_id)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Collection not allowed for this API key' } }, 403)
    }

    // Append content to document
    const separator = doc.content === '' || doc.content.endsWith('\n\n') ? '' : doc.content.endsWith('\n') ? '\n' : '\n\n'
    const newContent = doc.content + separator + item.content

    // Update document
    await c.env.DB.prepare('UPDATE documents SET content = ?, updated_at = ? WHERE id = ?')
      .bind(newContent, now, doc.id).run()

    // Create revision
    await c.env.DB.prepare(`
      INSERT INTO document_revisions (id, document_id, title, content, author_type, api_key_id, api_key_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(generateId('rev'), doc.id, doc.title, newContent, author.authorType, author.apiKeyId, author.apiKeyName, now).run()

    // Update item status
    await c.env.DB.prepare('UPDATE inbox_items SET status = ?, reviewed_at = ? WHERE id = ?')
      .bind('approved', now, id).run()

    if (accept.includes('text/html')) {
      return c.redirect('/inbox')
    }

    return c.json({ success: true, document_id: doc.id, updated_at: now })
  } catch (error: any) {
    console.error('Error approving inbox item:', error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to approve item' } }, 500)
  }
})

// POST /inbox/:id/reject - Reject an item
inboxRoute.post('/:id/reject', async (c) => {
  try {
    const id = c.req.param('id')
    const accept = c.req.header('Accept') || ''

    const item = await c.env.DB.prepare('SELECT * FROM inbox_items WHERE id = ?').bind(id).first() as any
    if (!item) {
      return c.json({ error: { code: 'ITEM_NOT_FOUND', message: 'Item not found' } }, 404)
    }

    if (item.status !== 'pending') {
      return c.json({ error: { code: 'INVALID_STATUS', message: 'Item is not pending' } }, 400)
    }

    const now = Date.now()

    // Update item status
    await c.env.DB.prepare('UPDATE inbox_items SET status = ?, reviewed_at = ? WHERE id = ?')
      .bind('rejected', now, id).run()

    if (accept.includes('text/html')) {
      return c.redirect('/inbox')
    }

    return c.json({ success: true, id })
  } catch (error: any) {
    console.error('Error rejecting inbox item:', error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to reject item' } }, 500)
  }
})
