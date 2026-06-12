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

// GET /search/html - Render search results as HTML (for HTMX)
searchRoute.get('/html', async (c) => {
  try {
    const query = c.req.query('q')
    if (!query) {
      return c.html('<p class="muted">キーワードを入力してください</p>')
    }

    const scope = c.req.query('scope') || ''
    const limit = parseInt(c.req.query('limit') || '10')

    // Parse scope (format: "collection:col_abc")
    let collectionId: string | null = null
    if (scope.startsWith('collection:')) {
      collectionId = scope.substring('collection:'.length)
    }

    // Build FTS5 search query
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

    const params: any[] = [escapedQuery]

    const auth = c.get('auth')
    if (collectionId) {
      if (!isCollectionAllowed(auth, collectionId)) {
        return c.html('<p class="error">アクセス権限がありません</p>', 403)
      }
      sql += ' AND d.collection_id = ?'
      params.push(collectionId)
    } else if (auth.authorType === 'ai' && auth.allowedCollections !== null) {
      if (auth.allowedCollections.length === 0) {
        return c.html('<p class="muted">結果がありません</p>')
      }
      sql += ` AND d.collection_id IN (${auth.allowedCollections.map(() => '?').join(', ')})`
      params.push(...auth.allowedCollections)
    }

    sql += ' LIMIT ?'
    params.push(limit)

    const results = await c.env.DB.prepare(sql).bind(...params).all()

    let html = '<div style="display:flex; flex-direction:column; gap:var(--space-2)">\n'
    for (const r of results.results) {
      const snippet = extractSnippet(r.content, query)
      html += `  <a href="/doc.html?id=${r.id}" class="tree-item" style="flex-direction:column; align-items:start; padding:var(--space-3) var(--space-4); height:auto">\n`
      html += `    <div style="font-weight:600; font-size:var(--text-sm)">${r.title}</div>\n`
      html += `    <pre style="margin:var(--space-1) 0 0 0; font-size:var(--text-xs); background:transparent; border:none; padding:0; color:var(--text-muted); white-space:pre-wrap; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden"><code>${snippet}</code></pre>\n`
      html += `  </a>\n`
    }
    if (results.results.length === 0) {
      html += '  <div class="muted" style="padding:var(--space-4)">No results found.</div>\n'
    }
    html += '</div>\n'
    return c.html(html)
  } catch (error: any) {
    console.error('Search error:', error)
    return c.html('<p class="error">検索に失敗しました</p>', 500)
  }
})

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
    const params: any[] = [escapedQuery]

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
