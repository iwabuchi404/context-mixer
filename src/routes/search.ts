import { Hono } from 'hono'
import { isCollectionAllowed } from '../auth/adapter'
import type { AppEnv } from '../auth/adapter'

export const searchRoute = new Hono<AppEnv>()

// Helper: Extract snippet with context
const extractSnippet = (content: string, query: string, contextLines: number = 3): string => {
  const lines = content.split('\n')
  const queryLower = query.toLowerCase()

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(queryLower)) {
      const start = Math.max(0, i - contextLines)
      const end = Math.min(lines.length, i + contextLines + 1)
      return lines.slice(start, end).join('\n')
    }
  }

  // Fallback: return first few lines
  return lines.slice(0, contextLines * 2).join('\n')
}

// GET /search - Full-text search
searchRoute.get('/', async (c) => {
  try {
    const query = c.req.query('q')
    if (!query) {
      return c.json({ error: { code: 'INVALID_QUERY', message: 'Query is required' } }, 400)
    }

    const scope = c.req.query('scope') || ''
    const limit = parseInt(c.req.query('limit') || '10')

    let collectionId: string | null = null
    if (scope.startsWith('collection:')) {
      collectionId = scope.substring('collection:'.length)
    }

    // FTS5 trigram cannot match queries shorter than 3 chars (common in Japanese) → LIKE fallback
    let sql: string
    const params: any[] = []

    if ([...query].length < 3) {
      sql = `
        SELECT d.id, d.title, d.content, d.collection_id, d.priority, d.status
        FROM documents d
        WHERE d.status = 'published' AND (d.title LIKE ? OR d.content LIKE ?)
      `
      params.push(`%${query}%`, `%${query}%`)
    } else {
      sql = `
        SELECT
          d.id,
          d.title,
          d.content,
          d.collection_id,
          d.priority,
          d.status
        FROM documents_fts
        JOIN documents d ON documents_fts.rowid = d.rowid
        WHERE documents_fts MATCH ? AND d.status = 'published'
      `
      params.push(query.replace(/["\]]/g, ''))
    }

    const auth = c.get('auth')
    if (collectionId) {
      if (!isCollectionAllowed(auth, collectionId)) {
        return c.json({ error: { code: 'FORBIDDEN', message: 'Collection not allowed' } }, 403)
      }
      sql += ' AND d.collection_id = ?'
      params.push(collectionId)
    } else if (auth.authorType === 'ai' && auth.allowedCollections !== null) {
      if (auth.allowedCollections.length === 0) {
        return c.json({ data: [] })
      }
      sql += ` AND d.collection_id IN (${auth.allowedCollections.map(() => '?').join(', ')})`
      params.push(...auth.allowedCollections)
    }

    sql += ' LIMIT ?'
    params.push(limit)

    const result = await c.env.DB.prepare(sql).bind(...params).all()

    const results = result.results.map((r: any) => ({
      id: r.id,
      title: r.title,
      snippet: extractSnippet(r.content, query),
      collection_id: r.collection_id,
      priority: r.priority,
    }))

    return c.json({ data: results })
  } catch (error: any) {
    console.error('Search error:', error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Search failed' } }, 500)
  }
})
