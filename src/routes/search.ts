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
      return c.json({ error: { code: 'MISSING_QUERY', message: 'Query parameter "q" is required' } }, 400)
    }

    const scope = c.req.query('scope') || ''
    const priority = c.req.query('priority') || ''
    const limit = parseInt(c.req.query('limit') || '10')

    // Parse scope (format: "collection:col_abc")
    let collectionId: string | null = null
    if (scope.startsWith('collection:')) {
      collectionId = scope.substring('collection:'.length)
    }

    // Build FTS5 search query
    // Escape special FTS characters
    const escapedQuery = query.replace(/["\]]/g, '')

    let sql = `
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

    const params: any[] = [escapedQuery] // FTS5 search

    const auth = c.get('auth')
    if (collectionId) {
      if (!isCollectionAllowed(auth, collectionId)) {
        return c.json({ error: { code: 'FORBIDDEN', message: 'Collection not allowed for this API key' } }, 403)
      }
      sql += ' AND d.collection_id = ?'
      params.push(collectionId)
    } else if (auth.authorType === 'ai' && auth.allowedCollections !== null) {
      if (auth.allowedCollections.length === 0) {
        return c.json([])
      }
      sql += ` AND d.collection_id IN (${auth.allowedCollections.map(() => '?').join(', ')})`
      params.push(...auth.allowedCollections)
    }

    if (priority) {
      sql += ' AND d.priority = ?'
      params.push(priority)
    }

    sql += ' LIMIT ?'
    params.push(limit)

    const results = await c.env.DB.prepare(sql).bind(...params).all()

    const formatted = results.results.map((r: any) => {
      // Extract a better snippet if FTS snippet is not great
      const snippet = extractSnippet(r.content, query)

      // Try to identify section from content
      const lines = r.content.split('\n')
      let section = ''
      for (const line of lines) {
        const match = line.match(/^#+\s+(.+)$/)
        if (match) {
          section = match[1]
          break
        }
      }

      return {
        id: r.id,
        title: r.title,
        snippet: snippet || r.content.substring(0, 200) + '...',
        score: r.score || 0,
        section: section || null,
        collection_id: r.collection_id
      }
    })

    return c.json(formatted)
  } catch (error: any) {
    console.error('Search error:', error)
    return c.json({ error: { code: 'SEARCH_ERROR', message: 'Search failed' } }, 500)
  }
})
