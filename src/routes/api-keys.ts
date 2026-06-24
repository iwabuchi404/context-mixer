import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../auth/adapter'
import { ownerUserIdOf } from '../auth/adapter'
import { generateApiKey, hashApiKey } from '../auth/apikey'
import { escapeHtml as esc } from '../services/markdown'

const scopeEnum = z.enum(['read', 'write'])

const createKeySchema = z.object({
  name: z.string().min(1),
  scopes: z.array(scopeEnum).min(1),
  collection_ids: z.array(z.string()).nullable().optional(),
  entry_doc_id: z.string().nullable().optional(),
  expires_at: z.number().int().nullable().optional(),
})

const updateKeySchema = z.object({
  name: z.string().min(1).optional(),
  scopes: z.array(scopeEnum).min(1).optional(),
  collection_ids: z.array(z.string()).nullable().optional(),
  entry_doc_id: z.string().nullable().optional(),
  expires_at: z.number().int().nullable().optional(),
  is_active: z.boolean().optional(),
})

export const apiKeysRoute = new Hono<AppEnv>()

const generateId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

// Verify that every id in `collectionIds` exists in the collections table (owned by the user).
// Returns the list of invalid ids (empty = all valid, or input was null/empty).
const findInvalidCollectionIds = async (
  db: D1Database,
  collectionIds: string[] | null | undefined,
  ownerUserId: string
): Promise<string[]> => {
  if (!collectionIds || collectionIds.length === 0) return []
  const rows = await db.prepare('SELECT id FROM collections WHERE owner_user_id = ?').bind(ownerUserId).all()
  const valid = new Set((rows.results as { id: string }[]).map((r) => r.id))
  return collectionIds.filter((id) => !valid.has(id))
}

// Strip key_hash from rows before returning
const PUBLIC_COLUMNS = 'id, name, scopes, collection_ids, entry_doc_id, expires_at, last_used_at, is_active, created_at'

// GET /api-keys - List keys (never returns hashes)
apiKeysRoute.get('/', async (c) => {
  const accept = c.req.header('Accept') || ''
  const auth = c.get('auth')
  const uid = ownerUserIdOf(auth)

  // Return HTML for HTMX requests
  if (accept.includes('text/html')) {
    const result = await c.env.DB.prepare(
      `SELECT ${PUBLIC_COLUMNS} FROM api_keys WHERE owner_user_id = ? ORDER BY created_at DESC`
    ).bind(uid).all()

    let html = '<ul class="plain">\n'
    for (const key of result.results as any[]) {
      const scopes = JSON.parse(key.scopes)
      html += `  <li>\n`
      html += `    <div class="row">\n`
      html += `      <strong>${esc(key.name)}</strong>\n`
      html += `      <span class="tag">${esc(scopes.join(', '))}</span>\n`
      if (!key.is_active) {
        html += `      <span class="tag" style="color:#dc2626">失効済み</span>\n`
      }
      html += `      <span class="spacer" style="flex:1"></span>\n`
      if (key.is_active) {
        html += `      <button class="danger" hx-delete="/api-keys/${esc(key.id)}" hx-confirm="キー「${esc(key.name)}」を失効させますか?" hx-include="#keys-list">失効</button>\n`
      }
      html += `    </div>\n`
      html += `    <div class="muted">\n`
      html += `      作成 ${new Date(key.created_at).toLocaleString()}\n`
      if (key.last_used_at) {
        html += `      ・最終使用 ${new Date(key.last_used_at).toLocaleString()}\n`
      } else {
        html += `      ・未使用\n`
      }
      html += `    </div>\n`
      html += `  </li>\n`
    }
    if (result.results.length === 0) {
      html += '  <li class="muted">発行済みのキーはありません。</li>\n'
    }
    html += '</ul>\n'
    return c.html(html)
  }

  // JSON for API requests
  const result = await c.env.DB.prepare(
    `SELECT ${PUBLIC_COLUMNS} FROM api_keys WHERE owner_user_id = ? ORDER BY created_at DESC`
  ).bind(uid).all()
  return c.json(result.results)
})

// POST /api-keys - Issue a key. The raw key is returned once and never stored.
apiKeysRoute.post('/', async (c) => {
  try {
    const contentType = c.req.header('Content-Type') || ''
    let body: any

    if (contentType.includes('application/json')) {
      body = await c.req.json()
    } else {
      // all:true keeps every same-named field (e.g. both scopes checkboxes);
      // without it parseBody returns only the last value, dropping "read".
      body = await c.req.parseBody({ all: true })
      // A single checkbox still arrives as a string — Zod expects an array
      if (body.scopes && !Array.isArray(body.scopes)) {
        body.scopes = [body.scopes]
      }
    }

    const parsed = createKeySchema.parse(body)

    const auth = c.get('auth')
    const uid = ownerUserIdOf(auth)

    // Reject references to non-existent collections (OAuth handler already does this)
    const invalidCols = await findInvalidCollectionIds(c.env.DB, parsed.collection_ids, uid)
    if (invalidCols.length > 0) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: `Invalid collection_ids: ${invalidCols.join(', ')}` } }, 400)
    }

    const id = generateId('key')
    const rawKey = generateApiKey()
    const keyHash = await hashApiKey(rawKey)
    const now = Date.now()

    await c.env.DB.prepare(`
      INSERT INTO api_keys (id, name, key_hash, scopes, collection_ids, entry_doc_id, owner_user_id, expires_at, is_active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).bind(
      id,
      parsed.name,
      keyHash,
      JSON.stringify(parsed.scopes),
      parsed.collection_ids ? JSON.stringify(parsed.collection_ids) : null,
      parsed.entry_doc_id ?? null,
      uid,
      parsed.expires_at ?? null,
      now
    ).run()

    const key = await c.env.DB.prepare(
      `SELECT ${PUBLIC_COLUMNS} FROM api_keys WHERE id = ?`
    ).bind(id).first()

    const accept = c.req.header('Accept') || ''

    // Return HTML for HTMX requests
    if (accept.includes('text/html')) {
      let html = `
        <div class="doc-meta-card" style="border-color:var(--accent); background:var(--accent-subtle); margin-top:var(--space-4)">
          <strong style="font-size:var(--text-xs); color:var(--accent)">RAW KEY (COPY NOW, THIS WILL NOT BE SHOWN AGAIN)</strong>
          <div class="keybox" style="margin: var(--space-2) 0">${rawKey}</div>
          <button class="btn-primary btn-sm" onclick="copyKey('${rawKey}')">Copy to Clipboard</button>
        </div>
        <script>document.getElementById('created-key-section').style.display = 'block';</script>
        <div hx-get="/api-keys" hx-trigger="load" hx-target="#keys-list" hx-swap="innerHTML"></div>
      `
      return c.html(html)
    }

    return c.json({ ...key, key: rawKey }, 201)
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: error.errors } }, 400)
    }
    console.error('Error creating API key:', error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create API key' } }, 500)
  }
})

// PATCH /api-keys/:id - Update key settings
apiKeysRoute.patch('/:id', async (c) => {
  const id = c.req.param('id')

  try {
    const body = await c.req.json()
    const parsed = updateKeySchema.parse(body)

    const auth = c.get('auth')
    const uid = ownerUserIdOf(auth)

    const existing = await c.env.DB.prepare('SELECT id FROM api_keys WHERE id = ? AND owner_user_id = ?').bind(id, uid).first()
    if (!existing) {
      return c.json({ error: { code: 'KEY_NOT_FOUND', message: 'API key not found' } }, 404)
    }

    // Validate collection_ids if present in the update
    if (parsed.collection_ids !== undefined) {
      const invalidCols = await findInvalidCollectionIds(c.env.DB, parsed.collection_ids, uid)
      if (invalidCols.length > 0) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: `Invalid collection_ids: ${invalidCols.join(', ')}` } }, 400)
      }
    }

    const updates: string[] = []
    const params: any[] = []

    if (parsed.name !== undefined) {
      updates.push('name = ?')
      params.push(parsed.name)
    }
    if (parsed.scopes !== undefined) {
      updates.push('scopes = ?')
      params.push(JSON.stringify(parsed.scopes))
    }
    if (parsed.collection_ids !== undefined) {
      updates.push('collection_ids = ?')
      params.push(parsed.collection_ids ? JSON.stringify(parsed.collection_ids) : null)
    }
    if (parsed.entry_doc_id !== undefined) {
      updates.push('entry_doc_id = ?')
      params.push(parsed.entry_doc_id)
    }
    if (parsed.expires_at !== undefined) {
      updates.push('expires_at = ?')
      params.push(parsed.expires_at)
    }
    if (parsed.is_active !== undefined) {
      updates.push('is_active = ?')
      params.push(parsed.is_active ? 1 : 0)
    }

    if (updates.length === 0) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'No fields to update' } }, 400)
    }

    params.push(id)
    await c.env.DB.prepare(`UPDATE api_keys SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run()

    const updated = await c.env.DB.prepare(
      `SELECT ${PUBLIC_COLUMNS} FROM api_keys WHERE id = ?`
    ).bind(id).first()
    return c.json(updated)
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: error.errors } }, 400)
    }
    console.error('Error updating API key:', error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update API key' } }, 500)
  }
})

// DELETE /api-keys/:id - Revoke (deactivate, kept for revision traceability)
apiKeysRoute.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const accept = c.req.header('Accept') || ''
  const auth = c.get('auth')
  const uid = ownerUserIdOf(auth)

  const existing = await c.env.DB.prepare('SELECT id FROM api_keys WHERE id = ? AND owner_user_id = ?').bind(id, uid).first()
  if (!existing) {
    return c.json({ error: { code: 'KEY_NOT_FOUND', message: 'API key not found' } }, 404)
  }

  await c.env.DB.prepare('UPDATE api_keys SET is_active = 0 WHERE id = ? AND owner_user_id = ?').bind(id, uid).run()

  // Return HTML for HTMX requests - reload the list
  if (accept.includes('text/html')) {
    const result = await c.env.DB.prepare(
      `SELECT ${PUBLIC_COLUMNS} FROM api_keys WHERE owner_user_id = ? ORDER BY created_at DESC`
    ).bind(uid).all()

    let html = '<ul class="plain">\n'
    for (const key of result.results as any[]) {
      const scopes = JSON.parse(key.scopes)
      html += `  <li>\n`
      html += `    <div class="row">\n`
      html += `      <strong>${esc(key.name)}</strong>\n`
      html += `      <span class="tag">${esc(scopes.join(', '))}</span>\n`
      if (!key.is_active) {
        html += `      <span class="tag" style="color:#dc2626">失効済み</span>\n`
      }
      html += `      <span class="spacer" style="flex:1"></span>\n`
      if (key.is_active) {
        html += `      <button class="danger" hx-delete="/api-keys/${esc(key.id)}" hx-confirm="キー「${esc(key.name)}」を失効させますか?" hx-include="#keys-list">失効</button>\n`
      }
      html += `    </div>\n`
      html += `    <div class="muted">\n`
      html += `      作成 ${new Date(key.created_at).toLocaleString()}\n`
      if (key.last_used_at) {
        html += `      ・最終使用 ${new Date(key.last_used_at).toLocaleString()}\n`
      } else {
        html += `      ・未使用\n`
      }
      html += `    </div>\n`
      html += `  </li>\n`
    }
    if (result.results.length === 0) {
      html += '  <li class="muted">発行済みのキーはありません。</li>\n'
    }
    html += '</ul>\n'
    return c.html(html)
  }

  return c.json({ success: true, id })
})
