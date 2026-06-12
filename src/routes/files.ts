// File upload/download endpoints using R2 storage.
import { Hono } from 'hono'
import { authorOf, isCollectionAllowed } from '../auth/adapter'
import type { AppEnv } from '../auth/adapter'
import { escapeHtml as esc } from '../services/markdown'

// Max upload size (R2 free tier friendly; also caps memory use per request)
const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB

export const filesRoute = new Hono<AppEnv>()

// Helper: Generate unique ID
const generateId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

// Helper: Extract file extension from MIME type or filename
const getExtension = (filename: string, mimeType: string): string => {
  const parts = filename.split('.')
  if (parts.length > 1) {
    return parts[parts.length - 1].toLowerCase()
  }

  // Fallback: guess from MIME type
  const mimeMap: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
  }

  return mimeMap[mimeType] || 'bin'
}

// Renders the files grid as an HTML fragment (served via /ui/files).
export const renderFilesList = async (c: any): Promise<string> => {
  const limit = parseInt(c.req.query('limit') || '50')
  const result = await c.env.DB.prepare(`
    SELECT * FROM files ORDER BY created_at DESC LIMIT ?
  `).bind(limit).all()

  let html = '<div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(300px, 1fr)); gap:var(--space-4)">\n'
  for (const file of result.results as any[]) {
    const isImage = typeof file.mime_type === 'string' && file.mime_type.startsWith('image/')
    html += `  <div class="doc-meta-card" style="display:flex; gap:var(--space-4); align-items:start">\n`
    if (isImage) {
      html += `    <img src="/files/${esc(file.id)}/raw" style="width:64px; height:64px; object-fit:cover; border-radius:var(--radius-sm); border:1px solid var(--border)">\n`
    } else {
      html += `    <div style="width:64px; height:64px; background:var(--surface-dim); display:flex; align-items:center; justify-content:center; border-radius:var(--radius-sm); font-size:24px">📄</div>\n`
    }
    html += `    <div style="flex:1; min-width:0">\n`
    html += `      <div style="font-weight:600; font-size:var(--text-sm); white-space:nowrap; overflow:hidden; text-overflow:ellipsis"><a href="/files/${esc(file.id)}/raw" target="_blank">${esc(file.filename)}</a></div>\n`
    html += `      <div class="muted" style="font-size:var(--text-xs); margin-top:2px">${esc(file.mime_type)} ・ ${(file.size_bytes / 1024).toFixed(1)} KB</div>\n`
    html += `      <div class="muted" style="font-size:10px; margin-top:4px">Embed: <code style="font-size:9px">/files/${esc(file.id)}/raw</code></div>\n`
    html += `      <button class="btn-quiet btn-danger btn-sm" style="margin-top:var(--space-2); padding-left:0" hx-delete="/files/${esc(file.id)}" hx-confirm="Delete this file?" hx-target="#files-list">Delete</button>\n`
    html += `    </div>\n`
    html += `  </div>\n`
  }
  if (result.results.length === 0) {
    html += '  <div class="muted" style="grid-column:1/-1; padding:var(--space-8); text-align:center; border:1px dashed var(--border); border-radius:var(--radius-md)">No files uploaded.</div>\n'
  }
  html += '</div>\n'
  return html
}

// GET /files - List files (JSON API; the HTML fragment is /ui/files)
filesRoute.get('/', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50')
  const result = await c.env.DB.prepare(`
    SELECT * FROM files ORDER BY created_at DESC LIMIT ?
  `).bind(limit).all()
  return c.json({ data: result.results })
})

// POST /files - Upload file
// FormData: file (required), document_id (optional)
filesRoute.post('/', async (c) => {
  try {
    const auth = c.get('auth')
    const body = await c.req.parseBody()
    const file = body.file as File

    if (!file) {
      return c.json({ error: { code: 'MISSING_FILE', message: 'No file uploaded' } }, 400)
    }

    if (file.size > MAX_FILE_BYTES) {
      return c.json({ error: { code: 'FILE_TOO_LARGE', message: `File exceeds ${MAX_FILE_BYTES / 1024 / 1024} MB` } }, 413)
    }

    const documentId = body.document_id as string | undefined
    const author = authorOf(auth)
    const now = Date.now()

    // Generate file ID and R2 key
    const fileId = generateId('file')
    const extension = getExtension(file.name, file.type)
    const r2Key = `${fileId}.${extension}`

    // Upload to R2
    const arrayBuffer = await file.arrayBuffer()
    await c.env.R2.put(r2Key, arrayBuffer, {
      httpMetadata: {
        contentType: file.type,
      },
    })

    // Save metadata to D1
    await c.env.DB.prepare(`
      INSERT INTO files (id, document_id, filename, mime_type, size_bytes, r2_key, created_by_type, api_key_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      fileId,
      documentId || null,
      file.name,
      file.type,
      arrayBuffer.byteLength,
      r2Key,
      author.authorType,
      author.apiKeyId,
      now
    ).run()

    const accept = c.req.header('Accept') || ''
    if (accept.includes('text/html')) {
      return c.html(await renderFilesList(c))
    }

    // Fetch created file
    const fileRecord = await c.env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(fileId).first()

    return c.json(fileRecord, 201)
  } catch (error: any) {
    console.error('Error uploading file:', error)
    return c.json({ error: { code: 'UPLOAD_ERROR', message: 'Failed to upload file' } }, 500)
  }
})

// DELETE /files/:id - Delete file (from R2 and D1)
filesRoute.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const accept = c.req.header('Accept') || ''

  const file = await c.env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(id).first() as any
  if (!file) {
    return c.json({ error: { code: 'FILE_NOT_FOUND', message: 'File not found' } }, 404)
  }

  // If file is linked to a document, check collection access
  if (file.document_id) {
    const doc = await c.env.DB.prepare('SELECT collection_id FROM documents WHERE id = ?').bind(file.document_id).first() as any
    if (doc && !isCollectionAllowed(c.get('auth'), doc.collection_id)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Collection not allowed for this API key' } }, 403)
    }
  }

  // Delete from R2
  await c.env.R2.delete(file.r2_key)

  // Delete from D1
  await c.env.DB.prepare('DELETE FROM files WHERE id = ?').bind(id).run()

  if (accept.includes('text/html')) {
    return c.html(await renderFilesList(c))
  }

  return c.json({ success: true, id })
})

