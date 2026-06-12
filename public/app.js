// Shared bootstrap for all pages: Clerk session + API helper.

let config = null

// Loads clerk-js and ensures the user is signed in.
// Returns the Clerk instance; redirects to the sign-in portal when signed out.
export async function requireAuth() {
  config = await (await fetch('/config')).json()

  await new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = `${config.frontend_api}/npm/@clerk/clerk-js@5/dist/clerk.browser.js`
    s.setAttribute('data-clerk-publishable-key', config.publishable_key)
    s.onload = resolve
    s.onerror = () => reject(new Error('Failed to load clerk-js'))
    document.head.appendChild(s)
  })

  await window.Clerk.load()

  if (!window.Clerk.user) {
    // The portal appends the dev-browser handshake token to redirect_url;
    // clerk-js picks it up when we land back on this page.
    location.href = `${config.sign_in_url}?redirect_url=${encodeURIComponent(location.href)}`
    await new Promise(() => {}) // halt page scripts during navigation
  }

  return window.Clerk
}

// Authenticated fetch. Throws Error with the API message on failure.
export async function api(path, options = {}) {
  const token = await window.Clerk.session.getToken()
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const message = data?.error?.message
    throw new Error(typeof message === 'string' ? message : `HTTP ${res.status}`)
  }
  return data
}

export function renderHeader(clerk) {
  const el = document.querySelector('header')
  if (!el) return
  el.innerHTML = `
    <a class="brand" href="/">Context Mixer</a>
    <nav>
      <a href="/">Docs</a>
      <a href="/keys">API Keys</a>
    </nav>
    <span class="spacer"></span>
    <span class="user">${clerk.user?.primaryEmailAddress?.emailAddress ?? ''}</span>
    <button id="signout">Sign out</button>
  `
  el.querySelector('#signout').addEventListener('click', async () => {
    await clerk.signOut()
    location.href = '/'
  })
}
