// Public share page: GET /s/:id
// Unauthenticated read-only view of a single document.
// URL is unguessable (random token). Editing the document is reflected
// immediately because we read from DB on every request.
import { Hono } from 'hono'
import type { Env } from '../auth/adapter'
import { escapeHtml as esc, renderMarkdown } from '../services/markdown'
import { parseSections } from '../services/sections'

export const shareRoute = new Hono<{ Bindings: Env }>()

shareRoute.get('/:id', async (c) => {
  const id = c.req.param('id')

  // share_links → documents → collections (owner不要、公開ページは認証なし)
  const row = await c.env.DB.prepare(`
    SELECT d.id, d.title, d.content, d.updated_at, c.name AS collection_name
    FROM share_links s
    JOIN documents d ON d.id = s.doc_id
    JOIN collections c ON c.id = d.collection_id
    WHERE s.id = ? AND d.status = 'published'
  `).bind(id).first() as any

  if (!row) {
    return c.html(notFoundHtml(), 404)
  }

  // backlinks (閲覧者にも表示。リンク先タイトルのみ)
  const linksResult = await c.env.DB.prepare(`
    SELECT d.id, d.title FROM document_links l JOIN documents d ON d.id = l.to_doc_id
    WHERE l.from_doc_id = ? ORDER BY d.title
  `).bind(row.id).all()
  const backlinksResult = await c.env.DB.prepare(`
    SELECT d.id, d.title FROM document_links l JOIN documents d ON d.id = l.from_doc_id
    WHERE l.to_doc_id = ? ORDER BY d.title
  `).bind(row.id).all()

  const linkTitles = new Map<string, string>(
    (linksResult.results as any[]).map((r) => [r.id, r.title])
  )
  const body = renderMarkdown(row.content, linkTitles)
  const sections = parseSections(row.content)

  let tocSidebar = ''
  let tocMobile = ''
  if (sections.length >= 2) {
    const items = sections.map((s) =>
      `<a href="#${esc(s.slug)}" style="--toc-depth:${s.level - 1}">${esc(s.title)}</a>`).join('\n')
    tocSidebar = `<nav class="doc-toc" aria-label="目次">${items}</nav>`
    tocMobile = `<details class="doc-toc-mobile"><summary>目次</summary><div>${items}</div></details>`
  }

  const backlinks = backlinksResult.results as any[]
  let foot = ''
  if (backlinks.length > 0) {
    foot += `<section class="doc-backlinks">
      <h2>このページを参照しているページ</h2>
      ${backlinks.map((b) => `<a class="tree-item">${esc(b.title)}</a>`).join('\n')}
    </section>\n`
  }

  const updated = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(row.updated_at))

  return c.html(pageHtml({
    title: row.title,
    collectionName: row.collection_name,
    updated,
    body, tocSidebar, tocMobile, foot,
  }))
})

const pageHtml = (p: {
  title: string, collectionName: string, updated: string,
  body: string, tocSidebar: string, tocMobile: string, foot: string,
}) => `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${esc(p.title)} - Context Mixer</title>
  <link rel="icon" href="/favicon.svg">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header>
    <a class="brand" href="/">Context Mixer</a>
    <span class="spacer"></span>
    <span class="muted">共有ドキュメント</span>
  </header>

  <main class="share-page">
    <div id="doc-view-inner">
      <div class="doc-sticky-head">
        <div class="doc-head">
          <h1 class="doc-title">${esc(p.title)}</h1>
        </div>
        <p class="meta-line">${esc(p.collectionName)} ・ ${esc(p.updated)}</p>
      </div>
      ${p.tocMobile}
      <div class="doc-columns">
        <article class="prose">${p.body}</article>
        ${p.tocSidebar}
      </div>
      ${p.foot}
    </div>
  </main>
</body>
</html>`

const notFoundHtml = () => `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>共有リンクが見つかりません - Context Mixer</title>
  <link rel="icon" href="/favicon.svg">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header>
    <a class="brand" href="/">Context Mixer</a>
  </header>
  <main class="share-page">
    <div id="doc-view-inner">
      <h1 class="doc-title">共有リンクが見つかりません</h1>
      <p class="muted">リンクが取り消されたか、存在しません。了</p>
    </div>
  </main>
</body>
</html>`
