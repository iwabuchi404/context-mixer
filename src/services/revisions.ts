// Revision management helpers.
// Provides idempotency (skip duplicate revisions), optimistic concurrency
// (version), and retention (keep the latest 20 per document).

import { authorOf, isCollectionAllowed, ownerUserIdOf, type AuthContext } from '../auth/adapter'
import { buildLinkSyncStatements } from './links'

const generateId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

// Hash the revision snapshot (title + content) for idempotency checks.
export const hashRevision = async (title: string, content: string): Promise<string> => {
  const data = new TextEncoder().encode(`${title}\0${content}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// Returns the latest revision's content_hash, or null if none exists.
export const getLatestRevisionHash = async (db: D1Database, docId: string): Promise<string | null> => {
  const row = await db.prepare(`
    SELECT content_hash FROM document_revisions
    WHERE document_id = ? ORDER BY created_at DESC LIMIT 1
  `).bind(docId).first() as { content_hash: string } | null
  return row?.content_hash ?? null
}

// Prepared statement to insert a revision snapshot.
export const createRevisionStatement = (
  db: D1Database,
  docId: string,
  title: string,
  content: string,
  contentHash: string,
  author: ReturnType<typeof authorOf>,
  now: number
): D1PreparedStatement =>
  db.prepare(`
    INSERT INTO document_revisions (id, document_id, title, content, content_hash, author_type, api_key_id, api_key_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(generateId('rev'), docId, title, content, contentHash, author.authorType, author.apiKeyId, author.apiKeyName, now)

// Prepared statement to delete revisions beyond the 20 most recent for a document.
export const pruneRevisionsStatement = (db: D1Database, docId: string): D1PreparedStatement =>
  db.prepare(`
    DELETE FROM document_revisions
    WHERE id IN (
      SELECT id FROM document_revisions
      WHERE document_id = ?
      ORDER BY created_at DESC
      LIMIT -1 OFFSET 20
    )
  `).bind(docId)

// Result type for updateDocument.
export type UpdateResult =
  | { ok: true; warnings: string[] }
  | { ok: false; code: 'CONFLICT' | 'NOT_FOUND' }

// Create a new document, its initial revision, and sync links.
// Returns the new document id and any link warnings.
export const createDocument = async (
  db: D1Database,
  auth: AuthContext,
  id: string,
  title: string,
  content: string,
  collectionId: string,
  parentId: string | null,
  path: string,
  now: number
): Promise<{ id: string; warnings: string[] }> => {
  const author = authorOf(auth)
  const contentHash = await hashRevision(title, content)

  const { statements: linkStatements, warnings } = await buildLinkSyncStatements(db, id, content, auth)

  await db.batch([
    db.prepare(`
      INSERT INTO documents (id, title, content, collection_id, parent_id, path, priority, status, version, created_by_type, created_by_key_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'normal', 'published', 0, ?, ?, ?, ?)
    `).bind(id, title, content, collectionId, parentId, path, author.authorType, author.apiKeyId, now, now),
    createRevisionStatement(db, id, title, content, contentHash, author, now),
    ...linkStatements,
    pruneRevisionsStatement(db, id),
  ])

  return { id, warnings }
}

// Update a document with optimistic concurrency control.
// If expectedVersion does not match the current version, returns CONFLICT.
// If the (title, content) hash equals the latest revision hash, skips revision creation.
export const updateDocument = async (
  db: D1Database,
  auth: AuthContext,
  id: string,
  existing: { title: string; content: string; version: number },
  changes: { title?: string; content?: string; priority?: string; status?: string },
  expectedVersion: number,
  now: number
): Promise<UpdateResult> => {
  // Compute post-update values.
  const newTitle = changes.title !== undefined ? changes.title : existing.title
  const newContent = changes.content !== undefined ? changes.content : existing.content

  // Build the UPDATE statement dynamically.
  const updates: string[] = ['updated_at = ?', 'version = version + 1']
  const params: any[] = [now]

  if (changes.title !== undefined) {
    updates.push('title = ?')
    params.push(changes.title)
  }
  if (changes.content !== undefined) {
    updates.push('content = ?')
    params.push(changes.content)
  }
  if (changes.priority !== undefined) {
    updates.push('priority = ?')
    params.push(changes.priority)
  }
  if (changes.status !== undefined) {
    updates.push('status = ?')
    params.push(changes.status)
  }

  params.push(id, expectedVersion)

  // Step 1: optimistic update. If no rows changed, the version was stale.
  const updateResult = await db.prepare(`
    UPDATE documents SET ${updates.join(', ')} WHERE id = ? AND version = ?
  `).bind(...params).run()

  if (updateResult.meta.changes === 0) {
    // Verify the document exists so we can distinguish NOT_FOUND from CONFLICT.
    const exists = await db.prepare('SELECT 1 FROM documents WHERE id = ?').bind(id).first()
    return { ok: false, code: exists ? 'CONFLICT' : 'NOT_FOUND' }
  }

  // Step 2: revision, links, prune — only run if the document was actually updated.
  const newHash = await hashRevision(newTitle, newContent)
  const latestHash = await getLatestRevisionHash(db, id)
  const shouldSkipRevision = latestHash === newHash

  const { statements: linkStatements, warnings } = changes.content !== undefined
    ? await buildLinkSyncStatements(db, id, newContent, auth)
    : { statements: [] as any[], warnings: [] }

  const batch: D1PreparedStatement[] = []
  if (!shouldSkipRevision) {
    batch.push(createRevisionStatement(db, id, newTitle, newContent, newHash, authorOf(auth), now))
  }
  batch.push(...linkStatements)
  batch.push(pruneRevisionsStatement(db, id))

  if (batch.length > 0) {
    await db.batch(batch)
  }

  return { ok: true, warnings }
}

// Move a document (and its descendants) to another collection/parent.
// Returns ok=false when the target collection is not allowed/owned, or the
// document/parent is not found.
export const moveDocument = async (
  db: D1Database,
  auth: AuthContext,
  id: string,
  targetCollectionId: string,
  newParentId: string | null
): Promise<{ ok: true } | { ok: false; code: 'FORBIDDEN' | 'NOT_FOUND' | 'BAD_REQUEST' | 'INTERNAL_ERROR'; message: string }> => {
  const uid = ownerUserIdOf(auth)

  // Target collection must exist and be owned by the user.
  const targetCol = await db.prepare('SELECT id FROM collections WHERE id = ? AND owner_user_id = ?')
    .bind(targetCollectionId, uid).first()
  if (!targetCol) {
    return { ok: false, code: 'FORBIDDEN', message: 'Target collection not found or not owned' }
  }
  if (!isCollectionAllowed(auth, targetCollectionId)) {
    return { ok: false, code: 'FORBIDDEN', message: 'Target collection not allowed for this key' }
  }

  // Document must exist and be owned by the user.
  const doc = await db.prepare(`
    SELECT d.* FROM documents d
    JOIN collections c ON d.collection_id = c.id
    WHERE d.id = ? AND c.owner_user_id = ?
  `).bind(id, uid).first() as any
  if (!doc) {
    return { ok: false, code: 'NOT_FOUND', message: 'Document not found' }
  }

  // Build new path.
  let newPath: string
  if (newParentId) {
    const parent = await db.prepare(`
      SELECT d.id, d.collection_id, d.path FROM documents d
      JOIN collections c ON d.collection_id = c.id
      WHERE d.id = ? AND c.owner_user_id = ?
    `).bind(newParentId, uid).first() as any
    if (!parent) {
      return { ok: false, code: 'NOT_FOUND', message: 'Parent document not found' }
    }
    if (parent.collection_id !== targetCollectionId) {
      return { ok: false, code: 'BAD_REQUEST', message: 'Parent document must be in the target collection' }
    }
    // Prevent moving a document under its own descendant.
    if (parent.path.startsWith(`${doc.path}/`)) {
      return { ok: false, code: 'BAD_REQUEST', message: 'Cannot move a document under its own descendant' }
    }
    newPath = `${parent.path}/${id}`
  } else {
    newPath = `/${targetCollectionId}/${id}`
  }

  // Find descendants to update their paths.
  const descendants = await db.prepare(`
    SELECT id, path FROM documents
    WHERE path LIKE ? AND id != ?
  `).bind(`${doc.path}/%`, id).all() as { results: { id: string; path: string }[] }

  const oldPrefix = doc.path
  const newPrefix = newPath

  const batch: D1PreparedStatement[] = [
    db.prepare('UPDATE documents SET collection_id = ?, parent_id = ?, path = ?, updated_at = ? WHERE id = ?')
      .bind(targetCollectionId, newParentId, newPath, Date.now(), id),
  ]

  for (const d of descendants.results) {
    const movedPath = d.path.replace(oldPrefix, newPrefix)
    const parts = movedPath.split('/').filter(Boolean)
    const movedParentId = parts.length > 2 ? parts[parts.length - 2] : null
    batch.push(
      db.prepare('UPDATE documents SET collection_id = ?, parent_id = ?, path = ? WHERE id = ?')
        .bind(targetCollectionId, movedParentId, movedPath, d.id)
    )
  }

  // D1 batch supports up to 100 statements; split if needed.
  const BATCH_SIZE = 100
  for (let i = 0; i < batch.length; i += BATCH_SIZE) {
    await db.batch(batch.slice(i, i + BATCH_SIZE))
  }

  return { ok: true }
}
