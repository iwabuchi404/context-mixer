// Context Mixer client bootstrap.
// Auth: Clerk session token is attached to every HTMX request via the
// htmx:confirm pause/resume pattern (tokens are short-lived, fetched per request).
let config = null
let clerk = null

async function init() {
  const response = await fetch('/auth/config')
  if (!response.ok) throw new Error('設定の読み込みに失敗しました')
  config = await response.json()

  await new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = `${config.frontend_api}/npm/@clerk/clerk-js@5/dist/clerk.browser.js`
    s.setAttribute('data-clerk-publishable-key', config.publishable_key)
    s.onload = resolve
    s.onerror = () => reject(new Error('clerk-jsの読み込みに失敗しました'))
    document.head.appendChild(s)
  })

  await window.Clerk.load()
  clerk = window.Clerk

  if (!clerk.user) {
    location.href = `${config.sign_in_url}?redirect_url=${encodeURIComponent(location.href)}`
    return
  }

  setupHtmxAuth()
  setupHeader()
  setupDrawer()
  setupDocView()

  await refreshToken()

  // Admin pages listen for this instead of hx-trigger="load" (which races clerk-js)
  htmx.trigger(document.body, 'auth-ready')

  // Main shell: explicit initial load after auth is ready
  if (document.getElementById('doc-view')) {
    loadInitial()
  }
}

function loadInitial() {
  htmx.ajax('GET', '/ui/tree', { target: '#tree-area' })

  const params = new URLSearchParams(location.search)
  if (params.get('view') === 'collections') {
    htmx.ajax('GET', '/ui/collections', { target: '#doc-view' })
    return
  }
  const docId = params.get('doc') || localStorage.getItem('lastDoc')
  htmx.ajax('GET', docId ? `/ui/doc/${docId}` : '/ui/welcome', { target: '#doc-view' })
}

// A stale lastDoc (deleted doc) leaves an error fragment — fall back to welcome once.
// Done on afterSwap because htmx.ajax's promise resolves before the swap happens.
let welcomeFallbackDone = false
function maybeFallbackToWelcome() {
  if (welcomeFallbackDone) return
  if (!document.getElementById('doc-view-inner')) {
    welcomeFallbackDone = true
    localStorage.removeItem('lastDoc')
    htmx.ajax('GET', '/ui/welcome', { target: '#doc-view' })
  }
}

// --- auth: keep a fresh session token cached, attach it to every HTMX request ---
// (per-request async fetching via element attributes races when requests run in
// parallel; a cached token refreshed ahead of expiry is simpler and reliable)
let cachedToken = null

async function refreshToken() {
  try {
    cachedToken = await clerk.session.getToken()
  } catch (e) {
    console.error('Token refresh failed:', e)
  }
}

function setupHtmxAuth() {
  // Clerk session tokens live ~60s; refresh well before that
  setInterval(refreshToken, 30_000)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshToken()
  })

  document.body.addEventListener('htmx:configRequest', (evt) => {
    if (cachedToken) {
      evt.detail.headers['Authorization'] = `Bearer ${cachedToken}`
    }
  })

  // Expired token (e.g. after laptop sleep): refresh and reload once
  document.body.addEventListener('htmx:responseError', (evt) => {
    if (evt.detail.xhr.status === 401) {
      refreshToken().then(() => location.reload())
    }
  })
}

function setupHeader() {
  document.getElementById('signout')?.addEventListener('click', () => {
    clerk.signOut().then(() => location.reload())
  })
}

// --- mobile drawer ---
function setupDrawer() {
  document.body.addEventListener('click', (e) => {
    const sidebar = document.getElementById('sidebar')
    if (!sidebar) return
    if (e.target.closest('.menu-toggle')) {
      sidebar.classList.toggle('open')
    } else if (sidebar.classList.contains('open') && !e.target.closest('#sidebar')) {
      sidebar.classList.remove('open')
    }
  })
}

// --- reading pane lifecycle ---
function setupDocView() {
  // Refresh the tree when the server says so (create/save/delete)
  document.body.addEventListener('tree-refresh', () => {
    htmx.ajax('GET', '/ui/tree', { target: '#tree-area' })
  })

  document.body.addEventListener('htmx:afterSwap', (e) => {
    if (e.detail.target.id === 'doc-view') {
      maybeFallbackToWelcome()
      const inner = document.getElementById('doc-view-inner')
      const docId = inner?.dataset.docId
      const title = inner?.dataset.docTitle
      if (docId) localStorage.setItem('lastDoc', docId)
      document.title = title ? `${title} - Context Mixer` : 'Context Mixer'
      markCurrent(docId)
      document.getElementById('sidebar')?.classList.remove('open')
      e.detail.target.scrollTop = 0
      document.querySelector('.main-content')?.scrollTo(0, 0)
    }
    if (e.detail.target.id === 'tree-area') {
      applyCollapsedState()
      markCurrent(document.getElementById('doc-view-inner')?.dataset.docId)
    }
  })

  // Collection collapse toggle (the icon next to the name) — persisted per collection id
  document.body.addEventListener('click', (e) => {
    const toggle = e.target.closest('.tree-toggle')
    if (!toggle) return
    const group = toggle.closest('.tree-group')
    group.classList.toggle('collapsed')
    const collapsed = new Set(JSON.parse(localStorage.getItem('collapsedCols') || '[]'))
    if (group.classList.contains('collapsed')) collapsed.add(group.dataset.colId)
    else collapsed.delete(group.dataset.colId)
    localStorage.setItem('collapsedCols', JSON.stringify([...collapsed]))
  })
}

function applyCollapsedState() {
  const collapsed = new Set(JSON.parse(localStorage.getItem('collapsedCols') || '[]'))
  document.querySelectorAll('.tree-group').forEach((group) => {
    if (collapsed.has(group.dataset.colId)) group.classList.add('collapsed')
  })
}

function markCurrent(docId) {
  document.querySelectorAll('.tree-item[aria-current]').forEach((el) => el.removeAttribute('aria-current'))
  if (!docId) return
  document.querySelectorAll(`.tree-item[data-doc-id="${docId}"]`).forEach((el) => el.setAttribute('aria-current', 'page'))
}

init().catch((err) => {
  console.error('Initialization failed:', err)
  document.body.innerHTML = `<p class="error" style="padding:2rem">起動に失敗しました: ${err.message}</p>`
})
