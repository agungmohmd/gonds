'use strict'
/* global window, document, U, D, Term, SftpPanel */

const Tabs = (() => {
  const tabs = []
  let active = null
  let seq = 0

  const tabsEl = () => U.$('#tabs')
  const panesEl = () => U.$('#panes')

  // ------------------------------------------------------------------ Tab --
  class Tab {
    constructor (spec) {
      this.id = `tab${++seq}`
      this.spec = spec
      this.title = spec.name || spec.host || U.TYPE_LABEL[spec.type] || 'session'
      this.pinned = false
      this.terms = []
      this.sftp = null

      this.pane = U.el('div', { class: 'pane', hidden: true })
      this.tabEl = U.el('div', {
        class: 'tab',
        dataset: { id: this.id },
        draggable: 'true',
        onclick: () => activate(this),
        onauxclick: (e) => { if (e.button === 1) this.requestClose() },
        oncontextmenu: (e) => this.menu(e),
        ondragstart: (e) => e.dataTransfer.setData('text/x-gonds-tab', this.id),
        ondragover: (e) => { if (e.dataTransfer.types.includes('text/x-gonds-tab')) e.preventDefault() },
        ondrop: (e) => {
          const src = e.dataTransfer.getData('text/x-gonds-tab')
          if (src) reorder(src, this.id)
        }
      })
      this.numEl = U.el('span', { class: 'tnum' })
      this.titleEl = U.el('span', { class: 'tt', text: this.title })
      this.tabEl.append(
        this.numEl,
        this.titleEl,
        U.el('button', { class: 'tx', title: 'Close tab', onclick: (e) => { e.stopPropagation(); this.requestClose() } }, U.icon('i-close'))
      )

      tabsEl().append(this.tabEl)
      panesEl().append(this.pane)
      tabs.push(this)
      renumber()
    }

    setTitle (t) {
      if (!t) return
      this.title = t
      this.titleEl.textContent = t
      this.tabEl.title = t
      if (active === this) U.$('#title-text').textContent = `${t} — Gonds`
    }

    menu (e) {
      e.preventDefault()
      U.menu(e.clientX, e.clientY, [
        { label: 'Duplicate tab', icon: 'i-plus', kbd: '⇧⌘T', onClick: () => duplicate(this) },
        { label: this.pinned ? 'Unpin this tab' : 'Pin this tab', icon: 'i-pin', onClick: () => this.togglePin() },
        'sep',
        { label: 'Split right', icon: 'i-split', kbd: '⌘D', onClick: () => this.split('row') },
        { label: 'Split down', icon: 'i-split', kbd: '⇧⌘D', onClick: () => this.split('col') },
        this.sftp ? { label: 'Toggle SFTP panel', icon: 'i-folder-open', kbd: '⌘B', onClick: () => this.toggleSftp() } : null,
        'sep',
        this.spec.ephemeral ? { label: 'Save as session…', icon: 'i-session', onClick: () => this.saveAsSession() } : null,
        { label: 'Rename tab…', onClick: async () => { const n = await D.input({ title: 'Rename tab', label: 'Title', value: this.title }); if (n) this.setTitle(n) } },
        'sep',
        { label: 'Close tab', icon: 'i-close', kbd: '⌘W', danger: true, onClick: () => this.requestClose() },
        { label: 'Close other tabs', danger: true, onClick: () => closeOthers(this) }
      ])
    }

    togglePin () {
      this.pinned = !this.pinned
      this.tabEl.classList.toggle('pinned', this.pinned)
      persistLater()
    }

    async saveAsSession () {
      const node = { ...this.spec }
      delete node.ephemeral
      delete node.id
      const saved = await D.sessionEdit(node)
      if (saved) {
        this.spec = { ...saved }
        window.MX.reloadSessions()
        U.toast(`Saved session “${saved.name}”`, 'ok')
      }
    }

    // ----------------------------------------------------------- terminals --
    /** Build the initial layout: one terminal, plus the SFTP panel for SSH. */
    async boot () {
      const spec = this.spec
      this.rootCell = U.el('div', { class: 'cell' })
      this.layout = U.el('div', { class: 'split sp-row' }, this.rootCell)

      if (spec.type === 'ssh' && spec.openSftp !== false && window.MX.settings.ui.sftpAutoOpen) {
        this.sftp = new SftpPanel({
          mode: 'remote',
          allowToggle: true,
          connId: () => this.terms[0]?.connId,
          peer: () => null
        })
        this.sftp.el.style.width = `${window.MX.settings.ui.sftpPanelWidth}px`
        this.sftp.el.hidden = true
        this.pane.append(this.sftp.el)
      }
      this.pane.append(this.layout)

      if (spec.type === 'sftp') return this.bootSftpTab()

      const term = await this.addTerm(this.rootCell, spec)
      if (!term) return false

      if (this.sftp) {
        this.sftp.el.hidden = false
        this.sftp.goHome().catch(() => {})
      }
      return true
    }

    /** SFTP-only tab: dual pane, local left, remote right. */
    async bootSftpTab () {
      U.clear(this.pane)
      const term = new Term({ ...this.spec, type: 'sftp' }, {})
      // No shell channel — just the connection. Reuse Term for the connect flow.
      this.terms = [term]
      try {
        await term.start()
      } catch (e) {
        U.err(e)
        this.pane.append(U.el('div', { class: 'sb-empty' }, U.el('span', { class: 'err', text: e.message })))
        return false
      }
      const local = new SftpPanel({ mode: 'local', resizable: true, peer: () => remote })
      const remote = new SftpPanel({ mode: 'remote', connId: () => term.connId, allowToggle: false, resizable: false, peer: () => local })
      local.el.style.width = '46%'
      remote.el.style.borderRight = '0'
      remote.el.style.flex = '1 1 auto'
      remote.el.style.width = 'auto'
      remote.el.style.maxWidth = 'none'
      this.pane.append(local.el, remote.el)
      this.sftpPair = [local, remote]
      local.goHome().catch(U.err)
      remote.goHome().catch(U.err)
      this.setTitle(`${this.spec.name} (SFTP)`)
      return true
    }

    async addTerm (cell, spec) {
      const term = new Term(spec, {
        onTitle: (t) => { if (this.terms.length === 1) this.setTitle(`${this.spec.name} — ${t}`) },
        onCwd: (cwd) => this.sftp?.followCwd(cwd),
        onExit: () => {
          this.tabEl.classList.add('dead')
          window.MX.refreshStatus()
        },
        onConn: () => window.MX.refreshStatus(),
        onRequestClose: () => this.requestClose()
      })
      cell.append(term.el)
      this.terms.push(term)
      try {
        await term.start()
      } catch (e) {
        U.err(e)
        term.showDead(e.message)
        return null
      }
      term.focus()
      window.MX.refreshStatus()
      return term
    }

    /** Split the focused terminal's cell in `dir` ('row' | 'col'). */
    async split (dir) {
      const focused = window.MX.focusedTerm && this.terms.includes(window.MX.focusedTerm)
        ? window.MX.focusedTerm
        : this.terms[this.terms.length - 1]
      if (!focused) return
      const cell = focused.el.parentElement
      if (!cell || !cell.classList.contains('cell')) return

      const a = U.el('div', { class: 'cell' })
      const b = U.el('div', { class: 'cell' })
      const gutter = U.el('div', { class: 'gutter' })
      const split = U.el('div', { class: `split sp-${dir}` }, a, gutter, b)

      cell.replaceChildren(split)
      a.append(focused.el)

      let baseA = 0
      gutter.addEventListener('mousedown', () => { baseA = dir === 'row' ? a.offsetWidth : a.offsetHeight })
      U.drag(gutter, (delta) => {
        const total = dir === 'row' ? split.offsetWidth : split.offsetHeight
        const next = Math.max(80, Math.min(total - 80, baseA + delta))
        a.style.flex = `0 0 ${next}px`
        b.style.flex = '1 1 0'
        this.terms.forEach((t) => t.refit())
      }, dir === 'row' ? 'x' : 'y')

      await this.addTerm(b, { ...this.spec, name: this.spec.name })
      this.terms.forEach((t) => t.refit())
    }

    toggleSftp () {
      if (!this.sftp) {
        if (!this.terms[0]?.connId) return U.toast('SFTP needs an SSH session', 'warn')
        this.sftp = new SftpPanel({ mode: 'remote', allowToggle: true, connId: () => this.terms[0]?.connId })
        this.sftp.el.style.width = `${window.MX.settings.ui.sftpPanelWidth}px`
        this.pane.prepend(this.sftp.el)
        this.sftp.goHome().catch(U.err)
      } else {
        this.sftp.el.hidden = !this.sftp.el.hidden
      }
      this.terms.forEach((t) => t.refit())
    }

    show () {
      this.pane.hidden = false
      this.tabEl.classList.add('active')
      U.$('#title-text').textContent = `${this.title} — Gonds`
      requestAnimationFrame(() => {
        this.terms.forEach((t) => t.refit())
        ;(window.MX.focusedTerm && this.terms.includes(window.MX.focusedTerm) ? window.MX.focusedTerm : this.terms[0])?.focus()
      })
    }

    hide () {
      this.pane.hidden = true
      this.tabEl.classList.remove('active')
    }

    async requestClose () {
      const live = this.terms.filter((t) => t.alive).length
      if (live && window.MX.settings.ui.confirmCloseTab) {
        const running = window.Transfers.active().length
        const ok = await D.confirm({
          title: 'Close session',
          message: `Close “${this.title}”?`,
          detail: running ? `${running} transfer(s) still running — they will be aborted.` : undefined,
          okLabel: 'Close',
          danger: true
        })
        if (!ok) return
      }
      this.close()
    }

    close () {
      for (const t of this.terms) t.dispose().catch(() => {})
      this.sftp?.dispose()
      this.sftpPair?.forEach((p) => p.dispose())
      this.tabEl.remove()
      this.pane.remove()
      const i = tabs.indexOf(this)
      if (i >= 0) tabs.splice(i, 1)
      if (active === this) {
        active = null
        const next = tabs[Math.min(i, tabs.length - 1)]
        if (next) activate(next)
        else { U.$('#title-text').textContent = 'Gonds'; openHome() }
      }
      renumber()
      persistLater()
      window.MX.refreshStatus()
    }
  }

  // ------------------------------------------------------------ home pane --
  class HomeTab {
    constructor () {
      this.id = `tab${++seq}`
      this.spec = { type: 'home', name: 'Home' }
      this.title = 'Home'
      this.terms = []
      this.pinned = false
      this.isHome = true

      this.pane = U.el('div', { class: 'pane', hidden: true })
      this.tabEl = U.el('div', { class: 'tab', dataset: { id: this.id }, onclick: () => activate(this) })
      this.numEl = U.el('span', { class: 'tnum' })
      this.titleEl = U.el('span', { class: 'tt', text: 'Home' })
      this.tabEl.append(this.numEl, this.titleEl,
        U.el('button', { class: 'tx', onclick: (e) => { e.stopPropagation(); this.close() } }, U.icon('i-close')))
      tabsEl().append(this.tabEl)
      panesEl().append(this.pane)
      tabs.push(this)
      renumber()
      this.render()
    }

    render () {
      // Ordered by what you actually do: connect, pick an existing session,
      // and only then create a new kind of one. A grid of protocol tiles up
      // front is a showroom, not a workflow.
      const connect = U.el('input', {
        type: 'text',
        class: 'hc-input',
        placeholder: 'user@host  or  host:port',
        spellcheck: 'false',
        onkeydown: (e) => {
          if (e.key !== 'Enter') return
          const spec = window.D.parseTarget(connect.value, 'ssh')
          if (!spec) return U.toast('Expected user@host:port', 'warn')
          connect.value = ''
          window.MX.launchAdhoc(spec)
        }
      })

      const chip = (type, label) => U.el('button', {
        class: 'chip',
        title: `New ${label} session`,
        onclick: () => window.MX.newSessionOfType(type)
      }, U.icon(U.typeIcon(type)), U.el('span', { text: label }))

      const body = U.el('div', { class: 'home' },
        U.el('div', { class: 'hc' },
          U.el('div', { class: 'hc-row' },
            U.icon('i-server', 'hc-icon'),
            connect,
            U.el('button', {
              class: 'btn primary',
              text: 'Connect',
              onclick: () => {
                const spec = window.D.parseTarget(connect.value, 'ssh')
                if (!spec) return U.toast('Expected user@host:port', 'warn')
                connect.value = ''
                window.MX.launchAdhoc(spec)
              }
            })
          ),
          U.el('div', { class: 'hc-hint' },
            'SSH. Press ⏎ to connect without saving — ',
            U.el('button', { class: 'linky', text: 'open a local shell', onclick: () => window.MX.openShell() }),
            ' instead, or use ⌘K for other protocols.')
        ),

        this.recentBlock(),

        U.el('h2', { text: 'New session' }),
        U.el('div', { class: 'chips' },
          chip('ssh', 'SSH'),
          chip('sftp', 'SFTP'),
          chip('shell', 'Shell'),
          chip('telnet', 'Telnet'),
          chip('serial', 'Serial'),
          chip('mosh', 'Mosh'),
          chip('rdp', 'RDP'),
          chip('vnc', 'VNC')
        )
      )
      U.clear(this.pane)
      this.pane.append(body)
    }


    recentBlock () {
      const host = U.el('div', { class: 'recent' })
      const sessions = window.MX.flatSessions().slice(0, 12)
      const wrap = U.el('div', {},
        U.el('h2', { text: sessions.length ? 'Your sessions' : 'No sessions yet' }), host)
      if (!sessions.length) {
        host.append(U.el('div', { class: 'hint' },
          'Save one with the + below, or import from ',
          U.el('button', { class: 'linky', text: '~/.ssh/config', onclick: () => window.Sidebar.importSshConfig() }),
          '.'))
        return wrap
      }
      for (const s of sessions) {
        host.append(U.el('div', { class: 'recent-row', ondblclick: () => window.MX.launch(s), onclick: () => window.MX.launch(s) },
          U.icon(U.typeIcon(s.type)),
          U.el('span', { text: s.name }),
          U.el('span', { class: 'rh', text: s.host ? `${s.username ? s.username + '@' : ''}${s.host}${s.port && s.port !== 22 ? ':' + s.port : ''}` : U.TYPE_LABEL[s.type] })
        ))
      }
      return wrap
    }

    show () { this.pane.hidden = false; this.tabEl.classList.add('active'); U.$('#title-text').textContent = 'Gonds'; this.render() }
    hide () { this.pane.hidden = true; this.tabEl.classList.remove('active') }
    requestClose () { this.close() }
    close () {
      this.tabEl.remove(); this.pane.remove()
      const i = tabs.indexOf(this)
      if (i >= 0) tabs.splice(i, 1)
      if (active === this) {
        active = null
        const next = tabs[Math.min(i, tabs.length - 1)]
        if (next) activate(next)
      }
      renumber()
    }
  }

  // --------------------------------------------------------------- module --
  function renumber () {
    tabs.forEach((t, i) => { t.numEl.textContent = String(i + 1) })
  }

  // ------------------------------------------------------------ persistence --

  // Never written to disk: anything secret, and anything only valid for a live
  // connection. Saved passwords stay in the Keychain, keyed by session id.
  const TRANSIENT = ['password', 'passphrase', 'cols', 'rows', 'sessionId', '_pendingPassword']

  /** The open tabs, in order, as plain data for settings.json. */
  function serialise () {
    return {
      tabs: tabs.map((t) => {
        if (t.isHome) return { kind: 'home' }
        const spec = { ...t.spec }
        for (const k of TRANSIENT) delete spec[k]
        return { kind: 'session', spec, pinned: t.pinned }
      }),
      activeIndex: Math.max(0, tabs.indexOf(active))
    }
  }

  let saveTimer = null
  function persistLater () {
    if (!window.MX?.settings?.ui?.restoreTabs) return
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      window.mx.settings.setOpenTabs(serialise()).catch(() => {})
    }, 500)
  }

  /**
   * Reopen last session's tabs. Sequential on purpose: a parallel restore of
   * five SSH sessions would stack five password dialogs on top of each other.
   */
  async function restore (saved) {
    if (!saved || !Array.isArray(saved.tabs) || !saved.tabs.length) return false
    let opened = 0
    for (const entry of saved.tabs) {
      try {
        if (entry.kind === 'home') { openHome(); opened++; continue }
        if (!entry.spec) continue
        const tab = await openSession(entry.spec)
        if (entry.pinned) tab.togglePin()
        opened++
      } catch (err) {
        U.toast(`Could not reopen “${entry.spec?.name || 'tab'}”: ${err.message}`, 'warn', 7000)
      }
    }
    const target = tabs[saved.activeIndex]
    if (target) activate(target)
    return opened > 0
  }

  function activate (tab) {
    if (active === tab) { tab.show(); return }
    active?.hide()
    active = tab
    tab.show()
    window.MX.refreshStatus()
    persistLater()
  }

  function reorder (srcId, destId) {
    const a = tabs.findIndex((t) => t.id === srcId)
    const b = tabs.findIndex((t) => t.id === destId)
    if (a < 0 || b < 0 || a === b) return
    const [moved] = tabs.splice(a, 1)
    tabs.splice(b, 0, moved)
    const host = tabsEl()
    tabs.forEach((t) => host.append(t.tabEl))
    renumber()
    persistLater()
  }

  async function openSession (spec) {
    const tab = new Tab(spec)
    activate(tab)
    persistLater()
    const ok = await tab.boot()
    if (!ok && !tab.terms.some((t) => t.alive)) {
      // keep the tab so the user can read the error and hit Reconnect
    }
    return tab
  }

  function openHome () {
    const existing = tabs.find((t) => t.isHome)
    if (existing) { activate(existing); return existing }
    const h = new HomeTab()
    activate(h)
    return h
  }

  function duplicate (tab) {
    if (tab.isHome) return openHome()
    return openSession({ ...tab.spec })
  }

  function closeOthers (keep) {
    for (const t of [...tabs]) if (t !== keep && !t.pinned) t.close()
  }

  function cycle (delta) {
    if (!tabs.length) return
    const i = tabs.indexOf(active)
    activate(tabs[(i + delta + tabs.length) % tabs.length])
  }

  function byIndex (n) {
    if (tabs[n - 1]) activate(tabs[n - 1])
  }

  return {
    Tab, HomeTab, openSession, openHome, duplicate, closeOthers, cycle, byIndex,
    activate, serialise, restore, persistLater,
    list: () => tabs, get active () { return active }
  }
})()

window.Tabs = Tabs
