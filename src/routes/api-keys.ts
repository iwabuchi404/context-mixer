import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../auth/adapter'
import { generateApiKey, hashApiKey } from '../auth/apikey'

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

// Strip key_hash from rows before returning
const PUBLIC_COLUMNS = 'id, name, scopes, collection_ids, entry_doc_id, expires_at, last_used_at, is_active, created_at'

// GET /api-keys - List keys (never returns hashes)
apiKeysRoute.get('/', async (c) => {
  const accept = c.req.header('Accept') || ''

  // Return HTML for HTMX requests
  if (accept.includes('text/html')) {
    const result = await c.env.DB.prepare(
      `SELECT ${PUBLIC_COLUMNS} FROM api_keys ORDER BY created_at DESC`
    ).all()

    let html = '<ul class="plain">\n'
    for (const key of result.results as any[]) {
      const scopes = JSON.parse(key.scopes)
      html += `  <li>\n`
      html += `    <div class="row">\n`
      html += `      <strong>${key.name}</strong>\n`
      html += `      <span class="tag">${scopes.join(', ')}</span>\n`
      if (!key.is_active) {
        html += `      <span class="tag" style="color:#dc2626">失効済み</span>\n`
      }
      html += `      <span class="spacer" style="flex:1"></span>\n`
      if (key.is_active) {
        html += `      <button class="danger" hx-delete="/api-keys/${key.id}" hx-confirm="キー「${key.name}」を失効させますか?" hx-include="#keys-list">失効</button>\n`
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
    `SELECT ${PUBLIC_COLUMNS} FROM api_keys ORDER BY created_at DESC`
  ).all()
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
      body = await c.req.parseBody()
      // HTMX/Form can send single value as string, Zod expects array
      if (body.scopes && !Array.isArray(body.scopes)) {
        body.scopes = [body.scopes]
      }
    }

    const parsed = createKeySchema.parse(body)

    const id = generateId('key')
    const rawKey = generateApiKey()
    const keyHash = await hashApiKey(rawKey)
    const now = Date.now()

    await c.env.DB.prepare(`
      INSERT INTO api_keys (id, name, key_hash, scopes, collection_ids, entry_doc_id, expires_at, is_active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).bind(
      id,
      parsed.name,
      keyHash,
      JSON.stringify(parsed.scopes),
      parsed.collection_ids ? JSON.stringify(parsed.collection_ids) : null,
      parsed.entry_doc_id ?? null,
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

    const existing = await c.env.DB.prepare('SELECT id FROM api_keys WHERE id = ?').bind(id).first()
    if (!existing) {
      return c.json({ error: { code: 'KEY_NOT_FOUND', message: 'API key not found' } }, 404)
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

  const existing = await c.env.DB.prepare('SELECT id FROM api_keys WHERE id = ?').bind(id).first()
  if (!existing) {
    return c.json({ error: { code: 'KEY_NOT_FOUND', message: 'API key not found' } }, 404)
  }

  await c.env.DB.prepare('UPDATE api_keys SET is_active = 0 WHERE id = ?').bind(id).run()

  // Return HTML for HTMX requests - reload the list
  if (accept.includes('text/html')) {
    const result = await c.env.DB.prepare(
      `SELECT ${PUBLIC_COLUMNS} FROM api_keys ORDER BY created_at DESC`
    ).all()

    let html = '<ul class="plain">\n'
    for (const key of result.results as any[]) {
      const scopes = JSON.parse(key.scopes)
      html += `  <li>\n`
      html += `    <div class="row">\n`
      html += `      <strong>${key.name}</strong>\n`
      html += `      <span class="tag">${scopes.join(', ')}</span>\n`
      if (!key.is_active) {
        html += `      <span class="tag" style="color:#dc2626">失効済み</span>\n`
      }
      html += `      <span class="spacer" style="flex:1"></span>\n`
      if (key.is_active) {
        html += `      <button class="danger" hx-delete="/api-keys/${key.id}" hx-confirm="キー「${key.name}」を失効させますか?" hx-include="#keys-list">失効</button>\n`
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
