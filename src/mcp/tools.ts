// MCP tool handlers for ContextMixer
// These wrap the existing services and routes to provide MCP-accessible tools

import type { AppEnv } from '../auth/adapter'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

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

// Tool: search_docs
export async function searchDocs(
  env: AppEnv['Bindings'],
  params: { q: string; scope?: string; limit?: number }
): Promise<CallToolResult> {
  try {
    const { q, scope = '', limit = 10 } = params

    if (!q) {
      return {
        content: [{ type: 'text', text: 'Error: Query parameter "q" is required' }],
        isError: true
      }
    }

    let collectionId: string | null = null
    if (scope.startsWith('collection:')) {
      collectionId = scope.substring('collection:'.length)
    }

    // FTS5 trigram cannot match queries shorter than 3 chars → LIKE fallback
    let sql: string
    const sqlParams: any[] = []

    if ([...q].length < 3) {
      sql = `
        SELECT d.id, d.title, d.content, d.collection_id, d.priority, d.status
        FROM documents d
        WHERE d.status = 'published' AND (d.title LIKE ? OR d.content LIKE ?)
      `
      sqlParams.push(`%${q}%`, `%${q}%`)
    } else {
      sql = `
        SELECT d.id, d.title, d.content, d.collection_id, d.priority, d.status
        FROM documents_fts
        JOIN documents d ON documents_fts.rowid = d.rowid
        WHERE documents_fts MATCH ? AND d.status = 'published'
      `
      sqlParams.push(q.replace(/["\]]/g, ''))
    }

    if (collectionId) {
      sql += ' AND d.collection_id = ?'
      sqlParams.push(collectionId)
    }

    sql += ' LIMIT ?'
    sqlParams.push(limit)

    const result = await env.DB.prepare(sql).bind(...sqlParams).all()

    const results = result.results.map((r: any) => ({
      id: r.id,
      title: r.title,
      snippet: extractSnippet(r.content, q),
      collection_id: r.collection_id,
      priority: r.priority,
    }))

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ data: results }, null, 2)
      }]
    }
  } catch (error: any) {
    console.error('Search error:', error)
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true
    }
  }
}

// Tool: get_doc
export async function getDoc(
  env: AppEnv['Bindings'],
  params: { id: string; view?: string }
): Promise<CallToolResult> {
  try {
    const { id, view = 'full' } = params

    if (view === 'meta') {
      const doc = await env.DB.prepare(
        'SELECT * FROM documents WHERE id = ?'
      ).bind(id).first() as any

      if (!doc) {
        return {
          content: [{ type: 'text', text: 'Error: Document not found' }],
          isError: true
        }
      }

      // Extract sections from markdown headings
      const sections = doc.content.match(/^#+\s+.+$/gm) || []
      const sectionList = sections.map((s: string, i: number) => ({
        slug: `section-${i}`,
        title: s.replace(/^#+\s+/, ''),
        level: s.match(/^#+/)?.[0].length || 1
      }))

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            id: doc.id,
            title: doc.title,
            collection_id: doc.collection_id,
            parent_id: doc.parent_id,
            path: doc.path,
            priority: doc.priority,
            status: doc.status,
            sections: sectionList,
            created_at: doc.created_at,
            updated_at: doc.updated_at
          }, null, 2)
        }]
      }
    }

    if (view === 'outline') {
      const doc = await env.DB.prepare('SELECT content FROM documents WHERE id = ?').bind(id).first() as any
      if (!doc) {
        return {
          content: [{ type: 'text', text: 'Error: Document not found' }],
          isError: true
        }
      }

      const headings = doc.content.match(/^#+\s+.+$/gm) || []
      const outline = headings.map((h: string) => ({
        level: h.match(/^#+/)?.[0].length || 1,
        title: h.replace(/^#+\s+/, '')
      }))

      return {
        content: [{ type: 'text', text: JSON.stringify({ outline }, null, 2) }]
      }
    }

    // view === 'full' (default)
    const doc = await env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first() as any
    if (!doc) {
      return {
        content: [{ type: 'text', text: 'Error: Document not found' }],
        isError: true
      }
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(doc, null, 2) }]
    }
  } catch (error: any) {
    console.error('Get doc error:', error)
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true
    }
  }
}

// Tool: write_doc (create or update)
export async function writeDoc(
  env: AppEnv['Bindings'],
  params: { id?: string; title: string; content: string; collection_id: string }
): Promise<CallToolResult> {
  try {
    const { id, title, content, collection_id } = params

    const now = Date.now()
    const authorType = 'ai' // MCP writes are always from AI

    if (id) {
      // Update existing document
      const existing = await env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first()
      if (!existing) {
        return {
          content: [{ type: 'text', text: 'Error: Document not found' }],
          isError: true
        }
      }

      await env.DB.prepare(`
        UPDATE documents SET title = ?, content = ?, updated_at = ? WHERE id = ?
      `).bind(title, content, now, id).run()

      // Create revision
      const revId = `rev_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      await env.DB.prepare(`
        INSERT INTO document_revisions (id, document_id, title, content, author_type, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(revId, id, title, content, authorType, now).run()

      const updated = await env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first()
      return {
        content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }]
      }
    } else {
      // Create new document
      const docId = `doc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

      // Build path
      let path = `/${collection_id}/${docId}`

      await env.DB.prepare(`
        INSERT INTO documents (id, title, content, collection_id, path, priority, status, created_by_type, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(docId, title, content, collection_id, path, 'normal', 'published', authorType, now, now).run()

      // Create revision
      const revId = `rev_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      await env.DB.prepare(`
        INSERT INTO document_revisions (id, document_id, title, content, author_type, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(revId, docId, title, content, authorType, now).run()

      const doc = await env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(docId).first()
      return {
        content: [{ type: 'text', text: JSON.stringify(doc, null, 2) }]
      }
    }
  } catch (error: any) {
    console.error('Write doc error:', error)
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true
    }
  }
}

// Tool: append_doc
export async function appendDoc(
  env: AppEnv['Bindings'],
  params: { id: string; content: string }
): Promise<CallToolResult> {
  try {
    const { id, content } = params

    const existing = await env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first() as any
    if (!existing) {
      return {
        content: [{ type: 'text', text: 'Error: Document not found' }],
        isError: true
      }
    }

    const updatedContent = existing.content + '\n\n' + content
    const now = Date.now()
    const authorType = 'ai'

    await env.DB.prepare(`
      UPDATE documents SET content = ?, updated_at = ? WHERE id = ?
    `).bind(updatedContent, now, id).run()

    // Create revision
    const revId = `rev_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    await env.DB.prepare(`
      INSERT INTO document_revisions (id, document_id, title, content, author_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(revId, id, existing.title, updatedContent, authorType, now).run()

    const updated = await env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first()
    return {
      content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }]
    }
  } catch (error: any) {
    console.error('Append doc error:', error)
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true
    }
  }
}

// Tool: list_collections
export async function listCollections(
  env: AppEnv['Bindings']
): Promise<CallToolResult> {
  try {
    const result = await env.DB.prepare(`
      SELECT id, name, parent_id, description, is_system, entrypoint_doc_id,
             created_by_type, updated_by_type, created_at, updated_at
      FROM collections
      ORDER BY name
    `).all()

    return {
      content: [{ type: 'text', text: JSON.stringify(result.results, null, 2) }]
    }
  } catch (error: any) {
    console.error('List collections error:', error)
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true
    }
  }
}

// Tool: get_entrypoint
export async function getEntrypoint(
  env: AppEnv['Bindings'],
  params: { collection_id?: string }
): Promise<CallToolResult> {
  try {
    const { collection_id } = params

    if (collection_id) {
      // Get collection entry point
      const collection = await env.DB.prepare(`
        SELECT entrypoint_doc_id FROM collections WHERE id = ?
      `).bind(collection_id).first() as any

      if (!collection || !collection.entrypoint_doc_id) {
        return {
          content: [{ type: 'text', text: 'Error: No entry point document set for this collection' }],
          isError: true
        }
      }

      const doc = await env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(collection.entrypoint_doc_id).first()
      return {
        content: [{ type: 'text', text: JSON.stringify(doc, null, 2) }]
      }
    } else {
      // Get workspace entry point (list all collections with their entry points)
      const result = await env.DB.prepare(`
        SELECT c.id, c.name, c.entrypoint_doc_id, d.title as entry_doc_title
        FROM collections c
        LEFT JOIN documents d ON c.entrypoint_doc_id = d.id
        ORDER BY c.name
      `).all()

      return {
        content: [{ type: 'text', text: JSON.stringify(result.results, null, 2) }]
      }
    }
  } catch (error: any) {
    console.error('Get entrypoint error:', error)
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true
    }
  }
}
