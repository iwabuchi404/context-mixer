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
import { renderInboxList } from './inbox'
import { renderFilesList } from './files'

export const uiRoute = new Hono<AppEnv>()

// Admin list fragments live under /ui/* so they aren't shadowed by the
// static assets at /inbox.html and /files.html (extensionless asset serving
// would otherwise intercept GET /inbox and GET /files).
uiRoute.get('/inbox', async (c) => c.html(await renderInboxList(c)))
uiRoute.get('/files', async (c) => c.html(await renderFilesList(c)))

const generateId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

// ISO-style timestamp, fixed to JST (Workers runtime is UTC in production)
const fmtDate = (ts: number) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(ts))

// HX-Trigger helper: shows a system-line message and optionally refreshes the tree.
// HTTP headers are Latin-1, so non-ASCII chars must use JSON \uXXXX escapes.
const notify = (c: any, message: string, treeRefresh = true) => {
  const events: Record<string, unknown> = { sysline: message }
  if (treeRefresh) events['tree-refresh'] = true
  const json = JSON.stringify(events).replace(/[\u0080-\uffff]/g,
    (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))
  c.header('HX-Trigger', json)
}

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
      SELECT id, title, collection_id, parent_id, priority
      FROM documents WHERE status = 'published'
      ORDER BY updated_at DESC
    `).all(),
  ])

  const collections = (colsResult.results as any[]).filter((col) => isCollectionAllowed(auth, col.id))
  const docsByParent = new Map<string, Map<string | null, any[]>>()
  for (const doc of docsResult.results as any[]) {
    if (!docsByParent.has(doc.collection_id)) docsByParent.set(doc.collection_id, new Map())
    const parentMap = docsByParent.get(doc.collection_id)!
    const pid = doc.parent_id || null
    if (!parentMap.has(pid)) parentMap.set(pid, [])
    parentMap.get(pid)!.push(doc)
  }

  // Render documents recursively with hierarchy support (depth cap guards against parent_id cycles)
  const renderDocs = (collectionId: string, parentId: string | null, docDepth: number): string => {
    if (docDepth > 20) return ''
    const parentMap = docsByParent.get(collectionId)
    if (!parentMap) return ''
    const docs = parentMap.get(parentId) ?? []
    // priority: high pinned on top, archive sinks to the bottom (dimmed)
    const sorted = [
      ...docs.filter((d) => d.priority === 'high'),
      ...docs.filter((d) => d.priority === 'normal'),
      ...docs.filter((d) => d.priority === 'archive'),
    ]
    let html = ''
    for (const doc of sorted) {
      const cls = doc.priority === 'archive' ? 'is-archive' : ''
      const mark = doc.priority === 'high' ? '<span class="pri" title="priority: high">●</span>' : ''
      html += `<div class="tree-doc-item" style="--doc-depth:${docDepth}">
        ${docLink(doc.id, doc.title, cls, mark)}
        <button class="doc-add-btn" type="button" title="子ドキュメントを追加"
                hx-get="/ui/doc/${esc(doc.id)}/new-child" hx-target="#doc-view">＋</button>
      </div>\n`
      // Render children recursively
      html += renderDocs(collectionId, doc.id, docDepth + 1)
    }
    return html
  }

  const renderGroup = (parentId: string | null, depth: number): string => {
    let html = ''
    for (const col of collections.filter((x) => x.parent_id === parentId)) {
      // collection name navigates to the collections page; the toggle icon
      // (separate, on the right) collapses the group (state kept client-side)
      html += `<section class="tree-group" data-col-id="${esc(col.id)}" style="--depth:${depth}">
        <div class="tree-head">
          <a class="tree-col-name" href="/?view=collections"
             hx-get="/ui/collections" hx-target="#doc-view" hx-push-url="/?view=collections">${esc(col.name)}</a>
          <button class="tree-toggle" type="button" aria-label="折りたたみ">▾</button>
        </div>
        <div class="tree-children">\n`
      // Render documents with hierarchy (root docs only, parent_id=null)
      html += renderDocs(col.id, null, 0)
      // add-doc form sits at the bottom of the document list, indented one level
      html += `<details class="tree-new tree-new-doc">
        <summary>＋ メモを追加</summary>
        <form hx-post="/ui/docs" hx-target="#doc-view">
          <input type="hidden" name="collection_id" value="${esc(col.id)}">
          <input class="input" name="title" placeholder="タイトル" required autocomplete="off">
          <button class="btn btn-sm" type="submit">作成</button>
        </form>
      </details>\n`
      html += renderGroup(col.id, depth + 1)
      html += '</div></section>\n'
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
      <input class="input" name="name" placeholder="コレクション名" required autocomplete="off">
      <button class="btn btn-sm" type="submit">作成</button>
    </form>
  </details>\n`
  html += '</nav>\n'
  return html
}

// Header row of a collection block on the management page.
// editing=true swaps the plain title for a rename form.
const colHead = (col: { id: string; name: string }, count: number, editing = false): string => {
  if (editing) {
    return `<div class="col-head" id="col-head-${esc(col.id)}">
      <form hx-post="/ui/collections/${esc(col.id)}/rename" hx-target="#doc-view">
        <input class="input col-name-input" name="name" value="${esc(col.name)}" required autofocus>
        <button class="btn btn-sm" type="submit">保存</button>
        <button class="btn-quiet btn-sm" type="button"
                hx-get="/ui/collections/${esc(col.id)}/head" hx-target="#col-head-${esc(col.id)}" hx-swap="outerHTML">キャンセル</button>
      </form>
    </div>`
  }
  return `<div class="col-head" id="col-head-${esc(col.id)}">
    <h2 class="col-title">${esc(col.name)}</h2>
    <span class="muted col-count">${count}件</span>
    <button class="btn-quiet btn-sm" type="button"
            hx-get="/ui/collections/${esc(col.id)}/head?edit=1" hx-target="#col-head-${esc(col.id)}" hx-swap="outerHTML">名前を変更</button>
    <button class="btn-quiet danger-link btn-sm" type="button"
            hx-post="/ui/collections/${esc(col.id)}/delete" hx-target="#doc-view"
            hx-confirm="コレクション「${esc(col.name)}」を削除しますか?">削除</button>
  </div>`
}

// Collection management page (rendered into the reading pane)
const renderCollectionsPage = async (c: any, errorMessage?: string): Promise<string> => {
  const auth: AuthContext = c.get('auth')
  const [colsResult, docsResult] = await Promise.all([
    c.env.DB.prepare('SELECT id, name, parent_id FROM collections ORDER BY name').all(),
    c.env.DB.prepare(`
      SELECT id, title, collection_id, parent_id FROM documents
      WHERE status = 'published' ORDER BY updated_at DESC
    `).all(),
  ])
  const collections = (colsResult.results as any[]).filter((col) => isCollectionAllowed(auth, col.id))
  const docsByCollection = new Map<string, Map<string | null, any[]>>()
  for (const doc of docsResult.results as any[]) {
    if (!docsByCollection.has(doc.collection_id)) docsByCollection.set(doc.collection_id, new Map())
    const parentMap = docsByCollection.get(doc.collection_id)!
    const pid = doc.parent_id || null
    if (!parentMap.has(pid)) parentMap.set(pid, [])
    parentMap.get(pid)!.push(doc)
  }

  const renderDocTree = (collectionId: string, parentId: string | null, depth: number): string => {
    if (depth > 20) return ''
    const parentMap = docsByCollection.get(collectionId)
    if (!parentMap) return ''
    const docs = parentMap.get(parentId) ?? []
    let html = ''
    for (const doc of docs) {
      html += `<div style="padding-left: ${depth * 16}px;">${docLink(doc.id, doc.title)}</div>\n`
      html += renderDocTree(collectionId, doc.id, depth + 1)
    }
    return html
  }

  const countDocs = (collectionId: string): number => {
    const parentMap = docsByCollection.get(collectionId)
    if (!parentMap) return 0
    return Array.from(parentMap.values()).reduce((s, a) => s + a.length, 0)
  }

  const blocks = (parentId: string | null, depth: number): string => {
    let html = ''
    for (const col of collections.filter((x) => x.parent_id === parentId)) {
      const docCount = countDocs(col.id)
      html += `<section class="col-block" style="--depth:${depth}">
        ${colHead(col, docCount)}
        <nav class="tree col-docs">
          ${renderDocTree(col.id, null, 0)}
          ${docCount === 0 ? '<p class="tree-empty">まだメモがありません</p>' : ''}
        </nav>
      </section>\n`
      html += blocks(col.id, depth + 1)
    }
    return html
  }

  return `
<div id="doc-view-inner" data-doc-title="コレクション">
  <div class="doc-head"><h1 class="doc-title">コレクション</h1></div>
  <p class="meta-line">${collections.length}個のコレクション</p>
  ${errorMessage ? `<p class="error">${esc(errorMessage)}</p>` : ''}
  ${blocks(null, 0)}
  <form class="col-new" hx-post="/ui/collections" hx-target="#doc-view">
    <input type="hidden" name="view" value="page">
    <input class="input" name="name" placeholder="新しいコレクション名" required autocomplete="off">
    <button class="btn-primary" type="submit">追加</button>
  </form>
</div>`
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
      ? `<span class="author-tag">ai${(lastRev as any).api_key_name ? `:${esc((lastRev as any).api_key_name)}` : ''}</span>`
      : '<span class="author-tag is-human">human</span>'
    : ''

  let foot = ''
  const backlinks = backlinksResult.results as any[]
  if (backlinks.length > 0) {
    foot += `<section class="doc-backlinks">
      <h2>このページを参照しているページ</h2>
      ${backlinks.map((b) => docLink(b.id, b.title)).join('\n')}
    </section>\n`
  }

  // Build breadcrumb: collection > grandparent > ... > parent (single CTE query, depth-capped at 20)
  let breadcrumb = `<a class="crumb" href="/?view=collections"
      hx-get="/ui/collections" hx-target="#doc-view" hx-push-url="/?view=collections">コレクション</a> / ${esc((collection as any)?.name ?? '')}`

  if (doc.parent_id) {
    const ancestorRows = await c.env.DB.prepare(`
      WITH RECURSIVE anc(id, title, parent_id, depth) AS (
        SELECT id, title, parent_id, 0 FROM documents WHERE id = ?
        UNION ALL
        SELECT d.id, d.title, d.parent_id, a.depth + 1
        FROM documents d JOIN anc a ON d.id = a.parent_id
        WHERE a.depth < 20
      )
      SELECT id, title, depth FROM anc WHERE id != ? ORDER BY depth DESC
    `).bind(doc.id, doc.id).all()
    const ancestors = ancestorRows.results as any[]
    if (ancestors.length > 0) {
      breadcrumb += ' / ' + ancestors.map((p) =>
        `<a class="crumb" href="/?doc=${esc(p.id)}"
        hx-get="/ui/doc/${esc(p.id)}" hx-target="#doc-view" hx-push-url="/?doc=${esc(p.id)}">${esc(p.title)}</a>`
      ).join(' / ')
    }
  }

  const html = `
<div id="doc-view-inner" data-doc-id="${esc(doc.id)}" data-doc-title="${esc(doc.title)}">
  <div class="doc-head">
    <h1 class="doc-title">${esc(doc.title)}</h1>
    <button class="btn-quiet" hx-get="/ui/doc/${esc(doc.id)}/edit" hx-target="#doc-view">✎ 編集</button>
  </div>
  <p class="meta-line">${breadcrumb} ・ ${fmtDate(doc.updated_at)}${author ? ` ・ ${author}` : ''}</p>
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
  notify(c, '保存しました')
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
  notify(c, '追記しました')
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

  notify(c, '削除しました(履歴は残ります)')
  c.header('HX-Push-Url', '/')
  return c.html(await renderWelcome(c))
})

// GET /ui/doc/:id/new-child - Child document creation form
uiRoute.get('/doc/:id/new-child', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')
  const doc = await c.env.DB.prepare('SELECT id, title, collection_id FROM documents WHERE id = ?').bind(id).first() as any
  if (!doc) return c.html(errorFragment('ドキュメントが見つかりません'), 404)
  if (!isCollectionAllowed(auth, doc.collection_id)) return c.html(errorFragment('アクセス権がありません'), 403)

  return c.html(`
<div id="doc-view-inner" data-doc-title="子ドキュメント作成">
  <div class="doc-head"><h1 class="doc-title">子ドキュメント作成</h1></div>
  <p class="meta-line">親: <a class="crumb" href="/?doc=${esc(doc.id)}"
      hx-get="/ui/doc/${esc(doc.id)}" hx-target="#doc-view" hx-push-url="/?doc=${esc(doc.id)}">${esc(doc.title)}</a></p>
  <form hx-post="/ui/docs" hx-target="#doc-view">
    <input type="hidden" name="collection_id" value="${esc(doc.collection_id)}">
    <input type="hidden" name="parent_id" value="${esc(doc.id)}">
    <input class="input doc-title-input" name="title" placeholder="タイトル" required autofocus autocomplete="off">
    <button class="btn-primary" type="submit">作成</button>
    <button class="btn-quiet" type="button" hx-get="/ui/doc/${esc(doc.id)}" hx-target="#doc-view">キャンセル</button>
  </form>
</div>`)
})

// POST /ui/docs - Create document (from the tree's inline form)
uiRoute.post('/docs', async (c) => {
  const auth = c.get('auth')
  const body = await c.req.parseBody()
  const title = String(body.title ?? '').trim()
  const collectionId = String(body.collection_id ?? '')
  const parentId = String(body.parent_id ?? '').trim() || null
  if (!title || !collectionId) return c.html(errorFragment('タイトルが必要です'), 400)
  if (!isCollectionAllowed(auth, collectionId)) return c.html(errorFragment('アクセス権がありません'), 403)

  const author = authorOf(auth)
  const id = generateId('doc')
  const now = Date.now()

  // Verify parent and build path in one query
  let path: string
  if (parentId) {
    const parent = await c.env.DB.prepare('SELECT collection_id, path FROM documents WHERE id = ?').bind(parentId).first() as any
    if (!parent) return c.html(errorFragment('親ドキュメントが見つかりません'), 404)
    if (parent.collection_id !== collectionId) return c.html(errorFragment('親ドキュメントが異なるコレクションです'), 400)
    path = `${parent.path}/${id}`
  } else {
    path = `/${collectionId}/${id}`
  }

  await c.env.DB.prepare(`
    INSERT INTO documents (id, title, content, collection_id, parent_id, path, priority, status, created_by_type, created_by_key_id, created_at, updated_at)
    VALUES (?, ?, '', ?, ?, ?, 'normal', 'published', ?, ?, ?, ?)
  `).bind(id, title, collectionId, parentId, path, author.authorType, author.apiKeyId, now, now).run()
  await createRevision(c.env.DB, id, title, '', author, now)

  const result = await renderDoc(c, id)
  notify(c, '作成しました')
  c.header('HX-Push-Url', `/?doc=${id}`)
  return c.html('error' in result ? errorFragment(result.error) : result.html)
})

// GET /ui/collections - Collection management page
uiRoute.get('/collections', async (c) => c.html(await renderCollectionsPage(c)))

// POST /ui/collections - Create collection
// view=page → returns the management page; otherwise the tree (sidebar form)
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

  if (String(body.view ?? '') === 'page') {
    notify(c, 'コレクションを追加しました')
    return c.html(await renderCollectionsPage(c))
  }
  notify(c, 'コレクションを追加しました', false)
  return c.html(await renderTree(c))
})

// GET /ui/collections/:id/head - Header row of a collection block (?edit=1 → rename form)
uiRoute.get('/collections/:id/head', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')
  if (!isCollectionAllowed(auth, id)) return c.html(errorFragment('アクセス権がありません'), 403)

  const col = await c.env.DB.prepare('SELECT id, name FROM collections WHERE id = ?').bind(id).first() as any
  if (!col) return c.html(errorFragment('コレクションが見つかりません'), 404)

  const count = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM documents WHERE collection_id = ? AND status = 'published'`
  ).bind(id).first() as any

  return c.html(colHead(col, count.n, c.req.query('edit') === '1'))
})

// POST /ui/collections/:id/rename
uiRoute.post('/collections/:id/rename', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')
  if (!isCollectionAllowed(auth, id)) return c.html(errorFragment('アクセス権がありません'), 403)

  const body = await c.req.parseBody()
  const name = String(body.name ?? '').trim()
  if (!name) return c.html(await renderCollectionsPage(c, '名前を入力してください'))

  const existing = await c.env.DB.prepare('SELECT id FROM collections WHERE id = ?').bind(id).first()
  if (!existing) return c.html(await renderCollectionsPage(c, 'コレクションが見つかりません'))

  const author = authorOf(auth)
  await c.env.DB.prepare('UPDATE collections SET name = ?, updated_at = ?, updated_by_type = ?, updated_by_key_id = ? WHERE id = ?')
    .bind(name, Date.now(), author.authorType, author.apiKeyId, id).run()

  notify(c, '名前を変更しました')
  return c.html(await renderCollectionsPage(c))
})

// POST /ui/collections/:id/delete - Refuses when not empty (same rule as the API)
uiRoute.post('/collections/:id/delete', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')
  if (!isCollectionAllowed(auth, id)) return c.html(errorFragment('アクセス権がありません'), 403)

  const [docsCount, childrenCount] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM documents WHERE collection_id = ?').bind(id).first() as Promise<any>,
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM collections WHERE parent_id = ?').bind(id).first() as Promise<any>,
  ])
  if (docsCount.n > 0) {
    return c.html(await renderCollectionsPage(c, 'ドキュメントが残っているため削除できません(先にドキュメントを削除または移動してください)'))
  }
  if (childrenCount.n > 0) {
    return c.html(await renderCollectionsPage(c, 'サブコレクションがあるため削除できません'))
  }

  await c.env.DB.prepare('DELETE FROM collections WHERE id = ?').bind(id).run()

  notify(c, 'コレクションを削除しました')
  return c.html(await renderCollectionsPage(c))
})
