// HTML fragments for the Web UI (HTMX).
// All dynamic values are escaped — content here is written by AI agents and
// external services, so nothing is trusted.
import { Hono } from 'hono'
import { authorOf, isCollectionAllowed } from '../auth/adapter'
import type { AppEnv, AuthContext } from '../auth/adapter'
import { escapeHtml as esc, renderMarkdown } from '../services/markdown'
import { parseSections } from '../services/sections'
import { syncDocumentLinks } from '../services/links'
import { createRevision } from './documents'

export const uiRoute = new Hono<AppEnv>()

const generateId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

const fmtDate = (ts: number) =>
  new Date(ts).toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

// ---------------------------------------------------------------
// Shared renderers
// ---------------------------------------------------------------

// A tree link that swaps the reading pane and pushes the URL
const docLink = (id: string, title: string, extraClass = '', suffix = '') =>
  `<a class="tree-item ${extraClass}" data-doc-id="${esc(id)}" href="/?doc=${esc(id)}"
      hx-get="/ui/doc/${esc(id)}" hx-target="#doc-view" hx-push-url="/?doc=${esc(id)}">${esc(title)}${suffix}</a>`

const renderTree = async (c: any): Promise<string> => {
  const auth: AuthContext = c.get('auth')

  const [colsResult, docsResult] = await Promise.all([
    c.env.DB.prepare('SELECT id, name, parent_id FROM collections ORDER BY name').all(),
    c.env.DB.prepare(`
      SELECT id, title, collection_id, priority
      FROM documents WHERE status = 'published'
      ORDER BY updated_at DESC
    `).all(),
  ])

  const collections = (colsResult.results as any[]).filter((col) => isCollectionAllowed(auth, col.id))
  const docsByCollection = new Map<string, any[]>()
  for (const doc of docsResult.results as any[]) {
    if (!docsByCollection.has(doc.collection_id)) docsByCollection.set(doc.collection_id, [])
    docsByCollection.get(doc.collection_id)!.push(doc)
  }

  const renderGroup = (parentId: string | null, depth: number): string => {
    let html = ''
    for (const col of collections.filter((x) => x.parent_id === parentId)) {
      const docs = docsByCollection.get(col.id) ?? []
      // priority: high pinned on top, archive sinks to the bottom (dimmed)
      const sorted = [
        ...docs.filter((d) => d.priority === 'high'),
        ...docs.filter((d) => d.priority === 'normal'),
        ...docs.filter((d) => d.priority === 'archive'),
      ]
      html += `<section class="tree-group" style="--depth:${depth}">
        <div class="tree-head">
          <span class="tree-col-name">${esc(col.name)}</span>
          <details class="tree-new">
            <summary title="このコレクションにメモを追加">＋</summary>
            <form hx-post="/ui/docs" hx-target="#doc-view">
              <input type="hidden" name="collection_id" value="${esc(col.id)}">
              <input class="input" name="title" placeholder="タイトル(Enterで作成)" required autocomplete="off">
            </form>
          </details>
        </div>\n`
      for (const doc of sorted) {
        const cls = doc.priority === 'archive' ? 'is-archive' : ''
        const mark = doc.priority === 'high' ? '<span class="pri" title="priority: high">●</span>' : ''
        html += docLink(doc.id, doc.title, cls, mark) + '\n'
      }
      if (sorted.length === 0) {
        html += '<p class="tree-empty">まだメモがありません</p>\n'
      }
      html += renderGroup(col.id, depth + 1)
      html += '</section>\n'
    }
    return html
  }

  let html = '<nav class="tree" aria-label="ドキュメントツリー">\n'
  html += renderGroup(null, 0)
  if (collections.length === 0) {
    html += '<p class="tree-empty">まずコレクションを作成してください</p>\n'
  }
  html += `<details class="tree-new tree-new-col">
    <summary>＋ コレクション</summary>
    <form hx-post="/ui/collections" hx-target="#tree-area">
      <input class="input" name="name" placeholder="コレクション名(Enterで作成)" required autocomplete="off">
    </form>
  </details>\n`
  html += '</nav>\n'
  return html
}

const renderDoc = async (c: any, id: string): Promise<{ html: string } | { error: string; status: 404 | 403 }> => {
  const auth: AuthContext = c.get('auth')
  const doc = await c.env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first() as any
  if (!doc) return { error: 'ドキュメントが見つかりません', status: 404 }
  if (!isCollectionAllowed(auth, doc.collection_id)) return { error: 'このドキュメントへのアクセス権がありません', status: 403 }

  const [collection, lastRev, linksResult, backlinksResult] = await Promise.all([
    c.env.DB.prepare('SELECT name FROM collections WHERE id = ?').bind(doc.collection_id).first(),
    c.env.DB.prepare('SELECT author_type, api_key_name FROM document_revisions WHERE document_id = ? ORDER BY created_at DESC LIMIT 1').bind(id).first(),
    c.env.DB.prepare(`
      SELECT d.id, d.title FROM document_links l JOIN documents d ON d.id = l.to_doc_id
      WHERE l.from_doc_id = ? ORDER BY d.title
    `).bind(id).all(),
    c.env.DB.prepare(`
      SELECT d.id, d.title FROM document_links l JOIN documents d ON d.id = l.from_doc_id
      WHERE l.to_doc_id = ? ORDER BY d.title
    `).bind(id).all(),
  ])

  const linkTitles = new Map<string, string>((linksResult.results as any[]).map((r) => [r.id, r.title]))
  const body = renderMarkdown(doc.content, linkTitles)
  const sections = parseSections(doc.content)

  // TOC only when the document has real structure (design rule: <2 headings → none)
  let tocSidebar = ''
  let tocMobile = ''
  if (sections.length >= 2) {
    const items = sections.map((s) =>
      `<a href="#${esc(s.slug)}" style="--toc-depth:${s.level - 1}">${esc(s.title)}</a>`).join('\n')
    tocSidebar = `<nav class="doc-toc" aria-label="目次">${items}</nav>`
    tocMobile = `<details class="doc-toc-mobile"><summary>目次</summary><div>${items}</div></details>`
  }

  const author = lastRev
    ? (lastRev as any).author_type === 'ai'
      ? `ai${(lastRev as any).api_key_name ? `(${esc((lastRev as any).api_key_name)})` : ''}`
      : 'human'
    : ''

  let foot = ''
  const backlinks = backlinksResult.results as any[]
  if (backlinks.length > 0) {
    foot += `<section class="doc-backlinks">
      <h2>このページを参照しているページ</h2>
      ${backlinks.map((b) => docLink(b.id, b.title)).join('\n')}
    </section>\n`
  }

  const html = `
<div id="doc-view-inner" data-doc-id="${esc(doc.id)}" data-doc-title="${esc(doc.title)}">
  <div class="doc-head">
    <h1 class="doc-title">${esc(doc.title)}</h1>
    <button class="btn-quiet" hx-get="/ui/doc/${esc(doc.id)}/edit" hx-target="#doc-view">✎ 編集</button>
  </div>
  <p class="meta-line">${esc((collection as any)?.name ?? '')} ・ ${fmtDate(doc.updated_at)}${author ? ` ・ ${author}` : ''}</p>
  ${tocMobile}
  <div class="doc-columns">
    <article class="prose">${body}</article>
    ${tocSidebar}
  </div>
  ${foot}
  <form class="append-box" hx-post="/ui/doc/${esc(doc.id)}/append" hx-target="#doc-view">
    <textarea class="textarea" name="content" rows="2" placeholder="ここに追記…(そのまま末尾に足されます)" required></textarea>
    <button class="btn-primary" type="submit">追記</button>
  </form>
</div>`
  return { html }
}

const renderWelcome = async (c: any): Promise<string> => {
  const auth: AuthContext = c.get('auth')
  const result = await c.env.DB.prepare(`
    SELECT id, title, collection_id, updated_at FROM documents
    WHERE status = 'published' ORDER BY updated_at DESC LIMIT 10
  `).all()
  const docs = (result.results as any[]).filter((d) => isCollectionAllowed(auth, d.collection_id))

  let html = '<div id="doc-view-inner"><div class="doc-head"><h1 class="doc-title">最近のドキュメント</h1></div>\n'
  if (docs.length === 0) {
    html += '<p class="muted">まだ何もありません。左のツリーからコレクションとメモを作成してください。</p>'
  } else {
    html += '<nav class="tree">' + docs.map((d) => docLink(d.id, d.title)).join('\n') + '</nav>'
  }
  html += '</div>'
  return html
}

const errorFragment = (message: string) => `<p class="error">${esc(message)}</p>`

// ---------------------------------------------------------------
// Routes
// ---------------------------------------------------------------

// GET /ui/tree - Sidebar tree
uiRoute.get('/tree', async (c) => c.html(await renderTree(c)))

// GET /ui/search?q= - Incremental search results (empty query → tree)
uiRoute.get('/search', async (c) => {
  const auth = c.get('auth')
  const q = (c.req.query('q') ?? '').trim()
  if (q === '') return c.html(await renderTree(c))

  // FTS5 trigram cannot match queries shorter than 3 chars (common in Japanese) → LIKE fallback
  let result: { results: unknown[] }
  if ([...q].length < 3) {
    const like = `%${q}%`
    result = await c.env.DB.prepare(`
      SELECT id, title, content, collection_id FROM documents
      WHERE status = 'published' AND (title LIKE ? OR content LIKE ?)
      ORDER BY updated_at DESC LIMIT 15
    `).bind(like, like).all()
  } else {
    const escaped = q.replace(/["\]]/g, '')
    result = await c.env.DB.prepare(`
      SELECT d.id, d.title, d.content, d.collection_id
      FROM documents_fts JOIN documents d ON documents_fts.rowid = d.rowid
      WHERE documents_fts MATCH ? AND d.status = 'published'
      LIMIT 15
    `).bind(escaped).all().catch(() => ({ results: [] }))
  }

  const hits = (result.results as any[]).filter((r) => isCollectionAllowed(auth, r.collection_id))

  let html = '<nav class="tree" aria-label="検索結果">\n'
  if (hits.length === 0) {
    html += '<p class="tree-empty">見つかりませんでした</p>'
  }
  for (const hit of hits) {
    // 1-line snippet around the first match
    const lines = hit.content.split('\n')
    const line = lines.find((l: string) => l.toLowerCase().includes(q.toLowerCase())) ?? lines[0] ?? ''
    const snippet = line.slice(0, 80)
    html += `<a class="tree-item search-hit" data-doc-id="${esc(hit.id)}" href="/?doc=${esc(hit.id)}"
        hx-get="/ui/doc/${esc(hit.id)}" hx-target="#doc-view" hx-push-url="/?doc=${esc(hit.id)}">
        <span class="search-hit-title">${esc(hit.title)}</span>
        <span class="search-hit-snippet">${esc(snippet)}</span></a>\n`
  }
  html += '</nav>'
  return c.html(html)
})

// GET /ui/welcome - Empty state (recent documents)
uiRoute.get('/welcome', async (c) => c.html(await renderWelcome(c)))

// GET /ui/doc/:id - Reading view
uiRoute.get('/doc/:id', async (c) => {
  const result = await renderDoc(c, c.req.param('id'))
  if ('error' in result) return c.html(errorFragment(result.error), result.status)
  return c.html(result.html)
})

// GET /ui/doc/:id/edit - Editor
uiRoute.get('/doc/:id/edit', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')
  const doc = await c.env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first() as any
  if (!doc) return c.html(errorFragment('ドキュメントが見つかりません'), 404)
  if (!isCollectionAllowed(auth, doc.collection_id)) return c.html(errorFragment('アクセス権がありません'), 403)

  return c.html(`
<div id="doc-view-inner" data-doc-id="${esc(doc.id)}" data-doc-title="${esc(doc.title)}">
  <form hx-post="/ui/doc/${esc(doc.id)}/save" hx-target="#doc-view">
    <div class="doc-head">
      <input class="input doc-title-input" name="title" value="${esc(doc.title)}" required>
      <button class="btn-quiet" type="button" hx-get="/ui/doc/${esc(doc.id)}" hx-target="#doc-view">キャンセル</button>
      <button class="btn-primary" type="submit">保存</button>
    </div>
    <textarea class="textarea editor" name="content" placeholder="Markdownで書く。[[doc_xxx]] で他のドキュメントへリンク。">${esc(doc.content)}</textarea>
  </form>
  <p class="edit-foot">
    <button class="btn-quiet danger-link" hx-post="/ui/doc/${esc(doc.id)}/delete" hx-target="#doc-view"
            hx-confirm="このドキュメントを削除しますか?(変更履歴は残ります)">削除する</button>
  </p>
</div>`)
})

// Shared write path: update content/title, record revision, sync links
const saveDoc = async (c: any, id: string, title: string, content: string) => {
  const now = Date.now()
  await c.env.DB.prepare('UPDATE documents SET title = ?, content = ?, updated_at = ? WHERE id = ?')
    .bind(title, content, now, id).run()
  await createRevision(c.env.DB, id, title, content, authorOf(c.get('auth')), now)
  await syncDocumentLinks(c.env.DB, id, content)
}

// POST /ui/doc/:id/save
uiRoute.post('/doc/:id/save', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')
  const doc = await c.env.DB.prepare('SELECT collection_id FROM documents WHERE id = ?').bind(id).first() as any
  if (!doc) return c.html(errorFragment('ドキュメントが見つかりません'), 404)
  if (!isCollectionAllowed(auth, doc.collection_id)) return c.html(errorFragment('アクセス権がありません'), 403)

  const body = await c.req.parseBody()
  const title = String(body.title ?? '').trim()
  const content = String(body.content ?? '')
  if (!title) return c.html(errorFragment('タイトルを入力してください'), 400)

  await saveDoc(c, id, title, content)

  const result = await renderDoc(c, id)
  c.header('HX-Trigger', 'tree-refresh')
  return c.html('error' in result ? errorFragment(result.error) : result.html)
})

// POST /ui/doc/:id/append
uiRoute.post('/doc/:id/append', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')
  const doc = await c.env.DB.prepare('SELECT title, content, collection_id FROM documents WHERE id = ?').bind(id).first() as any
  if (!doc) return c.html(errorFragment('ドキュメントが見つかりません'), 404)
  if (!isCollectionAllowed(auth, doc.collection_id)) return c.html(errorFragment('アクセス権がありません'), 403)

  const body = await c.req.parseBody()
  const content = String(body.content ?? '').trim()
  if (!content) return c.html(errorFragment('内容を入力してください'), 400)

  const separator = doc.content === '' || doc.content.endsWith('\n\n') ? '' : doc.content.endsWith('\n') ? '\n' : '\n\n'
  await saveDoc(c, id, doc.title, doc.content + separator + content)

  const result = await renderDoc(c, id)
  c.header('HX-Trigger', 'tree-refresh')
  return c.html('error' in result ? errorFragment(result.error) : result.html)
})

// POST /ui/doc/:id/delete
uiRoute.post('/doc/:id/delete', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')
  const doc = await c.env.DB.prepare('SELECT collection_id FROM documents WHERE id = ?').bind(id).first() as any
  if (!doc) return c.html(errorFragment('ドキュメントが見つかりません'), 404)
  if (!isCollectionAllowed(auth, doc.collection_id)) return c.html(errorFragment('アクセス権がありません'), 403)

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM document_links WHERE from_doc_id = ? OR to_doc_id = ?').bind(id, id),
    c.env.DB.prepare('DELETE FROM documents WHERE id = ?').bind(id),
  ])

  c.header('HX-Trigger', 'tree-refresh')
  c.header('HX-Push-Url', '/')
  return c.html(await renderWelcome(c))
})

// POST /ui/docs - Create document (from the tree's inline form)
uiRoute.post('/docs', async (c) => {
  const auth = c.get('auth')
  const body = await c.req.parseBody()
  const title = String(body.title ?? '').trim()
  const collectionId = String(body.collection_id ?? '')
  if (!title || !collectionId) return c.html(errorFragment('タイトルが必要です'), 400)
  if (!isCollectionAllowed(auth, collectionId)) return c.html(errorFragment('アクセス権がありません'), 403)

  const author = authorOf(auth)
  const id = generateId('doc')
  const now = Date.now()
  await c.env.DB.prepare(`
    INSERT INTO documents (id, title, content, collection_id, parent_id, path, priority, status, created_by_type, created_by_key_id, created_at, updated_at)
    VALUES (?, ?, '', ?, NULL, ?, 'normal', 'published', ?, ?, ?, ?)
  `).bind(id, title, collectionId, `/${collectionId}/${id}`, author.authorType, author.apiKeyId, now, now).run()
  await createRevision(c.env.DB, id, title, '', author, now)

  const result = await renderDoc(c, id)
  c.header('HX-Trigger', 'tree-refresh')
  c.header('HX-Push-Url', `/?doc=${id}`)
  return c.html('error' in result ? errorFragment(result.error) : result.html)
})

// POST /ui/collections - Create collection (from the tree's inline form)
uiRoute.post('/collections', async (c) => {
  const auth = c.get('auth')
  if (auth.authorType === 'ai' && auth.allowedCollections !== null) {
    return c.html(errorFragment('このキーではコレクションを作成できません'), 403)
  }
  const body = await c.req.parseBody()
  const name = String(body.name ?? '').trim()
  if (!name) return c.html(errorFragment('名前が必要です'), 400)

  const author = authorOf(auth)
  const now = Date.now()
  await c.env.DB.prepare(`
    INSERT INTO collections (id, name, parent_id, description, is_system, entrypoint_doc_id,
      created_by_type, created_by_key_id, updated_by_type, updated_by_key_id, created_at, updated_at)
    VALUES (?, ?, NULL, NULL, 0, NULL, ?, ?, ?, ?, ?, ?)
  `).bind(generateId('col'), name, author.authorType, author.apiKeyId, author.authorType, author.apiKeyId, now, now).run()

  return c.html(await renderTree(c))
})
