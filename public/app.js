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
  const params = new URLSearchParams(location.search)

  // /ui/init で tree + main を1往復で取得（初回ロード高速化）
  if (params.get('view') === 'collections') {
    htmx.ajax('GET', '/ui/tree', { target: '#tree-area' })
    htmx.ajax('GET', '/ui/collections', { target: '#doc-view' })
    return
  }
  if (params.get('col')) {
    htmx.ajax('GET', '/ui/tree', { target: '#tree-area' })
    htmx.ajax('GET', `/ui/collections/${params.get('col')}`, { target: '#doc-view' })
    return
  }

  // 通常時: /ui/init で統合取得
  const docId = params.get('doc') || localStorage.getItem('lastDoc')
  const initUrl = '/ui/init' + (docId ? `?doc=${encodeURIComponent(docId)}` : '')
  fetch(initUrl, { headers: { Authorization: `Bearer ${cachedToken}` } })
    .then((r) => r.json())
    .then((data) => {
      const treeArea = document.getElementById('tree-area')
      const docView = document.getElementById('doc-view')
      treeArea.innerHTML = data.tree
      docView.innerHTML = data.main
      // htmx に挿入したHTMLを認識させる
      htmx.process(treeArea)
      htmx.process(docView)
      // afterSwap 相当の処理を直接呼ぶ
      onSwap(treeArea)
      onSwap(docView)
    })
    .catch((e) => {
      console.error('init fetch failed:', e)
      // フォールバック: 従来通り個別取得
      htmx.ajax('GET', '/ui/tree', { target: '#tree-area' })
      htmx.ajax('GET', '/ui/welcome', { target: '#doc-view' })
    })
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
    } else {
      showSysline(`操作に失敗しました (HTTP ${evt.detail.xhr.status})`, true)
    }
  })
  document.body.addEventListener('htmx:sendError', () => {
    showSysline('接続できません — ネットワークを確認してください', true)
  })
}

// --- system line: operation feedback in the bottom-right corner ---
// Normal messages are quiet (thin border); errors turn solid red.
let syslineTimer = null
function showSysline(message, isError = false) {
  document.getElementById('sysline')?.remove()
  const el = document.createElement('div')
  el.id = 'sysline'
  el.className = 'sysline' + (isError ? ' is-error' : '')
  const mark = document.createElement('span')
  mark.className = 'ok'
  mark.textContent = isError ? '✗' : '✓'
  el.append(mark, ` ${message} — ${new Date().toTimeString().slice(0, 5)}`)
  document.body.appendChild(el)
  clearTimeout(syslineTimer)
  syslineTimer = setTimeout(() => el.remove(), isError ? 8000 : 4000)
}

function setupHeader() {
  document.getElementById('signout')?.addEventListener('click', () => {
    clerk.signOut().then(() => location.href = '/')
  })
}

// afterSwap 処理を関数化（htmxイベント と /ui/init の両方から呼ぶ）
function onSwap(target) {
  if (target.id === 'doc-view') {
    maybeFallbackToWelcome()
    const inner = document.getElementById('doc-view-inner')
    const docId = inner?.dataset.docId
    const title = inner?.dataset.docTitle
    if (docId) localStorage.setItem('lastDoc', docId)
    document.title = title ? `${title} - Context Mixer` : 'Context Mixer'
    markCurrent(docId)
    document.getElementById('sidebar')?.classList.remove('open')
    target.scrollTop = 0
    document.querySelector('.main-content')?.scrollTo(0, 0)
    addCopyButtons()
    setupEditor()
  }
  if (target.id === 'tree-area') {
    applyCollapsedState()
    markCurrent(document.getElementById('doc-view-inner')?.dataset.docId)
  }
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

// --- editor enhancements (line numbers + snippets) ---
function setupEditor() {
  const wrap = document.querySelector('.editor-wrap')
  if (!wrap) return
  const textarea = wrap.querySelector('textarea.editor')
  const numbers = wrap.querySelector('.line-numbers')
  if (!textarea || !numbers) return

  const sync = () => {
    const lines = textarea.value.split('\n').length
    const current = numbers.children.length
    if (lines !== current) {
      numbers.innerHTML = Array.from({ length: lines }, (_, i) => `<div>${i + 1}</div>`).join('')
    }
    // Scroll sync
    numbers.scrollTop = textarea.scrollTop
  }

  textarea.addEventListener('input', sync)
  textarea.addEventListener('scroll', () => { numbers.scrollTop = textarea.scrollTop })
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault()
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      textarea.setRangeText('  ', start, end, 'end')
      textarea.dispatchEvent(new Event('input'))
    }
  })
  sync()

  // Snippet / wrap / block / prefix buttons
  const toolbar = textarea.closest('.editor-form')?.querySelector('.editor-toolbar')
  if (toolbar) {
    const insert = (replacement, cursorPos) => {
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      textarea.setRangeText(replacement, start, end, 'end')
      textarea.selectionStart = textarea.selectionEnd = cursorPos ?? (start + replacement.length)
      textarea.focus()
      textarea.dispatchEvent(new Event('input'))
    }

    toolbar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-snippet], [data-wrap-before], [data-block], [data-line-prefix], [data-numbered-list]')
      if (!btn) return
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const selected = textarea.value.slice(start, end)

      const before = btn.dataset.wrapBefore || ''
      const after = btn.dataset.wrapAfter || ''
      if (before || after) {
        const replacement = before + selected + after
        const cursorPos = selected ? start + replacement.length : start + before.length
        insert(replacement, cursorPos)
        return
      }

      const blockStart = btn.dataset.block || ''
      const blockEnd = btn.dataset.blockEnd || ''
      if (blockStart || blockEnd) {
        const replacement = blockStart + selected + blockEnd
        const cursorPos = selected ? start + replacement.length : start + blockStart.length
        insert(replacement, cursorPos)
        return
      }

      const linePrefix = btn.dataset.linePrefix || ''
      if (linePrefix) {
        const replacement = selected
          ? selected.split('\n').map((line) => linePrefix + line).join('\n')
          : linePrefix
        const cursorPos = selected ? start + replacement.length : start + linePrefix.length
        insert(replacement, cursorPos)
        return
      }

      if (btn.dataset.numberedList !== undefined) {
        const replacement = selected
          ? selected.split('\n').map((line, i) => `${i + 1}. ${line}`).join('\n')
          : '1. '
        const cursorPos = selected ? start + replacement.length : start + replacement.length
        insert(replacement, cursorPos)
        return
      }

      const snippet = btn.dataset.snippet || ''
      const cursorOffset = parseInt(btn.dataset.cursor || '0', 10)
      insert(snippet, start + Math.min(cursorOffset, snippet.length))
    })

    const headingButtons = toolbar.querySelectorAll('[data-heading-insert]')
    headingButtons.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const level = parseInt(e.target.closest('[data-heading-insert]').dataset.headingInsert, 10)
        const start = textarea.selectionStart
        const end = textarea.selectionEnd
        const value = textarea.value

        // Determine the line range to affect.
        let lineStart = value.lastIndexOf('\n', start - 1) + 1
        let lineEnd = value.indexOf('\n', end)
        if (lineEnd === -1) lineEnd = value.length

        const lines = value.slice(lineStart, lineEnd).split('\n')
        const newLines = lines.map((line) => {
          const match = line.match(/^(#{1,6}) /)
          if (match) {
            const currentLevel = match[1].length
            if (currentLevel === level) return line.replace(/^(#{1,6}) /, '')
            return '#'.repeat(level) + ' ' + line.replace(/^(#{1,6}) /, '')
          }
          return '#'.repeat(level) + ' ' + line
        })
        const replacement = newLines.join('\n')
        textarea.setRangeText(replacement, lineStart, lineEnd, 'end')
        textarea.selectionStart = textarea.selectionEnd = lineStart + replacement.length
        textarea.focus()
        textarea.dispatchEvent(new Event('input'))
      })
    })

    // Image upload button
    const uploadImageBtn = toolbar.querySelector('[data-upload-image]')
    if (uploadImageBtn) {
      uploadImageBtn.addEventListener('click', async () => {
        const docView = document.getElementById('doc-view-inner')
        const docId = docView?.dataset.docId
        if (!docId) {
          alert('画像アップロードは、ドキュメント作成後に利用できます')
          return
        }

        const input = document.createElement('input')
        input.type = 'file'
        input.accept = 'image/*'
        input.onchange = async () => {
          const file = input.files?.[0]
          if (!file) return

          const formData = new FormData()
          formData.append('file', file)
          formData.append('document_id', docId)

          try {
            const res = await fetch('/files', { method: 'POST', body: formData })
            if (!res.ok) {
              const body = await res.json().catch(() => ({}))
              alert('画像アップロードに失敗しました: ' + (body.error?.message || res.status))
              return
            }
            const data = await res.json()
            const fileId = data.id || data.data?.id
            if (!fileId) {
              alert('画像の情報が取得できませんでした')
              return
            }
            const alt = file.name.replace(/\.[^/.]+$/, '')
            const markdown = `![${alt}](/files/${fileId}/raw)`
            const start = textarea.selectionStart
            insert(markdown, start + markdown.length)
          } catch (err) {
            alert('画像アップロード中にエラーが発生しました')
            console.error(err)
          }
        }
        input.click()
      })
    }
  }
}

// --- reading pane lifecycle ---
function setupDocView() {
  // Refresh the tree when the server says so (create/save/delete)
  document.body.addEventListener('tree-refresh', () => {
    htmx.ajax('GET', '/ui/tree', { target: '#tree-area' })
  })

  // Server-sent system line messages (HX-Trigger: {"sysline": "..."})
  document.body.addEventListener('sysline', (e) => {
    showSysline(e.detail.value)
  })

  document.body.addEventListener('htmx:afterSwap', (e) => {
    onSwap(e.detail.target)
  })

  // Collapse toggle for collections (▾ next to the name) AND documents that
  // have children. Both persist their collapsed ids separately.
  document.body.addEventListener('click', (e) => {
    const toggle = e.target.closest('.tree-toggle')
    if (!toggle) return

    // Document toggle: collapse the .tree-doc-item and hide the sibling .tree-doc-children
    if (toggle.classList.contains('tree-toggle-doc')) {
      const item = toggle.closest('.tree-doc-item')
      if (!item) return
      item.classList.toggle('collapsed')
      const docId = item.dataset.docId
      const collapsed = new Set(JSON.parse(localStorage.getItem('collapsedDocs') || '[]'))
      if (item.classList.contains('collapsed')) collapsed.add(docId)
      else collapsed.delete(docId)
      localStorage.setItem('collapsedDocs', JSON.stringify([...collapsed]))
      return
    }

    // Collection toggle
    const group = toggle.closest('.tree-group')
    if (!group) return

    // 遅延取得未実施のコレクション: htmx.ajax() で直接取得
    const lazyUrl = toggle.dataset.lazy
    if (lazyUrl && group.classList.contains('collapsed')) {
      const children = group.querySelector(':scope > .tree-children')
      if (children && !children.dataset.loaded) {
        if (toggle.classList.contains('htmx-request')) return
        const icon = toggle.querySelector('.tree-toggle-icon')
        const originalIcon = icon ? icon.textContent : '▾'
        if (icon) icon.innerHTML = '<span class="spinner"></span>'
        toggle.classList.add('htmx-request')

        htmx.ajax('GET', lazyUrl, {
          target: children,
          swap: 'innerHTML',
        }).then(() => {
          // 取得完了: 展開 + フラグ削除
          children.dataset.loaded = '1'
          toggle.removeAttribute('data-lazy')
          group.classList.remove('collapsed')
          const collapsed = new Set(JSON.parse(localStorage.getItem('collapsedCols') || '[]'))
          collapsed.delete(group.dataset.colId)
          localStorage.setItem('collapsedCols', JSON.stringify([...collapsed]))
          htmx.process(children)
        }).catch(() => {
          showSysline('コレクションの読み込みに失敗しました', true)
        }).finally(() => {
          if (icon) icon.textContent = originalIcon
          toggle.classList.remove('htmx-request')
        })
        return
      }
    }

    group.classList.toggle('collapsed')
    const collapsed = new Set(JSON.parse(localStorage.getItem('collapsedCols') || '[]'))
    if (group.classList.contains('collapsed')) collapsed.add(group.dataset.colId)
    else collapsed.delete(group.dataset.colId)
    localStorage.setItem('collapsedCols', JSON.stringify([...collapsed]))
  })
}

function applyCollapsedState() {
  // First-ever load (no saved state): サーバーが既に collapsed クラスを付与済み。
  // localStorage に保存して状態を固定化する。
  if (localStorage.getItem('collapsedCols') === null) {
    const allCols = [...document.querySelectorAll('.tree-group.collapsed')]
      .map((g) => g.dataset.colId)
      .filter(Boolean)
    localStorage.setItem('collapsedCols', JSON.stringify(allCols))
  }

  const collapsedCols = new Set(JSON.parse(localStorage.getItem('collapsedCols') || '[]'))
  const collapsedDocs = new Set(JSON.parse(localStorage.getItem('collapsedDocs') || '[]'))
  document.querySelectorAll('.tree-group').forEach((group) => {
    // data-lazy 付き（未取得）のコレクションは localStorage に関わらず collapsed を維持
    const toggle = group.querySelector('.tree-toggle')
    const isLazy = toggle?.dataset.lazy
    if (isLazy) {
      // 遅延取得コレクション: localStorage に保存済みなら collapsed、未保存ならデフォルト collapsed
      if (collapsedCols.has(group.dataset.colId) || localStorage.getItem('collapsedCols') === null) {
        group.classList.add('collapsed')
      } else {
        group.classList.remove('collapsed')
      }
    } else {
      // 取得済みコレクション: localStorage に従う
      if (collapsedCols.has(group.dataset.colId)) group.classList.add('collapsed')
      else group.classList.remove('collapsed')
    }
  })
  document.querySelectorAll('.tree-doc-item[data-doc-id]').forEach((item) => {
    if (collapsedDocs.has(item.dataset.docId)) item.classList.add('collapsed')
  })
}

function markCurrent(docId) {
  document.querySelectorAll('.tree-item[aria-current]').forEach((el) => el.removeAttribute('aria-current'))
  if (!docId) return
  document.querySelectorAll(`.tree-item[data-doc-id="${docId}"]`).forEach((el) => el.setAttribute('aria-current', 'page'))
}

// --- copy to clipboard ---
// Global markdown copy buttons (e.g. image management page)
document.body.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy-markdown]')
  if (!btn) return
  e.preventDefault()
  const markdown = btn.dataset.copyMarkdown || ''
  navigator.clipboard.writeText(markdown).then(() => {
    showSysline('Markdown をコピーしました')
  }).catch(() => {
    showSysline('コピーに失敗しました', true)
  })
})

// Adds a copy button to each code block and a "copy article" button to the
// doc header. Idempotent — skips elements that already have a button so it
// can run after every HTMX swap.
const flashCopyBtn = (btn, okText, errText, revert) => {
  btn.textContent = okText
  btn.classList.add('is-done')
  setTimeout(() => {
    btn.textContent = revert
    btn.classList.remove('is-done')
  }, 1500)
}

function addCopyButtons() {
  const docView = document.getElementById('doc-view-inner')
  if (!docView) return

  // Code blocks: a quiet "copy" pill in the top-right corner
  docView.querySelectorAll('.prose pre').forEach((pre) => {
    if (pre.querySelector('.copy-btn')) return
    pre.classList.add('has-copy')
    const btn = document.createElement('button')
    btn.className = 'copy-btn'
    btn.type = 'button'
    btn.textContent = 'コピー'
    btn.setAttribute('aria-label', 'コードをコピー')
    btn.addEventListener('click', async () => {
      const code = pre.querySelector('code')
      const text = code ? code.textContent : pre.textContent
      try {
        await navigator.clipboard.writeText(text || '')
        flashCopyBtn(btn, '✓', 'コピー', 'コピー')
      } catch {
        flashCopyBtn(btn, '✗', 'コピー', 'コピー')
      }
    })
    pre.appendChild(btn)
  })

  // Article header: copy the document as Markdown source (title + body).
  // Fetches the raw Markdown so tables, code blocks, and [[doc_xxx]] links
  // survive the copy — much better for AI context ingestion than rendered text.
  const head = docView.querySelector('.doc-head')
  if (head && !head.querySelector('.article-copy-btn')) {
    const article = docView.querySelector('.prose')
    if (article) {
      const copyBtn = document.createElement('button')
      copyBtn.className = 'btn-ghost article-copy-btn'
      copyBtn.type = 'button'
      copyBtn.textContent = '記事をコピー'
      copyBtn.setAttribute('aria-label', '記事をMarkdownでコピー')
      copyBtn.addEventListener('click', async () => {
        const docId = docView.dataset.docId
        try {
          if (docId) {
            const res = await fetch(`/ui/doc/${docId}?raw=1`)
            if (res.ok) {
              const data = await res.json()
              await navigator.clipboard.writeText(`# ${data.title}\n\n${data.content}`)
              flashCopyBtn(copyBtn, '✓ コピー済み', 'コピー', '記事をコピー')
              return
            }
          }
          // Fallback: rendered title + prose text
          const title = docView.querySelector('.doc-title')?.textContent?.trim() || ''
          await navigator.clipboard.writeText(`${title}\n\n${article.textContent || ''}`.trim())
          flashCopyBtn(copyBtn, '✓ コピー済み', 'コピー', '記事をコピー')
        } catch {
          flashCopyBtn(copyBtn, '✗', 'コピー', '記事をコピー')
        }
      })
      head.appendChild(copyBtn)
    }
  }
}

init().catch((err) => {
  console.error('Initialization failed:', err)
  document.body.innerHTML = `<p class="error" style="padding:2rem">起動に失敗しました: ${err.message}</p>`
})
