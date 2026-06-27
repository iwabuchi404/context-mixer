// Inbox approval flow routes.
// External services can submit content to a document via a token.
// Submissions must be approved before they are applied to the document.
import { Hono } from 'hono'
import { z } from 'zod'
import { isCollectionAllowed, ownerUserIdOf } from '../auth/adapter'
import type { AppEnv } from '../auth/adapter'
import { escapeHtml as esc } from '../services/markdown'
import { updateDocument } from '../services/revisions'


// Max bytes accepted from a single inbox submission (external, unauthenticated)
const MAX_INBOX_CONTENT = 100_000

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
    const uid = ownerUserIdOf(auth)
    const body = await c.req.json()
    const parsed = createTokenSchema.parse(body)

    // Verify document exists and is accessible (オーナーチェック付き)
    const doc = await c.env.DB.prepare(`
      SELECT d.* FROM documents d JOIN collections c ON d.collection_id = c.id
      WHERE d.id = ? AND c.owner_user_id = ?
    `).bind(parsed.document_id, uid).first() as any
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
      INSERT INTO inbox_tokens (id, token, document_id, owner_user_id, is_active, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(tokenId, token, parsed.document_id, uid, 1, parsed.expires_at || null, now).run()

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
    const uid = ownerUserIdOf(c.get('auth'))

    const token = await c.env.DB.prepare('SELECT * FROM inbox_tokens WHERE id = ? AND owner_user_id = ?').bind(id, uid).first() as any
    if (!token) {
      return c.json({ error: { code: 'TOKEN_NOT_FOUND', message: 'Token not found' } }, 404)
    }

    await c.env.DB.prepare('UPDATE inbox_tokens SET is_active = ? WHERE id = ? AND owner_user_id = ?')
      .bind(parsed.is_active ? 1 : 0, id, uid).run()

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
  const uid = ownerUserIdOf(c.get('auth'))

  let query = 'SELECT * FROM inbox_tokens WHERE owner_user_id = ?'
  const params: any[] = [uid]

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

    if (content.length > MAX_INBOX_CONTENT) {
      return c.json({ error: { code: 'CONTENT_TOO_LARGE', message: `Content exceeds ${MAX_INBOX_CONTENT} characters` } }, 413)
    }

    const sourceHint = typeof body.source_hint === 'string' ? body.source_hint.slice(0, 500) : null

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

// Renders the pending-items list as an HTML fragment (served via /ui/inbox).
// Buttons re-target #inbox-list, which approve/reject refresh in place.
export const renderInboxList = async (c: any): Promise<string> => {
  const status = c.req.query('status') || 'pending'
  const limit = parseInt(c.req.query('limit') || '20')
  const uid = ownerUserIdOf(c.get('auth'))

  const result = await c.env.DB.prepare(`
    SELECT i.*, d.title as document_title
    FROM inbox_items i
    JOIN inbox_tokens t ON i.inbox_token_id = t.id
    JOIN documents d ON i.document_id = d.id
    WHERE i.status = ? AND t.owner_user_id = ?
    ORDER BY i.submitted_at DESC
    LIMIT ?
  `).bind(status, uid, limit).all()

  let html = '<div style="display:flex; flex-direction:column; gap:var(--space-4)">\n'
  for (const item of result.results as any[]) {
    html += `  <div class="doc-meta-card">\n`
    html += `    <div style="display:flex; align-items:center; gap:var(--space-3); margin-bottom:var(--space-3)">\n`
    html += `      <strong style="font-size:var(--text-sm)">${esc(item.document_title)}</strong>\n`
    html += `      <span class="muted" style="font-size:var(--text-xs)">(${esc(item.document_id)})</span>\n`
    html += `      <div class="spacer"></div>\n`
    html += `      <button class="btn-primary btn-sm" hx-post="/inbox/${esc(item.id)}/approve" hx-target="#inbox-list">Approve</button>\n`
    html += `      <button class="btn btn-danger btn-sm" hx-post="/inbox/${esc(item.id)}/reject" hx-target="#inbox-list">Reject</button>\n`
    html += `    </div>\n`
    html += `    <div class="muted" style="font-size:var(--text-xs); margin-bottom:var(--space-3)">Submitted: ${new Date(item.submitted_at).toLocaleString()} ${item.source_hint ? '・ Source: ' + esc(item.source_hint) : ''}</div>\n`
    html += `    <pre style="margin:0; font-size:var(--text-xs); background:var(--surface-dim); padding:var(--space-3); border-radius:var(--radius-sm)"><code>${esc(item.content)}</code></pre>\n`
    html += `  </div>\n`
  }
  if (result.results.length === 0) {
    html += '  <div class="muted" style="padding:var(--space-6); text-align:center; border:1px dashed var(--border); border-radius:var(--radius-md)">No pending submissions.</div>\n'
  }
  html += '</div>\n'
  return html
}

// GET /inbox - List pending items (JSON API; the HTML fragment is /ui/inbox)
inboxRoute.get('/', async (c) => {
  const status = c.req.query('status') || 'pending'
  const limit = parseInt(c.req.query('limit') || '20')
  const uid = ownerUserIdOf(c.get('auth'))

  const result = await c.env.DB.prepare(`
    SELECT i.*, d.title as document_title
    FROM inbox_items i
    JOIN inbox_tokens t ON i.inbox_token_id = t.id
    JOIN documents d ON i.document_id = d.id
    WHERE i.status = ? AND t.owner_user_id = ?
    ORDER BY i.submitted_at DESC
    LIMIT ?
  `).bind(status, uid, limit).all()

  return c.json({ data: result.results })
})

// POST /inbox/:id/approve - Approve and apply to document
inboxRoute.post('/:id/approve', async (c) => {
  try {
    const id = c.req.param('id')
    const accept = c.req.header('Accept') || ''
    const auth = c.get('auth')
    const uid = ownerUserIdOf(auth)

    // inbox_items を inbox_tokens 経由でオーナーチェック
    const item = await c.env.DB.prepare(`
      SELECT i.* FROM inbox_items i
      JOIN inbox_tokens t ON i.inbox_token_id = t.id
      WHERE i.id = ? AND t.owner_user_id = ?
    `).bind(id, uid).first() as any
    if (!item) {
      return c.json({ error: { code: 'ITEM_NOT_FOUND', message: 'Item not found' } }, 404)
    }

    if (item.status !== 'pending') {
      return c.json({ error: { code: 'INVALID_STATUS', message: 'Item is not pending' } }, 400)
    }

    const now = Date.now()

    // Get current document (オーナーチェック付き)
    const doc = await c.env.DB.prepare(`
      SELECT d.* FROM documents d JOIN collections c ON d.collection_id = c.id
      WHERE d.id = ? AND c.owner_user_id = ?
    `).bind(item.document_id, uid).first() as any

    if (!doc) {
      return c.json({ error: { code: 'DOC_NOT_FOUND', message: 'Document not found' } }, 404)
    }

    if (!isCollectionAllowed(auth, doc.collection_id)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Collection not allowed for this API key' } }, 403)
    }

    // Append content to document
    const separator = doc.content === '' || doc.content.endsWith('\n\n') ? '' : doc.content.endsWith('\n') ? '\n' : '\n\n'
    const newContent = doc.content + separator + item.content

    // Update document (with version/revision/links)
    const updateResult = await updateDocument(
      c.env.DB, auth, doc.id,
      { title: doc.title, content: doc.content, version: doc.version },
      { content: newContent },
      doc.version,
      now
    )
    if (!updateResult.ok) {
      return c.json({ error: { code: updateResult.code === 'CONFLICT' ? 'CONFLICT' : 'DOC_NOT_FOUND', message: 'Document was modified by another request' } }, updateResult.code === 'CONFLICT' ? 409 : 404)
    }

    // Mark inbox item approved
    await c.env.DB.prepare('UPDATE inbox_items SET status = ?, reviewed_at = ? WHERE id = ?')
      .bind('approved', now, id).run()

    if (accept.includes('text/html')) {
      return c.html(await renderInboxList(c))
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
    const uid = ownerUserIdOf(c.get('auth'))

    // inbox_items を inbox_tokens 経由でオーナーチェック
    const item = await c.env.DB.prepare(`
      SELECT i.* FROM inbox_items i
      JOIN inbox_tokens t ON i.inbox_token_id = t.id
      WHERE i.id = ? AND t.owner_user_id = ?
    `).bind(id, uid).first() as any
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
      return c.html(await renderInboxList(c))
    }

    return c.json({ success: true, id })
  } catch (error: any) {
    console.error('Error rejecting inbox item:', error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to reject item' } }, 500)
  }
})
