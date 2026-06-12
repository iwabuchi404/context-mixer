// app.js - Context Mixer Client Logic
let config = null
let clerk = null

async function init() {
  const response = await fetch('/auth/config')
  if (!response.ok) throw new Error('Failed to load config')
  config = await response.json()

  // Load clerk-js
  await new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = `${config.frontend_api}/npm/@clerk/clerk-js@5/dist/clerk.browser.js`
    s.setAttribute('data-clerk-publishable-key', config.publishable_key)
    s.onload = resolve
    s.onerror = reject
    document.head.appendChild(s)
  })

  await window.Clerk.load()
  clerk = window.Clerk

  if (!clerk.user) {
    location.href = `${config.sign_in_url}?redirect_url=${encodeURIComponent(location.href)}`
    return
  }

  renderHeader()
  setupHtmxAuth()
  setupMobileMenu()
}

function setupMobileMenu() {
  document.body.addEventListener('click', (e) => {
    const toggle = e.target.closest('.menu-toggle');
    const sidebar = document.querySelector('.sidebar');
    const header = document.querySelector('header');
    
    if (toggle) {
      if (sidebar) {
        sidebar.classList.toggle('open');
      } else {
        header.classList.toggle('nav-open');
      }
    } else {
      // Close when clicking outside
      if (sidebar && sidebar.classList.contains('open') && !e.target.closest('.sidebar')) {
        sidebar.classList.remove('open');
      }
      if (header && header.classList.contains('nav-open') && !e.target.closest('nav')) {
        header.classList.remove('nav-open');
      }
    }
  });

  // Close sidebar on HTMX navigation
  document.body.addEventListener('htmx:afterRequest', (e) => {
    if (e.detail.target.id === 'documents-list' || e.detail.target.id === 'doc-content') {
      document.querySelector('.sidebar')?.classList.remove('open');
    }
  });
}

function renderHeader() {
  const el = document.querySelector('#user-info')
  if (!el) return
  el.innerHTML = `
    <span class="user-id">${clerk.user.id}</span>
    <button onclick="window.Clerk.signOut().then(() => location.reload())" class="btn-sm">Logout</button>
  `
}

function setupHtmxAuth() {
  // Handle async token retrieval for HTMX
  document.body.addEventListener('htmx:confirm', (evt) => {
    const elt = evt.detail.elt
    // If we already attached a fresh token to this element, let it go
    if (elt.getAttribute('data-auth-ready') === 'true') {
      elt.removeAttribute('data-auth-ready')
      return
    }

    evt.preventDefault() // Pause the request

    window.Clerk.session.getToken().then(token => {
      if (token) {
        elt.setAttribute('data-token', token)
        elt.setAttribute('data-auth-ready', 'true')
        evt.detail.issueRequest() // Resume the request
      }
    }).catch(console.error)
  })

  // Inject the token into the headers
  document.body.addEventListener('htmx:configRequest', (evt) => {
    const token = evt.detail.elt.getAttribute('data-token')
    if (token) {
      evt.detail.headers['Authorization'] = `Bearer ${token}`
      evt.detail.elt.removeAttribute('data-token') // Clean up
    }
  })
}

init().catch(err => {
  console.error('Initialization failed:', err)
  document.body.innerHTML = `<div style="padding:2rem;color:red">Initialization Error: ${err.message}</div>`
})
