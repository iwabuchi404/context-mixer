// OAuth consent UI for MCP (`/oauth/authorize`).
//
// This is the only OAuth endpoint the application implements; token issuance,
// dynamic client registration, metadata discovery and token validation are all
// handled by @cloudflare/workers-oauth-provider. This handler runs inside the
// defaultHandler (the Hono app), so it has access to env.OAUTH_PROVIDER.
//
// Flow:
//   GET  /oauth/authorize  → parse the OAuth request, require a Clerk session
//                            (redirect to sign-in if missing), then render a
//                            consent form letting the user pick scopes + the
//                            collections the grant may touch.
//   POST /oauth/authorize  → validate CSRF (double-submit cookie), then call
//                            completeAuthorization() with the chosen props and
//                            redirect back to the client.
//
// The granted choices become McpProps (see adapter.ts) and are reconstructed as
// an AiAuth context in handler.ts, so MCP tools enforce identical rules to REST.

import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { AuthRequest } from '@cloudflare/workers-oauth-provider'
import type { AppEnv } from '../auth/adapter'
import { clerkSession, verifySession } from '../auth/clerk'
import { escapeHtml } from '../services/markdown'

export const oauthRoute = new Hono<AppEnv>()

// Resolve the Clerk session on every consent request.
oauthRoute.use('*', clerkSession)

const CSRF_COOKIE = 'cm_oauth_txn'
const TXN_TTL = 600 // seconds

// A random transaction id. crypto.randomUUID is available on Workers.
const newTxn = () => crypto.randomUUID().replace(/-/g, '')

// Cookies must be Secure on https; over local http (wrangler dev) Secure cookies
// are dropped, so only set it when the request is actually https.
const isHttps = (url: string) => new URL(url).protocol === 'https:'

const page = (title: string, body: string) => `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - Context Mixer</title>
  <link rel="icon" href="/favicon.svg">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <main class="main-content">
    <div style="max-width: 640px; margin: var(--space-7) auto">
      ${body}
    </div>
  </main>
</body>
</html>`

const errorPage = (message: string) =>
  page('認可エラー', `<h1>認可できませんでした</h1><p class="muted">${escapeHtml(message)}</p>`)

// GET /oauth/authorize — show the consent screen (after requiring a Clerk login).
oauthRoute.get('/authorize', async (c) => {
  let oauthReq: AuthRequest
  try {
    oauthReq = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw)
  } catch {
    return c.html(errorPage('OAuth リクエストの形式が不正です。'), 400)
  }
  if (!oauthReq.clientId) {
    return c.html(errorPage('client_id がありません。'), 400)
  }

  // Require a human Clerk session; bounce unauthenticated users to sign-in and
  // come back to this exact authorize URL afterwards.
  const userId = verifySession(c)
  if (!userId) {
    const back = encodeURIComponent(c.req.url)
    return c.redirect(`${c.env.CLERK_SIGN_IN_URL}?redirect_url=${back}`)
  }

  // Persist the parsed request server-side; the txn id ties the consent POST to
  // this browser via a SameSite cookie (CSRF double-submit).
  const txn = newTxn()
  await c.env.OAUTH_KV.put(`consent:${txn}`, JSON.stringify(oauthReq), { expirationTtl: TXN_TTL })
  setCookie(c, CSRF_COOKIE, txn, {
    httpOnly: true,
    secure: isHttps(c.req.url),
    sameSite: 'Lax',
    path: '/',
    maxAge: TXN_TTL,
  })

  // Look up the requesting client's name (best-effort) and the collection list.
  const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId).catch(() => null)
  const clientLabel = client?.clientName || oauthReq.clientId

  const cols = await c.env.DB.prepare('SELECT id, name FROM collections WHERE owner_user_id = ? ORDER BY name').bind(userId).all()
  const collections = (cols.results as { id: string; name: string }[]) ?? []

  const collectionChoices = collections
    .map(
      (col) => `<label class="consent-row">
        <input type="checkbox" name="collections" value="${escapeHtml(col.id)}">
        <span>${escapeHtml(col.name)}</span>
        <code class="mono muted">${escapeHtml(col.id)}</code>
      </label>`
    )
    .join('\n')

  const body = `
    <h1>接続を許可</h1>
    <p class="muted">
      <strong>${escapeHtml(clientLabel)}</strong> が Context Mixer への接続を要求しています。
      付与する権限と対象コレクションを選んでください。
    </p>
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="txn" value="${escapeHtml(txn)}">

      <div class="doc-meta-card" style="margin:var(--space-6) 0">
        <h3>権限</h3>
        <label class="consent-row"><input type="checkbox" name="scopes" value="read" checked> <span>READ（検索・閲覧）</span></label>
        <label class="consent-row"><input type="checkbox" name="scopes" value="write"> <span>WRITE（作成・更新・追記）</span></label>
      </div>

      <div class="doc-meta-card" style="margin:var(--space-6) 0">
        <h3>対象コレクション</h3>
        <label class="consent-row"><input type="checkbox" name="all_collections" value="1" checked> <span>すべてのコレクション</span></label>
        <details style="margin-top:var(--space-3)">
          <summary class="muted" style="cursor:pointer">特定のコレクションに限定する</summary>
          <p class="muted" style="font-size:var(--text-xs); margin:var(--space-2) 0">
            「すべてのコレクション」を外し、許可するものを選択してください。
          </p>
          ${collectionChoices || '<p class="muted">コレクションがありません。</p>'}
        </details>
      </div>

      <div class="form-row" style="gap:var(--space-3)">
        <button type="submit" name="decision" value="approve" class="btn-primary">許可する</button>
        <button type="submit" name="decision" value="deny" class="btn-quiet">拒否</button>
      </div>
    </form>`

  return c.html(page('接続を許可', body))
})

// POST /oauth/authorize — complete (or deny) the authorization.
oauthRoute.post('/authorize', async (c) => {
  const userId = verifySession(c)
  if (!userId) return c.html(errorPage('セッションが切れています。最初からやり直してください。'), 401)

  const form = await c.req.parseBody({ all: true })
  const txn = typeof form.txn === 'string' ? form.txn : ''
  const cookieTxn = getCookie(c, CSRF_COOKIE)

  // CSRF: the form txn must match the cookie set when the page was rendered.
  if (!txn || !cookieTxn || txn !== cookieTxn) {
    return c.html(errorPage('リクエストの検証に失敗しました（CSRF）。やり直してください。'), 403)
  }

  const stored = await c.env.OAUTH_KV.get(`consent:${txn}`)
  if (!stored) {
    return c.html(errorPage('認可セッションの有効期限が切れています。やり直してください。'), 400)
  }
  const oauthReq = JSON.parse(stored) as AuthRequest

  // One-time use: consume the txn and clear the cookie regardless of outcome.
  await c.env.OAUTH_KV.delete(`consent:${txn}`)
  deleteCookie(c, CSRF_COOKIE, { path: '/' })

  const decision = typeof form.decision === 'string' ? form.decision : ''
  if (decision === 'deny') {
    const redirect = new URL(oauthReq.redirectUri)
    redirect.searchParams.set('error', 'access_denied')
    if (oauthReq.state) redirect.searchParams.set('state', oauthReq.state)
    return c.redirect(redirect.toString())
  }

  // Normalize the submitted scope checkboxes (parseBody({all:true}) yields arrays
  // for repeated names, or a single value).
  const asArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]

  const requestedScopes = asArray(form.scopes).filter((s) => s === 'read' || s === 'write')
  // Always grant at least read so an empty selection isn't a useless grant.
  const scopes = requestedScopes.length ? requestedScopes : ['read']

  // Collection restriction: "all" (or nothing) ⇒ null (unrestricted). Otherwise
  // intersect the submitted ids with real collections to avoid trusting input.
  let allowedCollections: string[] | null = null
  if (!form.all_collections) {
    const chosen = asArray(form.collections)
    if (chosen.length) {
      const rows = await c.env.DB.prepare('SELECT id FROM collections WHERE owner_user_id = ?').bind(userId).all()
      const valid = new Set((rows.results as { id: string }[]).map((r) => r.id))
      allowedCollections = chosen.filter((id) => valid.has(id))
    } else {
      // Restricted but selected nothing ⇒ no access at all.
      allowedCollections = []
    }
  }

  // Resolve the user's email for grant attribution (signed revisions use it).
  let email = ''
  try {
    const clerk = (c as any).get('clerk')
    const user = await clerk.users.getUser(userId)
    email = user.primaryEmailAddress?.emailAddress ?? user.emailAddresses?.[0]?.emailAddress ?? ''
  } catch {
    /* best-effort; fall back to userId below */
  }
  const keyName = `oauth:${email || userId}`

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId,
    scope: scopes,
    metadata: { keyName },
    props: { userId, keyName, scopes, allowedCollections },
  })

  return c.redirect(redirectTo)
})
