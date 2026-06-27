// HTML fragments for the Web UI (HTMX).
// All dynamic values are escaped — content here is written by AI agents and
// external services, so nothing is trusted.
import { Hono } from 'hono'
import { authorOf, isCollectionAllowed, ownerUserIdOf } from '../auth/adapter'
import type { AppEnv, AuthContext } from '../auth/adapter'
import { escapeHtml as esc, highlightMatches, renderMarkdown } from '../services/markdown'
import { parseSections } from '../services/sections'

import { createDocument, moveDocument, updateDocument } from '../services/revisions'
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

const toFtsQuery = (query: string): string =>
  query.trim().split(/\s+/).filter(Boolean)
    .map((part) => `"${part.replace(/"/g, '""')}"`)
    .join(' ')

// ---------------------------------------------------------------
// Shared renderers
// ---------------------------------------------------------------

// A tree link that swaps the reading pane and pushes the URL
const docLink = (id: string, title: string, extraClass = '', suffix = '') =>
  `<a class="tree-item ${extraClass}" data-doc-id="${esc(id)}" href="/?doc=${esc(id)}"
      hx-get="/ui/doc/${esc(id)}" hx-target="#doc-view" hx-push-url="?doc=${esc(id)}">${esc(title)}${suffix}</a>`

const renderTree = async (c: any): Promise<string> => {
  const auth: AuthContext = c.get('auth')
  const uid = ownerUserIdOf(auth)

  // 2クエリ並列取得。documents は collections の IN 句で絞り込み（JOIN不要）
  const colsResult = await c.env.DB.prepare(
    'SELECT id, name, parent_id FROM collections WHERE owner_user_id = ? ORDER BY name'
  ).bind(uid).all()

  const collections = (colsResult.results as any[]).filter((col) => isCollectionAllowed(auth, col.id))
  if (collections.length === 0) {
    // コレクション0件ならドキュメントクエリも不要
    return renderTreeHtml([], new Map())
  }

  const colIds = collections.map((c) => c.id)
  const placeholders = colIds.map(() => '?').join(', ')
  const docsResult = await c.env.DB.prepare(
    `SELECT id, title, collection_id, parent_id, priority FROM documents
     WHERE status = 'published' AND collection_id IN (${placeholders})
     ORDER BY updated_at DESC`
  ).bind(...colIds).all()
  const docsByParent = new Map<string, Map<string | null, any[]>>()
  for (const doc of docsResult.results as any[]) {
    if (!docsByParent.has(doc.collection_id)) docsByParent.set(doc.collection_id, new Map())
    const parentMap = docsByParent.get(doc.collection_id)!
    const pid = doc.parent_id || null
    if (!parentMap.has(pid)) parentMap.set(pid, [])
    parentMap.get(pid)!.push(doc)
  }

  return renderTreeHtml(collections, docsByParent)
}

// ドキュメントツリーHTMLを再帰構築（renderTreeHtml と /ui/collections/:id/tree で共有）
const renderDocs = (
  docsByParent: Map<string, Map<string | null, any[]>>,
  collectionId: string,
  parentId: string | null,
  docDepth: number
): string => {
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
    const children = renderDocs(docsByParent, collectionId, doc.id, docDepth + 1)
    const hasChildren = children.length > 0
    // Spacer keeps the link x-position aligned between docs with/without children
    const toggle = hasChildren
      ? '<button class="tree-toggle tree-toggle-doc" type="button" aria-label="折りたたみ"><span class="tree-toggle-icon">▾</span></button>'
      : '<span class="tree-toggle-spacer" aria-hidden="true"></span>'
    html += `<div class="tree-doc-item${hasChildren ? ' has-children' : ''}" data-doc-id="${esc(doc.id)}" style="--doc-depth:${docDepth}">
      ${toggle}
      ${docLink(doc.id, doc.title, cls, mark)}
      <button class="doc-add-btn" type="button" title="子ドキュメントを追加"
              hx-get="/ui/doc/${esc(doc.id)}/new-child" hx-target="#doc-view">＋</button>
    </div>\n`
    if (hasChildren) {
      html += `<div class="tree-doc-children">${children}</div>\n`
    }
  }
  return html
}

// 単一コレクションのドキュメントツリーHTML（遅延取得用）
const renderCollectionDocs = (col: any, docsByParent: Map<string, Map<string | null, any[]>>): string => {
  let html = renderDocs(docsByParent, col.id, null, 0)
  html += `<details class="tree-new tree-new-doc">
    <summary>＋ メモを追加</summary>
    <form hx-post="/ui/docs" hx-target="#doc-view">
      <input type="hidden" name="collection_id" value="${esc(col.id)}">
      <input class="input" name="title" placeholder="タイトル" required autocomplete="off">
      <button class="btn btn-sm" type="submit">作成</button>
    </form>
  </details>\n`
  return html
}

// ツリーHTML構築（renderTree と /ui/init で共有）
// activeColId: 初回から展開済みにするコレクションID（開いているドキュメントの親）
//   指定時はそのコレクションのドキュメントのみ inline 描画、他は hx-get で遅延取得
//   未指定時（null）は全コレクションのドキュメントを inline 描画（従来動作）
const renderTreeHtml = (
  collections: any[],
  docsByParent: Map<string, Map<string | null, any[]>>,
  activeColId?: string | null
): string => {
  const renderGroup = (parentId: string | null, depth: number): string => {
    let html = ''
    for (const col of collections.filter((x) => x.parent_id === parentId)) {
      const isActive = activeColId != null && col.id === activeColId
      // activeColId のコレクションは展開済み、他は折りたたみ + hx-get で遅延取得
      const toggleAttr = isActive
        ? '' // 展開済み: クライアント側の通常トグル動作
        : ` data-lazy="/ui/collections/${esc(col.id)}/tree"`
      html += `<section class="tree-group${isActive ? '' : ' collapsed'}" data-col-id="${esc(col.id)}" style="--depth:${depth}">
        <div class="tree-head">
          <button class="tree-toggle" type="button" aria-label="折りたたみ"${toggleAttr}><span class="tree-toggle-icon">▾</span></button>
          <a class="tree-col-name" href="/?col=${esc(col.id)}"
             hx-get="/ui/collections/${esc(col.id)}" hx-target="#doc-view" hx-push-url="?col=${esc(col.id)}">${esc(col.name)}</a>
        </div>
        <div class="tree-children">\n`
      if (isActive || activeColId == null) {
        // 展開済み or 従来モード: ドキュメントツリーを inline 描画
        html += renderDocs(docsByParent, col.id, null, 0)
        html += `<details class="tree-new tree-new-doc">
          <summary>＋ メモを追加</summary>
          <form hx-post="/ui/docs" hx-target="#doc-view">
            <input type="hidden" name="collection_id" value="${esc(col.id)}">
            <input class="input" name="title" placeholder="タイトル" required autocomplete="off">
            <button class="btn btn-sm" type="submit">作成</button>
          </form>
        </details>\n`
      }
      // 遅延取得モード: .tree-children は空（HTMXが展開時に埋める）
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
  const uid = ownerUserIdOf(auth)
  const [colsResult, docsResult] = await Promise.all([
    c.env.DB.prepare('SELECT id, name, parent_id FROM collections WHERE owner_user_id = ? ORDER BY name').bind(uid).all(),
    c.env.DB.prepare(`
      SELECT d.id, d.title, d.collection_id, d.parent_id FROM documents d
      JOIN collections c ON d.collection_id = c.id
      WHERE d.status = 'published' AND c.owner_user_id = ? ORDER BY d.updated_at DESC
    `).bind(uid).all(),
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

// Single collection page: the collection's document list + create form + edit/delete.
// Reached from the tree's collection name link and the document breadcrumb.
const renderCollectionPage = async (c: any, collectionId: string): Promise<string> => {
  const auth: AuthContext = c.get('auth')
  const uid = ownerUserIdOf(auth)
  if (!isCollectionAllowed(auth, collectionId)) return errorFragment('このコレクションへのアクセス権がありません')

  const [col, docsResult] = await Promise.all([
    c.env.DB.prepare('SELECT id, name, description FROM collections WHERE id = ? AND owner_user_id = ?').bind(collectionId, uid).first(),
    c.env.DB.prepare(`
      SELECT id, title, parent_id, priority, updated_at FROM documents
      WHERE collection_id = ? AND status = 'published'
    `).bind(collectionId).all(),
  ])
  const collection = col as any
  if (!collection) return errorFragment('コレクションが見つかりません')

  // Group by parent for hierarchical render (depth cap guards against cycles)
  const docsByParent = new Map<string | null, any[]>()
  for (const doc of docsResult.results as any[]) {
    const pid = doc.parent_id || null
    if (!docsByParent.has(pid)) docsByParent.set(pid, [])
    docsByParent.get(pid)!.push(doc)
  }
  const renderDocTree = (parentId: string | null, depth: number): string => {
    if (depth > 20) return ''
    const docs = docsByParent.get(parentId) ?? []
    const sorted = [
      ...docs.filter((d) => d.priority === 'high'),
      ...docs.filter((d) => d.priority === 'normal'),
      ...docs.filter((d) => d.priority === 'archive'),
    ]
    return sorted.map((doc) => {
      const cls = doc.priority === 'archive' ? 'is-archive' : ''
      const mark = doc.priority === 'high' ? ' <span class="pri">●</span>' : ''
      return `<div style="padding-left: ${depth * 16}px;">${docLink(doc.id, doc.title, cls, mark)}</div>\n` +
        renderDocTree(doc.id, depth + 1)
    }).join('')
  }

  const docCount = (docsResult.results as any[]).length

  return `
<div id="doc-view-inner" data-doc-title="${esc(collection.name)}">
  ${colHead(collection, docCount)}
  ${collection.description ? `<p class="muted" style="margin: var(--space-3) 0">${esc(collection.description)}</p>` : ''}
  <nav class="tree col-docs">
    ${renderDocTree(null, 0) || '<p class="tree-empty">まだメモがありません</p>'}
  </nav>
  <form class="col-new" hx-post="/ui/docs" hx-target="#doc-view">
    <input type="hidden" name="collection_id" value="${esc(collectionId)}">
    <input class="input" name="title" placeholder="新しいメモのタイトル" required autocomplete="off">
    <button class="btn-primary" type="submit">作成</button>
  </form>
</div>`
}

const renderDoc = async (c: any, id: string): Promise<{ html: string } | { error: string; status: 404 | 403 }> => {
  const auth: AuthContext = c.get('auth')
  const uid = ownerUserIdOf(auth)
  // マルチテナント: collections 経由でオーナーチェック
  const doc = await c.env.DB.prepare(`
    SELECT d.* FROM documents d JOIN collections c ON d.collection_id = c.id
    WHERE d.id = ? AND c.owner_user_id = ?
  `).bind(id, uid).first() as any
  if (!doc) return { error: 'ドキュメントが見つかりません', status: 404 }
  if (!isCollectionAllowed(auth, doc.collection_id)) return { error: 'このドキュメントへのアクセス権がありません', status: 403 }

  // collection名は別途取得（renderDocFromData では collections リストから再利用）
  const [collection, lastRev, linksResult, backlinksResult, ancestorRows] = await Promise.all([
    c.env.DB.prepare('SELECT name FROM collections WHERE id = ? AND owner_user_id = ?').bind(doc.collection_id, uid).first(),
    c.env.DB.prepare('SELECT author_type, api_key_name FROM document_revisions WHERE document_id = ? ORDER BY created_at DESC LIMIT 1').bind(id).first(),
    c.env.DB.prepare(`
      SELECT d.id, d.title FROM document_links l JOIN documents d ON d.id = l.to_doc_id
      WHERE l.from_doc_id = ? ORDER BY d.title
    `).bind(id).all(),
    c.env.DB.prepare(`
      SELECT d.id, d.title FROM document_links l JOIN documents d ON d.id = l.from_doc_id
      WHERE l.to_doc_id = ? ORDER BY d.title
    `).bind(id).all(),
    doc.parent_id
      ? c.env.DB.prepare(`
          WITH RECURSIVE anc(id, title, parent_id, depth) AS (
            SELECT id, title, parent_id, 0 FROM documents WHERE id = ?
            UNION ALL
            SELECT d.id, d.title, d.parent_id, a.depth + 1
            FROM documents d JOIN anc a ON d.id = a.parent_id
            WHERE a.depth < 20
          )
          SELECT id, title, depth FROM anc WHERE id != ? ORDER BY depth DESC
        `).bind(doc.id, doc.id).all()
      : Promise.resolve({ results: [] }),
  ])

  return { html: renderDocFromData(c, doc, [collection, lastRev, linksResult, backlinksResult, ancestorRows]) }
}

// クエリ結果からドキュメントHTMLを構築（renderDoc と /ui/init で共有）
// docExtra = [collection, lastRev, linksResult, backlinksResult, ancestorRows]
const renderDocFromData = (_c: any, doc: any, docExtra: any[]): string => {
  const [collection, lastRev, linksResult, backlinksResult, ancestorRows] = docExtra

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

  // Build breadcrumb: コレクション(全体) > collection(this doc) > ancestors > parent
  const colName = (collection as any)?.name ?? ''
  const colCrumb = doc.collection_id
    ? `<a class="crumb" href="/?col=${esc(doc.collection_id)}"
        hx-get="/ui/collections/${esc(doc.collection_id)}" hx-target="#doc-view" hx-push-url="?col=${esc(doc.collection_id)}">${esc(colName)}</a>`
    : esc(colName)
  let breadcrumb = `<a class="crumb" href="/?view=collections"
      hx-get="/ui/collections" hx-target="#doc-view" hx-push-url="?view=collections">コレクション</a> / ${colCrumb}`

  const ancestors = (ancestorRows as any)?.results ?? []
  if (ancestors.length > 0) {
    breadcrumb += ' / ' + ancestors.map((p: any) =>
      `<a class="crumb" href="/?doc=${esc(p.id)}"
      hx-get="/ui/doc/${esc(p.id)}" hx-target="#doc-view" hx-push-url="?doc=${esc(p.id)}">${esc(p.title)}</a>`
    ).join(' / ')
  }

  const html = `
<div id="doc-view-inner" data-doc-id="${esc(doc.id)}" data-doc-title="${esc(doc.title)}">
  <div class="doc-sticky-head">
    <div class="doc-head">
      <h1 class="doc-title">${esc(doc.title)}</h1>
      <button class="btn-ghost" hx-get="/ui/doc/${esc(doc.id)}/edit" hx-target="#doc-view">✎ 編集</button>
    </div>
    <p class="meta-line">${breadcrumb} ・ ${fmtDate(doc.updated_at)}${author ? ` ・ ${author}` : ''}</p>
  </div>
  ${tocMobile}
  <div class="doc-columns">
    <article class="prose">${body}</article>
    ${tocSidebar}
  </div>
  ${foot}
  <form class="append-box" hx-post="/ui/doc/${esc(doc.id)}/append" hx-target="#doc-view">
    <input type="hidden" name="expected_version" value="${esc(String(doc.version))}">
    <textarea class="textarea" name="content" rows="2" placeholder="ここに追記…(そのまま末尾に足されます)" required></textarea>
    <button class="btn-primary" type="submit">追記</button>
  </form>
</div>`
  return html
}

// 最近のドキュメント10件のHTML（renderWelcome と /ui/init で共有）
const welcomeHtml = (docs: any[]): string => {
  let html = '<div id="doc-view-inner"><div class="doc-head"><h1 class="doc-title">最近のドキュメント</h1></div>\n'
  if (docs.length === 0) {
    html += '<p class="muted">まだ何もありません。左のツリーからコレクションとメモを作成してください。</p>'
  } else {
    html += '<nav class="tree">' + docs.map((d) => docLink(d.id, d.title)).join('\n') + '</nav>'
  }
  html += '</div>'
  return html
}

const renderWelcome = async (c: any): Promise<string> => {
  const auth: AuthContext = c.get('auth')
  const uid = ownerUserIdOf(auth)
  const result = await c.env.DB.prepare(`
    SELECT d.id, d.title, d.collection_id, d.updated_at FROM documents d
    JOIN collections c ON d.collection_id = c.id
    WHERE d.status = 'published' AND c.owner_user_id = ?
    ORDER BY d.updated_at DESC LIMIT 10
  `).bind(uid).all()
  const docs = (result.results as any[]).filter((d) => isCollectionAllowed(auth, d.collection_id))
  return welcomeHtml(docs)
}

const errorFragment = (message: string) => `<p class="error">${esc(message)}</p>`

// ---------------------------------------------------------------
// Routes
// ---------------------------------------------------------------

// GET /ui/tree - Sidebar tree
uiRoute.get('/tree', async (c) => c.html(await renderTree(c)))

// GET /ui/init - 初回ロード用統合エンドポイント（tree + doc/welcome を1往復で返す）
// クエリパラメータ: doc=doc_xxx（指定時はそのドキュメント、未指定時はwelcome）
// レスポンス形式: { tree: "<html>", main: "<html>" }
// ツリー遅延取得: activeColId（開いているdocの親コレクション）のみドキュメントを inline 描画、
// 他のコレクションは折りたたみ + hx-get で展開時に取得
uiRoute.get('/init', async (c) => {
  const auth: AuthContext = c.get('auth')
  const uid = ownerUserIdOf(auth)
  const docId = c.req.query('doc')

  // Phase 1: collections と doc（指定時）を並列取得
  const colsPromise = c.env.DB.prepare(
    'SELECT id, name, parent_id FROM collections WHERE owner_user_id = ? ORDER BY name'
  ).bind(uid).all()

  const docPromise = docId
    ? c.env.DB.prepare(`
        SELECT d.* FROM documents d JOIN collections c ON d.collection_id = c.id
        WHERE d.id = ? AND c.owner_user_id = ?
      `).bind(docId, uid).first()
    : Promise.resolve(null)

  const [colsResult, docRow] = await Promise.all([colsPromise, docPromise])
  const collections = (colsResult.results as any[]).filter((col) => isCollectionAllowed(auth, col.id))
  const doc = docRow as any

  // activeColId: 開いているドキュメントの親コレクション（初回から展開済みにする）
  const activeColId = doc?.collection_id ?? null

  // Phase 2: activeColIdのドキュメント一覧 + welcome用ドキュメント + doc関連クエリ を並列取得
  // activeColId のドキュメントのみ取得（全コレクションの全ドキュメントは取得しない）
  const activeDocsPromise = activeColId
    ? c.env.DB.prepare(
        `SELECT id, title, collection_id, parent_id, priority FROM documents
         WHERE status = 'published' AND collection_id = ? ORDER BY updated_at DESC`
      ).bind(activeColId).all()
    : Promise.resolve({ results: [] })

  // welcome用: doc未指定時は最近10件（全コレクション横断）
  const welcomeDocsPromise = !docId
    ? c.env.DB.prepare(`
        SELECT d.id, d.title, d.collection_id, d.updated_at FROM documents d
        JOIN collections c ON d.collection_id = c.id
        WHERE d.status = 'published' AND c.owner_user_id = ?
        ORDER BY d.updated_at DESC LIMIT 10
      `).bind(uid).all()
    : Promise.resolve({ results: [] })

  // doc関連クエリ（docが存在する場合のみ）
  let docExtraPromise: Promise<any> = Promise.resolve(null)
  if (doc && isCollectionAllowed(auth, doc.collection_id)) {
    docExtraPromise = Promise.all([
      Promise.resolve({ name: collections.find((c) => c.id === doc.collection_id)?.name ?? '' }),
      c.env.DB.prepare('SELECT author_type, api_key_name FROM document_revisions WHERE document_id = ? ORDER BY created_at DESC LIMIT 1').bind(doc.id).first(),
      c.env.DB.prepare(`
        SELECT d.id, d.title FROM document_links l JOIN documents d ON d.id = l.to_doc_id
        WHERE l.from_doc_id = ? ORDER BY d.title
      `).bind(doc.id).all(),
      c.env.DB.prepare(`
        SELECT d.id, d.title FROM document_links l JOIN documents d ON d.id = l.from_doc_id
        WHERE l.to_doc_id = ? ORDER BY d.title
      `).bind(doc.id).all(),
      doc.parent_id
        ? c.env.DB.prepare(`
            WITH RECURSIVE anc(id, title, parent_id, depth) AS (
              SELECT id, title, parent_id, 0 FROM documents WHERE id = ?
              UNION ALL
              SELECT d.id, d.title, d.parent_id, a.depth + 1
              FROM documents d JOIN anc a ON d.id = a.parent_id
              WHERE a.depth < 20
            )
            SELECT id, title, depth FROM anc WHERE id != ? ORDER BY depth DESC
          `).bind(doc.id, doc.id).all()
        : Promise.resolve({ results: [] }),
    ])
  }

  const [activeDocsResult, welcomeDocsResult, docExtra] = await Promise.all([
    activeDocsPromise, welcomeDocsPromise, docExtraPromise,
  ])

  // tree HTML 構築（activeColId のドキュメントのみ inline、他は遅延取得）
  const docsByParent = new Map<string, Map<string | null, any[]>>()
  for (const d of activeDocsResult.results as any[]) {
    if (!docsByParent.has(d.collection_id)) docsByParent.set(d.collection_id, new Map())
    const parentMap = docsByParent.get(d.collection_id)!
    const pid = d.parent_id || null
    if (!parentMap.has(pid)) parentMap.set(pid, [])
    parentMap.get(pid)!.push(d)
  }
  const treeHtml = renderTreeHtml(collections, docsByParent, activeColId)

  // main ペイン HTML 構築
  let mainHtml: string
  if (docId && doc && docExtra) {
    mainHtml = renderDocFromData(c, doc, docExtra)
  } else if (docId) {
    mainHtml = errorFragment('ドキュメントが見つかりません')
  } else {
    mainHtml = welcomeHtml(welcomeDocsResult.results as any[])
  }

  return c.json({ tree: treeHtml, main: mainHtml })
})

// GET /ui/search?q= - Incremental search results (empty query → tree)
uiRoute.get('/search', async (c) => {
  const auth = c.get('auth')
  const uid = ownerUserIdOf(auth)
  const q = (c.req.query('q') ?? '').trim()
  if (q === '') return c.html(await renderTree(c))

  // FTS5 trigram cannot match queries shorter than 3 chars (common in Japanese) → LIKE fallback
  // マルチテナント: collections 経由でオーナーフィルタ
  let result: { results: unknown[] }
  if ([...q].length < 3) {
    const like = `%${q}%`
    result = await c.env.DB.prepare(`
      SELECT d.id, d.title, d.content, d.collection_id FROM documents d
      JOIN collections c ON d.collection_id = c.id
      WHERE d.status = 'published' AND c.owner_user_id = ? AND (d.title LIKE ? OR d.content LIKE ?)
      ORDER BY d.updated_at DESC LIMIT 15
    `).bind(uid, like, like).all()
  } else {
    result = await c.env.DB.prepare(`
      SELECT d.id, d.title, d.content, d.collection_id
      FROM documents_fts JOIN documents d ON documents_fts.rowid = d.rowid
      JOIN collections c ON d.collection_id = c.id
      WHERE documents_fts MATCH ? AND d.status = 'published' AND c.owner_user_id = ?
      LIMIT 15
    `).bind(toFtsQuery(q), uid).all().catch(() => ({ results: [] }))
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
    const snippet = line.slice(0, 120)
    const titleHtml = highlightMatches(hit.title, q)
    const snippetHtml = highlightMatches(snippet, q)
    html += `<a class="tree-item search-hit" data-doc-id="${esc(hit.id)}" href="/?doc=${esc(hit.id)}"
        hx-get="/ui/doc/${esc(hit.id)}" hx-target="#doc-view" hx-push-url="?doc=${esc(hit.id)}">
        <span class="search-hit-title">${titleHtml}</span>
        <span class="search-hit-snippet">${snippetHtml}</span></a>\n`
  }
  html += '</nav>'
  return c.html(html)
})

// GET /ui/welcome - Empty state (recent documents)
uiRoute.get('/welcome', async (c) => c.html(await renderWelcome(c)))

// GET /ui/doc/:id - Reading view (?raw=1 → JSON of title+content for clipboard)
uiRoute.get('/doc/:id', async (c) => {
  const id = c.req.param('id')
  if (c.req.query('raw') === '1') {
    const auth = c.get('auth')
    const uid = ownerUserIdOf(auth)
    const doc = await c.env.DB.prepare(`
      SELECT d.title, d.content, d.collection_id FROM documents d
      JOIN collections c ON d.collection_id = c.id
      WHERE d.id = ? AND c.owner_user_id = ?
    `).bind(id, uid).first() as any
    if (!doc) return c.json({ error: 'Not found' }, 404)
    if (!isCollectionAllowed(auth, doc.collection_id)) return c.json({ error: 'Forbidden' }, 403)
    return c.json({ title: doc.title, content: doc.content })
  }
  const result = await renderDoc(c, id)
  if ('error' in result) return c.html(errorFragment(result.error), result.status)
  return c.html(result.html)
})

// GET /ui/doc/:id/edit - Editor
uiRoute.get('/doc/:id/edit', async (c) => {
  const auth = c.get('auth')
  const uid = ownerUserIdOf(auth)
  const id = c.req.param('id')
  const doc = await c.env.DB.prepare(`
    SELECT d.* FROM documents d JOIN collections c ON d.collection_id = c.id
    WHERE d.id = ? AND c.owner_user_id = ?
  `).bind(id, uid).first() as any
  if (!doc) return c.html(errorFragment('ドキュメントが見つかりません'), 404)
  if (!isCollectionAllowed(auth, doc.collection_id)) return c.html(errorFragment('アクセス権がありません'), 403)

  return c.html(`
<div id="doc-view-inner" data-doc-id="${esc(doc.id)}" data-doc-title="${esc(doc.title)}">
  <form class="editor-form" hx-post="/ui/doc/${esc(doc.id)}/save" hx-target="#doc-view">
    <div class="doc-sticky-head">
      <div class="doc-head">
        <input class="input doc-title-input" name="title" value="${esc(doc.title)}" required>
        <button class="btn-ghost btn-lg" type="button" hx-get="/ui/doc/${esc(doc.id)}" hx-target="#doc-view">キャンセル</button>
        <button class="btn-primary btn-lg" type="submit">保存</button>
      </div>
      <div class="editor-toolbar">
        <input type="hidden" name="expected_version" value="${esc(String(doc.version))}">
        <span class="btn-tool-group has-dropdown">
          <button class="btn-tool" type="button" data-heading-insert="1"><span class="tool-icon">¶</span>見出し</button>
          <button class="btn-tool btn-tool-dropdown" type="button" aria-label="見出しレベル">▼</button>
          <span class="btn-tool-menu">
            <button type="button" data-heading-insert="1">H1</button>
            <button type="button" data-heading-insert="2">H2</button>
            <button type="button" data-heading-insert="3">H3</button>
            <button type="button" data-heading-insert="4">H4</button>
            <button type="button" data-heading-insert="5">H5</button>
            <button type="button" data-heading-insert="6">H6</button>
          </span>
        </span>
        <button class="btn-tool" type="button" data-wrap-before="**" data-wrap-after="**"><span class="tool-icon">B</span>太字</button>
        <button class="btn-tool" type="button" data-wrap-before="~~" data-wrap-after="~~"><span class="tool-icon">S</span>取り消し</button>
        <button class="btn-tool" type="button" data-wrap-before="\`" data-wrap-after="\`"><span class="tool-icon">&gt;</span>コード</button>
        <button class="btn-tool" type="button" data-block="\`\`\`\n" data-block-end="\n\`\`\`"><span class="tool-icon">&lt;/&gt;</span>コードブロック</button>
        <button class="btn-tool" type="button" data-line-prefix="> "><span class="tool-icon">"</span>引用</button>
        <button class="btn-tool" type="button" data-snippet="- "><span class="tool-icon">•</span>箇条書き</button>
        <button class="btn-tool" type="button" data-numbered-list><span class="tool-icon">1.</span>番号付き</button>
        <button class="btn-tool" type="button" data-snippet="---\n"><span class="tool-icon">—</span>水平線</button>
        <button class="btn-tool" type="button" data-snippet="|  |  |  |\n|---|---|---|\n|  |  |  |\n|  |  |  |\n" data-cursor="2"><span class="tool-icon">⊞</span>テーブル</button>
        <button class="btn-tool" type="button" data-snippet="[[doc_]]" data-cursor="7"><span class="tool-icon">[[ ]]</span>リンク</button>
      </div>
    </div>
    <div class="editor-wrap">
      <div class="line-numbers" aria-hidden="true"></div>
      <textarea class="textarea editor" name="content" placeholder="Markdownで書く。[[doc_xxx]] で他のドキュメントへリンク。">${esc(doc.content)}</textarea>
    </div>
  </form>
  <p class="edit-foot">
    <button class="btn-ghost" hx-get="/ui/doc/${esc(doc.id)}/move" hx-target="#doc-view">移動</button>
    <button class="btn-ghost-danger" hx-post="/ui/doc/${esc(doc.id)}/delete" hx-target="#doc-view"
            hx-confirm="このドキュメントを削除しますか?(変更履歴は残ります)">削除する</button>
  </p>
</div>`)
})

// POST /ui/doc/:id/save
uiRoute.post('/doc/:id/save', async (c) => {
  const auth = c.get('auth')
  const uid = ownerUserIdOf(auth)
  const id = c.req.param('id')
  const doc = await c.env.DB.prepare(`
    SELECT d.* FROM documents d JOIN collections c ON d.collection_id = c.id
    WHERE d.id = ? AND c.owner_user_id = ?
  `).bind(id, uid).first() as any
  if (!doc) return c.html(errorFragment('ドキュメントが見つかりません'), 404)
  if (!isCollectionAllowed(auth, doc.collection_id)) return c.html(errorFragment('アクセス権がありません'), 403)

  const body = await c.req.parseBody()
  const title = String(body.title ?? '').trim()
  const content = String(body.content ?? '')
  const expectedVersion = parseInt(String(body.expected_version ?? doc.version), 10)
  if (!title) return c.html(errorFragment('タイトルを入力してください'), 400)

  const now = Date.now()
  const result = await updateDocument(
    c.env.DB, auth, id,
    { title: doc.title, content: doc.content, version: doc.version },
    { title, content },
    expectedVersion,
    now
  )
  if (!result.ok) {
    return c.html(errorFragment(
      result.code === 'CONFLICT'
        ? '他の操作で更新されています。最新の状態を確認して再度保存してください'
        : 'ドキュメントが見つかりません'
    ), result.code === 'CONFLICT' ? 409 : 404)
  }

  const result2 = await renderDoc(c, id)
  notify(c, '保存しました')
  return c.html('error' in result2 ? errorFragment(result2.error) : result2.html)
})

// POST /ui/doc/:id/append
uiRoute.post('/doc/:id/append', async (c) => {
  const auth = c.get('auth')
  const uid = ownerUserIdOf(auth)
  const id = c.req.param('id')
  const doc = await c.env.DB.prepare(`
    SELECT d.* FROM documents d JOIN collections c ON d.collection_id = c.id
    WHERE d.id = ? AND c.owner_user_id = ?
  `).bind(id, uid).first() as any
  if (!doc) return c.html(errorFragment('ドキュメントが見つかりません'), 404)
  if (!isCollectionAllowed(auth, doc.collection_id)) return c.html(errorFragment('アクセス権がありません'), 403)

  const body = await c.req.parseBody()
  const content = String(body.content ?? '').trim()
  const expectedVersion = parseInt(String(body.expected_version ?? doc.version), 10)
  if (!content) return c.html(errorFragment('内容を入力してください'), 400)

  const separator = doc.content === '' || doc.content.endsWith('\n\n') ? '' : doc.content.endsWith('\n') ? '\n' : '\n\n'
  const now = Date.now()
  const result = await updateDocument(
    c.env.DB, auth, id,
    { title: doc.title, content: doc.content, version: doc.version },
    { content: doc.content + separator + content },
    expectedVersion,
    now
  )
  if (!result.ok) {
    return c.html(errorFragment(
      result.code === 'CONFLICT'
        ? '他の操作で更新されています。最新の状態を確認して再度追記してください'
        : 'ドキュメントが見つかりません'
    ), result.code === 'CONFLICT' ? 409 : 404)
  }

  const result2 = await renderDoc(c, id)
  notify(c, '追記しました')
  return c.html('error' in result2 ? errorFragment(result2.error) : result2.html)
})

// POST /ui/doc/:id/delete
uiRoute.post('/doc/:id/delete', async (c) => {
  const auth = c.get('auth')
  const uid = ownerUserIdOf(auth)
  const id = c.req.param('id')
  const doc = await c.env.DB.prepare(`
    SELECT d.collection_id FROM documents d JOIN collections c ON d.collection_id = c.id
    WHERE d.id = ? AND c.owner_user_id = ?
  `).bind(id, uid).first() as any
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

// GET /ui/doc/:id/move - Move form
uiRoute.get('/doc/:id/move', async (c) => {
  const auth = c.get('auth')
  const uid = ownerUserIdOf(auth)
  const id = c.req.param('id')
  const doc = await c.env.DB.prepare(`
    SELECT d.* FROM documents d JOIN collections c ON d.collection_id = c.id
    WHERE d.id = ? AND c.owner_user_id = ?
  `).bind(id, uid).first() as any
  if (!doc) return c.html(errorFragment('ドキュメントが見つかりません'), 404)
  if (!isCollectionAllowed(auth, doc.collection_id)) return c.html(errorFragment('アクセス権がありません'), 403)

  const cols = await c.env.DB.prepare(`
    SELECT id, name FROM collections
    WHERE owner_user_id = ?
    ORDER BY name
  `).bind(uid).all() as { results: { id: string; name: string }[] }

  const options = (cols.results as any[])
    .filter((col) => isCollectionAllowed(auth, col.id))
    .map((col) => `<option value="${esc(col.id)}"${col.id === doc.collection_id ? ' selected' : ''}>${esc(col.name)}</option>`)
    .join('\n')

  return c.html(`
<div id="doc-view-inner" data-doc-title="移動">
  <div class="doc-head"><h1 class="doc-title">ドキュメントを移動</h1></div>
  <p class="meta-line">${esc(doc.title)}</p>
  <form hx-post="/ui/doc/${esc(id)}/move" hx-target="#doc-view">
    <label class="meta-line">移動先コレクション
      <select class="input" name="collection_id" required>${options}</select>
    </label>
    <p class="meta-line">
      <label>親ドキュメントID（省略でトップレベル）<br>
        <input class="input" name="parent_id" placeholder="doc_xxx">
      </label>
    </p>
    <button class="btn-primary" type="submit">移動</button>
    <button class="btn-ghost" type="button" hx-get="/ui/doc/${esc(id)}" hx-target="#doc-view">キャンセル</button>
  </form>
</div>`)
})

// POST /ui/doc/:id/move - Execute move
uiRoute.post('/doc/:id/move', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')
  const body = await c.req.parseBody()
  const collectionId = String(body.collection_id ?? '')
  const parentId = String(body.parent_id ?? '').trim() || null

  if (!collectionId) return c.html(errorFragment('コレクションを選択してください'), 400)

  const result = await moveDocument(c.env.DB, auth, id, collectionId, parentId)
  if (!result.ok) {
    return c.html(errorFragment(result.message), result.code === 'NOT_FOUND' ? 404 : 400)
  }

  const result2 = await renderDoc(c, id)
  notify(c, '移動しました')
  c.header('HX-Push-Url', `/?doc=${id}`)
  return c.html('error' in result2 ? errorFragment(result2.error) : result2.html)
})

// GET /ui/doc/:id/new-child - Child document creation form
uiRoute.get('/doc/:id/new-child', async (c) => {
  const auth = c.get('auth')
  const uid = ownerUserIdOf(auth)
  const id = c.req.param('id')
  const doc = await c.env.DB.prepare(`
    SELECT d.id, d.title, d.collection_id FROM documents d JOIN collections c ON d.collection_id = c.id
    WHERE d.id = ? AND c.owner_user_id = ?
  `).bind(id, uid).first() as any
  if (!doc) return c.html(errorFragment('ドキュメントが見つかりません'), 404)
  if (!isCollectionAllowed(auth, doc.collection_id)) return c.html(errorFragment('アクセス権がありません'), 403)

  return c.html(`
<div id="doc-view-inner" data-doc-title="子ドキュメント作成">
  <div class="doc-head"><h1 class="doc-title">子ドキュメント作成</h1></div>
  <p class="meta-line">親: <a class="crumb" href="/?doc=${esc(doc.id)}"
      hx-get="/ui/doc/${esc(doc.id)}" hx-target="#doc-view" hx-push-url="?doc=${esc(doc.id)}">${esc(doc.title)}</a></p>
  <form class="editor-form" hx-post="/ui/docs" hx-target="#doc-view">
    <div class="doc-sticky-head">
      <div class="doc-head">
        <input class="input doc-title-input" name="title" placeholder="タイトル" required autofocus autocomplete="off">
        <button class="btn-ghost" type="button" hx-get="/ui/doc/${esc(doc.id)}" hx-target="#doc-view">キャンセル</button>
        <button class="btn-primary" type="submit">作成</button>
      </div>
      <div class="editor-toolbar">
        <span class="btn-tool-group has-dropdown">
          <button class="btn-tool" type="button" data-heading-insert="1"><span class="tool-icon">¶</span>見出し</button>
          <button class="btn-tool btn-tool-dropdown" type="button" aria-label="見出しレベル">▼</button>
          <span class="btn-tool-menu">
            <button type="button" data-heading-insert="1">H1</button>
            <button type="button" data-heading-insert="2">H2</button>
            <button type="button" data-heading-insert="3">H3</button>
            <button type="button" data-heading-insert="4">H4</button>
            <button type="button" data-heading-insert="5">H5</button>
            <button type="button" data-heading-insert="6">H6</button>
          </span>
        </span>
        <button class="btn-tool" type="button" data-wrap-before="**" data-wrap-after="**"><span class="tool-icon">B</span>太字</button>
        <button class="btn-tool" type="button" data-wrap-before="~~" data-wrap-after="~~"><span class="tool-icon">S</span>取り消し</button>
        <button class="btn-tool" type="button" data-wrap-before="\`" data-wrap-after="\`"><span class="tool-icon">&gt;</span>コード</button>
        <button class="btn-tool" type="button" data-block="\`\`\`\n" data-block-end="\n\`\`\`"><span class="tool-icon">&lt;/&gt;</span>コードブロック</button>
        <button class="btn-tool" type="button" data-line-prefix="> "><span class="tool-icon">"</span>引用</button>
        <button class="btn-tool" type="button" data-snippet="- "><span class="tool-icon">•</span>箇条書き</button>
        <button class="btn-tool" type="button" data-numbered-list><span class="tool-icon">1.</span>番号付き</button>
        <button class="btn-tool" type="button" data-snippet="---\n"><span class="tool-icon">—</span>水平線</button>
        <button class="btn-tool" type="button" data-snippet="|  |  |  |\n|---|---|---|\n|  |  |  |\n|  |  |  |\n" data-cursor="2"><span class="tool-icon">⊞</span>テーブル</button>
        <button class="btn-tool" type="button" data-snippet="[[doc_]]" data-cursor="7"><span class="tool-icon">[[ ]]</span>リンク</button>
      </div>
    </div>
    <div class="editor-wrap">
      <div class="line-numbers" aria-hidden="true"></div>
      <textarea class="textarea editor" name="content" placeholder="Markdownで書く。[[doc_xxx]] で他のドキュメントへリンク。"></textarea>
    </div>
    <input type="hidden" name="collection_id" value="${esc(doc.collection_id)}">
    <input type="hidden" name="parent_id" value="${esc(doc.id)}">
  </form>
</div>`)
})

// POST /ui/docs - Create document (from the tree's inline form)
uiRoute.post('/docs', async (c) => {
  const auth = c.get('auth')
  const uid = ownerUserIdOf(auth)
  const body = await c.req.parseBody()
  const title = String(body.title ?? '').trim()
  const content = String(body.content ?? '')
  const collectionId = String(body.collection_id ?? '')
  const parentId = String(body.parent_id ?? '').trim() || null
  if (!title || !collectionId) return c.html(errorFragment('タイトルが必要です'), 400)
  if (!isCollectionAllowed(auth, collectionId)) return c.html(errorFragment('アクセス権がありません'), 403)

  // マルチテナント: collection のオーナーチェック
  const col = await c.env.DB.prepare('SELECT id FROM collections WHERE id = ? AND owner_user_id = ?')
    .bind(collectionId, uid).first()
  if (!col) return c.html(errorFragment('コレクションが見つかりません'), 404)

  const id = generateId('doc')
  const now = Date.now()

  // Verify parent and build path in one query
  let path: string
  if (parentId) {
    const parent = await c.env.DB.prepare(`
      SELECT d.collection_id, d.path FROM documents d JOIN collections c ON d.collection_id = c.id
      WHERE d.id = ? AND c.owner_user_id = ?
    `).bind(parentId, uid).first() as any
    if (!parent) return c.html(errorFragment('親ドキュメントが見つかりません'), 404)
    if (parent.collection_id !== collectionId) return c.html(errorFragment('親ドキュメントが異なるコレクションです'), 400)
    path = `${parent.path}/${id}`
  } else {
    path = `/${collectionId}/${id}`
  }

  await createDocument(c.env.DB, auth, id, title, content, collectionId, parentId, path, now)

  const result = await renderDoc(c, id)
  notify(c, '作成しました')
  c.header('HX-Push-Url', `/?doc=${id}`)
  return c.html('error' in result ? errorFragment(result.error) : result.html)
})

// GET /ui/collections - Collection management page
uiRoute.get('/collections', async (c) => c.html(await renderCollectionsPage(c)))

// GET /ui/collections/:id - Single collection page (document list)
uiRoute.get('/collections/:id', async (c) => c.html(await renderCollectionPage(c, c.req.param('id'))))

// GET /ui/collections/:id/tree - 単一コレクションのドキュメントツリー（遅延取得用）
uiRoute.get('/collections/:id/tree', async (c) => {
  const uid = ownerUserIdOf(c.get('auth'))
  const id = c.req.param('id')
  const col = await c.env.DB.prepare('SELECT id, name FROM collections WHERE id = ? AND owner_user_id = ?')
    .bind(id, uid).first() as any
  if (!col) return c.html('<p class="tree-empty">コレクションが見つかりません</p>', 404)

  const docsResult = await c.env.DB.prepare(
    `SELECT id, title, collection_id, parent_id, priority FROM documents
     WHERE status = 'published' AND collection_id = ? ORDER BY updated_at DESC`
  ).bind(id).all()

  const docsByParent = new Map<string, Map<string | null, any[]>>()
  for (const doc of docsResult.results as any[]) {
    if (!docsByParent.has(doc.collection_id)) docsByParent.set(doc.collection_id, new Map())
    const parentMap = docsByParent.get(doc.collection_id)!
    const pid = doc.parent_id || null
    if (!parentMap.has(pid)) parentMap.set(pid, [])
    parentMap.get(pid)!.push(doc)
  }

  return c.html(renderCollectionDocs(col, docsByParent))
})

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
  const uid = ownerUserIdOf(auth)
  const now = Date.now()
  await c.env.DB.prepare(`
    INSERT INTO collections (id, name, parent_id, description, is_system, entrypoint_doc_id, owner_user_id,
      created_by_type, created_by_key_id, updated_by_type, updated_by_key_id, created_at, updated_at)
    VALUES (?, ?, NULL, NULL, 0, NULL, ?, ?, ?, ?, ?, ?, ?)
  `).bind(generateId('col'), name, uid, author.authorType, author.apiKeyId, author.authorType, author.apiKeyId, now, now).run()

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
  const uid = ownerUserIdOf(auth)
  const id = c.req.param('id')
  if (!isCollectionAllowed(auth, id)) return c.html(errorFragment('アクセス権がありません'), 403)

  const col = await c.env.DB.prepare('SELECT id, name FROM collections WHERE id = ? AND owner_user_id = ?').bind(id, uid).first() as any
  if (!col) return c.html(errorFragment('コレクションが見つかりません'), 404)

  const count = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM documents WHERE collection_id = ? AND status = 'published'`
  ).bind(id).first() as any

  return c.html(colHead(col, count.n, c.req.query('edit') === '1'))
})

// POST /ui/collections/:id/rename
uiRoute.post('/collections/:id/rename', async (c) => {
  const auth = c.get('auth')
  const uid = ownerUserIdOf(auth)
  const id = c.req.param('id')
  if (!isCollectionAllowed(auth, id)) return c.html(errorFragment('アクセス権がありません'), 403)

  const body = await c.req.parseBody()
  const name = String(body.name ?? '').trim()
  if (!name) return c.html(await renderCollectionsPage(c, '名前を入力してください'))

  const existing = await c.env.DB.prepare('SELECT id FROM collections WHERE id = ? AND owner_user_id = ?').bind(id, uid).first()
  if (!existing) return c.html(await renderCollectionsPage(c, 'コレクションが見つかりません'))

  const author = authorOf(auth)
  await c.env.DB.prepare('UPDATE collections SET name = ?, updated_at = ?, updated_by_type = ?, updated_by_key_id = ? WHERE id = ? AND owner_user_id = ?')
    .bind(name, Date.now(), author.authorType, author.apiKeyId, id, uid).run()

  notify(c, '名前を変更しました')
  return c.html(await renderCollectionsPage(c))
})

// POST /ui/collections/:id/delete - Refuses when not empty (same rule as the API)
uiRoute.post('/collections/:id/delete', async (c) => {
  const auth = c.get('auth')
  const uid = ownerUserIdOf(auth)
  const id = c.req.param('id')
  if (!isCollectionAllowed(auth, id)) return c.html(errorFragment('アクセス権がありません'), 403)

  const existing = await c.env.DB.prepare('SELECT id FROM collections WHERE id = ? AND owner_user_id = ?').bind(id, uid).first()
  if (!existing) return c.html(errorFragment('コレクションが見つかりません'), 404)

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

  await c.env.DB.prepare('DELETE FROM collections WHERE id = ? AND owner_user_id = ?').bind(id, uid).run()

  notify(c, 'コレクションを削除しました')
  return c.html(await renderCollectionsPage(c))
})
