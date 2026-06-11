// Document link extraction and sync.
// Notation: [[doc_xxx]] or [[doc_xxx|label]] — ID-based so links survive
// title changes. Links inside code fences are ignored.

const LINK_PATTERN = /\[\[(doc_[a-zA-Z0-9_-]+)(?:\|[^\]]*)?\]\]/g

export const extractLinkIds = (content: string): string[] => {
  const ids = new Set<string>()
  let inFence = false
  let fenceMarker = ''

  for (const line of content.split('\n')) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/)
    if (fenceMatch) {
      if (!inFence) {
        inFence = true
        fenceMarker = fenceMatch[1][0]
      } else if (fenceMatch[1][0] === fenceMarker) {
        inFence = false
      }
      continue
    }
    if (inFence) continue

    for (const match of line.matchAll(LINK_PATTERN)) {
      ids.add(match[1])
    }
  }

  return [...ids]
}

const generateId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

// Rebuilds the outgoing links of a document (DELETE → INSERT).
// Returns the IDs referenced in the content that do not exist (warnings).
export const syncDocumentLinks = async (
  db: D1Database,
  fromDocId: string,
  content: string
): Promise<string[]> => {
  const ids = extractLinkIds(content).filter((id) => id !== fromDocId)

  let found = new Set<string>()
  if (ids.length > 0) {
    const existing = await db.prepare(
      `SELECT id FROM documents WHERE id IN (${ids.map(() => '?').join(', ')})`
    ).bind(...ids).all()
    found = new Set(existing.results.map((r: any) => r.id))
  }

  const now = Date.now()
  const statements = [
    db.prepare('DELETE FROM document_links WHERE from_doc_id = ?').bind(fromDocId),
  ]
  for (const id of ids) {
    if (!found.has(id)) continue
    statements.push(
      db.prepare('INSERT INTO document_links (id, from_doc_id, to_doc_id, created_at) VALUES (?, ?, ?, ?)')
        .bind(generateId('link'), fromDocId, id, now)
    )
  }
  await db.batch(statements)

  return ids.filter((id) => !found.has(id))
}
