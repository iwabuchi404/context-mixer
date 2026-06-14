// MCP tool handlers for ContextMixer.
// Every tool receives the caller's AiAuth context and enforces the SAME rules
// as the REST routes: collection access (isCollectionAllowed), signed revisions
// (createRevision), and link sync (syncDocumentLinks). No SQL logic is
// duplicated beyond what the routes already do.

import type { AppEnv, AiAuth } from '../auth/adapter'
import { authorOf, isCollectionAllowed } from '../auth/adapter'
import { createRevision } from '../routes/documents'
import { buildTree } from '../routes/collections'
import { parseSections } from '../services/sections'
import { syncDocumentLinks } from '../services/links'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

type Env = AppEnv['Bindings']

const generateId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

const ok = (data: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
})
const err = (message: string): CallToolResult => ({
  content: [{ type: 'text', text: `Error: ${message}` }],
  isError: true,
})

const extractSnippet = (content: string, query: string, contextLines = 3): string => {
  const lines = content.split('\n')
  const q = query.toLowerCase()
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(q)) {
      return lines.slice(Math.max(0, i - contextLines), Math.min(lines.length, i + contextLines + 1)).join('\n')
    }
  }
  return lines.slice(0, contextLines * 2).join('\n')
}

// Tool: search_docs (read)
export async function searchDocs(
  env: Env,
  auth: AiAuth,
  params: { q: string; scope?: string; limit?: number }
): Promise<CallToolResult> {
  const { q, scope = '', limit = 10 } = params
  if (!q) return err('Query parameter "q" is required')

  let collectionId: string | null = null
  if (scope.startsWith('collection:')) collectionId = scope.slice('collection:'.length)

  let sql: string
  const sqlParams: any[] = []
  if ([...q].length < 3) {
    sql = `SELECT d.id, d.title, d.content, d.collection_id, d.priority
           FROM documents d WHERE d.status = 'published' AND (d.title LIKE ? OR d.content LIKE ?)`
    sqlParams.push(`%${q}%`, `%${q}%`)
  } else {
    sql = `SELECT d.id, d.title, d.content, d.collection_id, d.priority
           FROM documents_fts JOIN documents d ON documents_fts.rowid = d.rowid
           WHERE documents_fts MATCH ? AND d.status = 'published'`
    sqlParams.push(q.replace(/["\]]/g, ''))
  }

  // Collection access: explicit scope must be allowed; otherwise restrict to allowed set
  if (collectionId) {
    if (!isCollectionAllowed(auth, collectionId)) return err('Collection not allowed for this key')
    sql += ' AND d.collection_id = ?'
    sqlParams.push(collectionId)
  } else if (auth.allowedCollections !== null) {
    if (auth.allowedCollections.length === 0) return ok({ data: [] })
    sql += ` AND d.collection_id IN (${auth.allowedCollections.map(() => '?').join(', ')})`
    sqlParams.push(...auth.allowedCollections)
  }

  sql += ' LIMIT ?'
  sqlParams.push(limit)

  const result = await env.DB.prepare(sql).bind(...sqlParams).all()
  const data = (result.results as any[]).map((r) => ({
    id: r.id, title: r.title, snippet: extractSnippet(r.content, q),
    collection_id: r.collection_id, priority: r.priority,
  }))
  return ok({ data })
}

// Tool: get_doc (read)
export async function getDoc(
  env: Env,
  auth: AiAuth,
  params: { id: string; view?: string }
): Promise<CallToolResult> {
  const { id, view = 'full' } = params
  const doc = await env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first() as any
  if (!doc) return err('Document not found')
  if (!isCollectionAllowed(auth, doc.collection_id)) return err('Collection not allowed for this key')

  if (view === 'meta') {
    const sections = parseSections(doc.content).map((s) => ({ slug: s.slug, title: s.title, level: s.level }))
    return ok({
      id: doc.id, title: doc.title, collection_id: doc.collection_id, parent_id: doc.parent_id,
      path: doc.path, priority: doc.priority, status: doc.status, sections,
      created_at: doc.created_at, updated_at: doc.updated_at,
    })
  }
  if (view === 'outline') {
    return ok({ outline: parseSections(doc.content).map((s) => ({ slug: s.slug, title: s.title, level: s.level })) })
  }
  return ok(doc)
}

// Tool: write_doc (write) — create or update
export async function writeDoc(
  env: Env,
  auth: AiAuth,
  params: { id?: string; title: string; content: string; collection_id: string; parent_id?: string }
): Promise<CallToolResult> {
  const { id, title, content, collection_id, parent_id } = params
  const now = Date.now()
  const author = authorOf(auth)

  if (id) {
    const existing = await env.DB.prepare('SELECT collection_id FROM documents WHERE id = ?').bind(id).first() as any
    if (!existing) return err('Document not found')
    if (!isCollectionAllowed(auth, existing.collection_id)) return err('Collection not allowed for this key')

    await env.DB.prepare('UPDATE documents SET title = ?, content = ?, updated_at = ? WHERE id = ?')
      .bind(title, content, now, id).run()
    await createRevision(env.DB, id, title, content, author, now)
    await syncDocumentLinks(env.DB, id, content)

    const updated = await env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first()
    return ok(updated)
  }

  // Create — collection must exist and be allowed; restricted keys cannot create
  if (auth.allowedCollections !== null && !isCollectionAllowed(auth, collection_id)) {
    return err('Collection not allowed for this key')
  }
  const collection = await env.DB.prepare('SELECT id FROM collections WHERE id = ?').bind(collection_id).first()
  if (!collection) return err('Collection not found')

  // Verify parent document if specified and build path in one query
  let parentId = null
  let path: string
  const docId = generateId('doc')
  if (parent_id) {
    const parent = await env.DB.prepare('SELECT id, collection_id, path FROM documents WHERE id = ?').bind(parent_id).first() as any
    if (!parent) return err('Parent document not found')
    if (parent.collection_id !== collection_id) return err('Parent document must be in the same collection')
    parentId = parent_id
    path = `${parent.path}/${docId}`
  } else {
    path = `/${collection_id}/${docId}`
  }

  await env.DB.prepare(`
    INSERT INTO documents (id, title, content, collection_id, parent_id, path, priority, status, created_by_type, created_by_key_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'normal', 'published', ?, ?, ?, ?)
  `).bind(docId, title, content, collection_id, parentId, path, author.authorType, author.apiKeyId, now, now).run()
  await createRevision(env.DB, docId, title, content, author, now)
  await syncDocumentLinks(env.DB, docId, content)

  const doc = await env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(docId).first()
  return ok(doc)
}

// Tool: append_doc (write)
export async function appendDoc(
  env: Env,
  auth: AiAuth,
  params: { id: string; content: string }
): Promise<CallToolResult> {
  const { id, content } = params
  const existing = await env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first() as any
  if (!existing) return err('Document not found')
  if (!isCollectionAllowed(auth, existing.collection_id)) return err('Collection not allowed for this key')

  const sep = existing.content === '' || existing.content.endsWith('\n\n') ? '' : existing.content.endsWith('\n') ? '\n' : '\n\n'
  const newContent = existing.content + sep + content
  const now = Date.now()

  await env.DB.prepare('UPDATE documents SET content = ?, updated_at = ? WHERE id = ?')
    .bind(newContent, now, id).run()
  await createRevision(env.DB, id, existing.title, newContent, authorOf(auth), now)
  await syncDocumentLinks(env.DB, id, newContent)

  const updated = await env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first()
  return ok(updated)
}

// Tool: list_collections (read) — returns tree structure
export async function listCollections(env: Env, auth: AiAuth): Promise<CallToolResult> {
  const result = await env.DB.prepare(`
    SELECT id, name, parent_id, description, is_system, entrypoint_doc_id,
           created_by_type, updated_by_type, created_at, updated_at
    FROM collections ORDER BY name
  `).all()
  const visible = (result.results as any[]).filter((c) => isCollectionAllowed(auth, c.id))

  // Restricted keys may not see parent collections, so return flat list with empty children
  // to avoid silently dropping collections whose parents are hidden.
  if (auth.allowedCollections !== null) {
    return ok(visible.map((c: any) => ({ ...c, children: [] })))
  }

  return ok(buildTree(visible))
}

// Tool: get_entrypoint (read)
export async function getEntrypoint(
  env: Env,
  auth: AiAuth,
  params: { collection_id?: string }
): Promise<CallToolResult> {
  const { collection_id } = params

  if (collection_id) {
    if (!isCollectionAllowed(auth, collection_id)) return err('Collection not allowed for this key')
    const collection = await env.DB.prepare('SELECT entrypoint_doc_id FROM collections WHERE id = ?').bind(collection_id).first() as any
    if (!collection || !collection.entrypoint_doc_id) return err('No entry point document set for this collection')
    const doc = await env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(collection.entrypoint_doc_id).first()
    return ok(doc)
  }

  const result = await env.DB.prepare(`
    SELECT c.id, c.name, c.entrypoint_doc_id, d.title as entry_doc_title
    FROM collections c LEFT JOIN documents d ON c.entrypoint_doc_id = d.id
    ORDER BY c.name
  `).all()
  const visible = (result.results as any[]).filter((c) => isCollectionAllowed(auth, c.id))
  return ok(visible)
}

// Tool: delete_doc (write)
export async function deleteDoc(
  env: Env,
  auth: AiAuth,
  params: { id: string }
): Promise<CallToolResult> {
  const { id } = params

  const existing = await env.DB.prepare('SELECT id, collection_id FROM documents WHERE id = ?').bind(id).first() as any
  if (!existing) return err('Document not found')
  if (!isCollectionAllowed(auth, existing.collection_id)) return err('Collection not allowed for this key')

  await env.DB.batch([
    env.DB.prepare('DELETE FROM document_links WHERE from_doc_id = ? OR to_doc_id = ?').bind(id, id),
    env.DB.prepare('DELETE FROM documents WHERE id = ?').bind(id),
  ])

  return ok({ success: true, id })
}

// Tool: create_collection (write)
export async function createCollection(
  env: Env,
  auth: AiAuth,
  params: { name: string; description?: string; parent_id?: string }
): Promise<CallToolResult> {
  const { name, description, parent_id } = params

  // Collection-restricted API keys cannot create new collections
  if (auth.authorType === 'ai' && auth.allowedCollections !== null) {
    return err('This API key cannot create collections')
  }

  const author = authorOf(auth)
  const id = generateId('col')
  const now = Date.now()

  await env.DB.prepare(`
    INSERT INTO collections (
      id, name, parent_id, description, is_system, entrypoint_doc_id,
      created_by_type, created_by_key_id, updated_by_type, updated_by_key_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    name,
    parent_id || null,
    description || null,
    0, // is_system
    null, // entrypoint_doc_id
    author.authorType,
    author.apiKeyId,
    author.authorType,
    author.apiKeyId,
    now,
    now
  ).run()

  const collection = await env.DB.prepare('SELECT * FROM collections WHERE id = ?').bind(id).first()
  return ok(collection)
}
