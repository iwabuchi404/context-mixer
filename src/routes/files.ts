// File upload/download endpoints using R2 storage.
import { Hono } from 'hono'
import { z } from 'zod'
import { authorOf, isCollectionAllowed } from '../auth/adapter'
import type { AppEnv } from '../auth/adapter'

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

    // Fetch created file
    const fileRecord = await c.env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(fileId).first()

    return c.json(fileRecord, 201)
  } catch (error: any) {
    console.error('Error uploading file:', error)
    return c.json({ error: { code: 'UPLOAD_ERROR', message: 'Failed to upload file' } }, 500)
  }
})

// GET /files/:id - Get file metadata
filesRoute.get('/:id', async (c) => {
  const id = c.req.param('id')

  const file = await c.env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(id).first()
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

  return c.json(file)
})

// GET /files/:id/raw - Get file content (direct from R2)
filesRoute.get('/:id/raw', async (c) => {
  const id = c.req.param('id')

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

  // Fetch from R2
  const object = await c.env.R2.get(file.r2_key)
  if (!object) {
    return c.json({ error: { code: 'FILE_NOT_FOUND', message: 'File not found in storage' } }, 404)
  }

  const headers = new Headers()
  headers.set('Content-Type', file.mime_type)
  headers.set('Content-Disposition', `inline; filename="${file.filename}"`)

  return new Response(object.body, { headers })
})

// DELETE /files/:id - Delete file (from R2 and D1)
filesRoute.delete('/:id', async (c) => {
  const id = c.req.param('id')

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

  return c.json({ success: true, id })
})
