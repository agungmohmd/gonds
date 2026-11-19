'use strict'
/* global window, document, U, D, Tabs, Sidebar, ToolsUI, TermReg */

const MX = (() => {
  const state = {
    settings: null,
    schemes: {},
    version: '',
    focusedTerm: null,
    sysinfo: null
  }

  // ------------------------------------------------------------- settings --
  async function reloadSettings () {
    const res = await window.mx.settings.get()
    state.settings = res.settings
    state.schemes = res.schemes
    state.version = res.version
    return state.settings
  }

  function themeFor (schemeName) {
    const s = state.schemes[schemeName] || state.schemes[state.settings.terminal.scheme] || {}
    return {
      foreground: s.ForegroundColour,
      background: s.BackgroundColour,
      cursor: s.CursorColour,
      cursorAccent: s.BackgroundColour,
      selectionBackground: '#4f6d9a80',
      black: s.Black, red: s.Red, green: s.Green, yellow: s.Yellow,
      blue: s.Blue, magenta: s.Magenta, cyan: s.Cyan, white: s.White,
      brightBlack: s.BoldBlack, brightRed: s.BoldRed, brightGreen: s.BoldGreen,
      brightYellow: s.BoldYellow, brightBlue: s.BoldBlue, brightMagenta: s.BoldMagenta,
      brightCyan: s.BoldCyan, brightWhite: s.BoldWhite
    }
  }

  function applyAppearance () {
    const { ui, terminal } = state.settings
    document.documentElement.dataset.theme = ui.theme === 'light' ? 'light' : 'dark'
    document.body.classList.toggle('sidebar-hidden', !ui.sidebarVisible)
    document.body.classList.toggle('no-status', !ui.showStatusBar)
    U.$('#sidebar').style.width = `${ui.sidebarWidth}px`
    const bg = (state.schemes[terminal.scheme] || {}).BackgroundColour
    if (bg) document.documentElement.style.setProperty('--term-bg', bg)
    for (const t of TermReg.all()) {
      t.setTheme(t.spec.scheme || terminal.scheme)
      t.xterm.options.fontFamily = terminal.fontFamily
      t.xterm.options.fontSize = t.spec.fontSize || terminal.fontSize
      t.xterm.options.lineHeight = terminal.lineHeight
      t.xterm.options.cursorStyle = terminal.cursorStyle
      t.xterm.options.cursorBlink = terminal.cursorBlink
      t.xterm.options.scrollback = terminal.scrollback
      t.refit()
    }
    U.$('#status-scheme').textContent = terminal.scheme
  }

  // --------------------------------------------------------------- launch --
  /** Launch a saved session node (or ad-hoc spec). */
  async function launch (node, forceNew) {
    const spec = { ...node }

    // Delegated protocols never create a tab.
    if (spec.type === 'rdp') return delegate(() => window.mx.open.rdp(spec), 'RDP')
    if (spec.type === 'vnc') return delegate(() => window.mx.open.vnc(spec), 'VNC')
    if (spec.type === 'ftp') return delegate(() => window.mx.open.ftp(spec), 'FTP')
    if (spec.type === 'browser') return delegate(() => window.mx.open.browser(spec), 'Browser')
    if (spec.type === 'x11') return ToolsUI.x11()

    if (!forceNew) {
      const existing = Tabs.list().find((t) => t.spec?.id && t.spec.id === spec.id && t.terms.some((x) => x.alive))
      if (existing) { Tabs.activate(existing); return existing }
    }
    const tab = await Tabs.openSession(spec)
    Sidebar.paint()
    return tab
  }

  async function delegate (fn, label) {
    try {
      const res = await fn()
      if (res.delegated) U.toast(`${label} handed to ${res.app || 'the system handler'}`, 'ok')
      else U.toast(res.hint || `${label} has no handler installed`, 'warn', 8000)
    } catch (e) { U.err(e) }
  }

  function launchAdhoc (spec) {
    return launch({ ...spec, ephemeral: true }, true)
  }

  async function newSessionOfType (type) {
    await Sidebar.newSession(null, { type, port: D.DEFAULT_PORT[type] })
  }

  function openShell () {
    return launchAdhoc({ type: 'shell', name: 'Local shell' })
  }

  async function quickConnect () {
    const spec = await D.quickConnect()
    if (spec) await launchAdhoc(spec)
  }

  // ------------------------------------------------------------ broadcast --
  const broadcast = {
    active: false,
    toggle () {
      this.active = !this.active
      // Default to every live terminal when switching on with nothing selected.
      if (this.active) {
        const members = TermReg.all().filter((t) => t.broadcast)
        if (!members.length) TermReg.all().forEach((t) => { t.broadcast = t.alive })
      }
      U.$('#status-broadcast').hidden = !this.active
      for (const b of U.$$('.rib[data-action="broadcast"]')) b.classList.toggle('on', this.active)
      const n = TermReg.all().filter((t) => t.broadcast && t.alive).length
      U.toast(this.active ? `Broadcast ON — typing goes to ${n} terminal(s)` : 'Broadcast OFF', this.active ? 'warn' : 'ok')
    },
    toggleTerm (term) {
      term.broadcast = !term.broadcast
      U.toast(`${term.spec.name || 'terminal'} ${term.broadcast ? 'included in' : 'excluded from'} Broadcast`, 'ok')
    },
    send (data, origin) {
      const targets = TermReg.all().filter((t) => t.broadcast && t.alive)
      if (!targets.length) return origin.send(data)
      for (const t of targets) t.send(data)
    }
  }

  // --------------------------------------------------------------- macros --
  async function runMacro (macro, toAll) {
    const lines = macro.lines || []
    if (!lines.length) return U.toast('Macro is empty', 'warn')
    const targets = toAll ? TermReg.all().filter((t) => t.alive) : [state.focusedTerm].filter(Boolean)
    if (!targets.length) return U.toast('No focused terminal', 'warn')
    for (const t of targets) {
      for (const line of lines) t.send(line + (macro.sendNewline !== false ? '\r' : ''))
    }
    U.toast(`Macro “${macro.name}” sent to ${targets.length} terminal(s)`, 'ok')
  }

  // --------------------------------------------------------------- status --
  function setFocusedTerm (term) {
    if (state.focusedTerm && state.focusedTerm !== term) state.focusedTerm.blur()
    state.focusedTerm = term
    refreshStatus()
  }

  function refreshStatus () {
    const tab = Tabs.active
    const term = state.focusedTerm
    U.$('#status-session').textContent = tab ? tab.title : 'No session'
    if (term && term.alive) {
      const st = term.stats()
      U.$('#status-conn').textContent = `${st.kind} · ${U.bytes(st.bytesIn)} in · up ${U.duration(st.uptime)}`
      U.$('#status-size').textContent = `${st.cols}×${st.rows}`
    } else {
      U.$('#status-conn').textContent = tab?.terms?.length ? 'disconnected' : '—'
    }
  }

  const setStatusSize = (txt) => { U.$('#status-size').textContent = txt }
  const setStatusTransfers = (txt) => { U.$('#status-transfers').textContent = txt }

  function openTunnels (term) { ToolsUI.tunnels(term || state.focusedTerm) }

  // ----------------------------------------------------------- menu wiring --
  const ACTIONS = {
    'new-session': () => newSessionOfType('ssh'),
    'quick-connect': quickConnect,
    'new-shell': openShell,
    'new-folder': () => Sidebar.newFolder(null),
    'duplicate-tab': () => Tabs.active && Tabs.duplicate(Tabs.active),
    'close-tab': () => Tabs.active?.requestClose(),
    'import-sessions': () => Sidebar.importSessions(),
    'export-sessions': async () => {
      const r = await window.mx.sessions.export()
      if (!r.cancelled) U.toast(`Exported to ${r.file}`, 'ok')
    },
    copy: async () => {
      const sel = state.focusedTerm?.xterm.getSelection()
      if (sel) { await window.mx.clipboard.write(sel); U.toast('Copied', 'ok', 1200) }
    },
    paste: () => state.focusedTerm?.paste(),
    'select-all': () => state.focusedTerm?.xterm.selectAll(),
    'find-in-terminal': () => state.focusedTerm?.toggleFind(),
    'clear-terminal': () => state.focusedTerm?.clear(),
    'toggle-sidebar': async () => {
      const v = !state.settings.ui.sidebarVisible
      await window.mx.settings.patch({ ui: { sidebarVisible: v } })
      await reloadSettings()
      applyAppearance()
      Tabs.active?.terms?.forEach((t) => t.refit())
    },
    'toggle-sftp': () => Tabs.active?.toggleSftp?.(),
    'split-right': () => Tabs.active?.split?.('row'),
    'split-down': () => Tabs.active?.split?.('col'),
    'zoom-in': () => zoom(1),
    'zoom-out': () => zoom(-1),
    'zoom-reset': () => zoom(0),
    'next-tab': () => Tabs.cycle(1),
    'prev-tab': () => Tabs.cycle(-1),
    broadcast: () => broadcast.toggle(),
    'tools-menu': (ev) => {
      const r = ev?.target?.closest?.('button')?.getBoundingClientRect?.()
      U.menu(r ? r.left : 200, r ? r.bottom + 2 : 120, [
        { label: 'Network scanner…', icon: 'i-search', onClick: ToolsUI.netscan },
        { label: 'Network connections…', icon: 'i-tunnel', onClick: ToolsUI.netstat },
        { label: 'Listening ports…', icon: 'i-server', onClick: ToolsUI.ports },
        'sep',
        { label: 'SSH key generator…', icon: 'i-key', onClick: ToolsUI.keygen },
        { label: 'Known host keys…', icon: 'i-key', onClick: ToolsUI.knownHosts },
        { label: 'Saved passwords…', icon: 'i-key', onClick: ToolsUI.passwords },
        'sep',
        { label: 'System information…', icon: 'i-tools', onClick: ToolsUI.sysinfo },
        { label: 'Process list…', icon: 'i-broadcast', onClick: ToolsUI.processes },
        { label: 'X11 server…', icon: 'i-server', onClick: ToolsUI.x11 }
      ])
    },
    macros: () => ToolsUI.macros(),
    tunnels: () => openTunnels(),
    packages: () => ToolsUI.packages(),
    keygen: () => ToolsUI.keygen(),
    netscan: () => ToolsUI.netscan(),
    netstat: () => ToolsUI.netstat(),
    ports: () => ToolsUI.ports(),
    processes: () => ToolsUI.processes(),
    sysinfo: () => ToolsUI.sysinfo(),
    passwords: () => ToolsUI.passwords(),
    'known-hosts': () => ToolsUI.knownHosts(),
    x11: () => ToolsUI.x11(),
    settings: () => ToolsUI.settings(),
    hotkeys: () => ToolsUI.hotkeys(),
    about: () => ToolsUI.about()
  }

  async function zoom (dir) {
    const t = state.focusedTerm
    const base = state.settings.terminal.fontSize
    if (dir === 0) {
      t ? t.setFontSize(base) : null
      return
    }
    const next = Math.max(7, Math.min(36, (t?.xterm.options.fontSize || base) + dir))
    if (t) t.setFontSize(next)
    else {
      await window.mx.settings.patch({ terminal: { fontSize: next } })
      await reloadSettings()
      applyAppearance()
    }
  }

  function run (id, ev) {
    const fn = ACTIONS[id]
    if (!fn) return U.toast(`No action: ${id}`, 'warn')
    try { fn(ev) } catch (e) { U.err(e) }
  }

  // ----------------------------------------------------------- init / boot --
  async function init () {
    await reloadSettings()
    applyAppearance()
    U.$('#status-scheme').textContent = state.settings.terminal.scheme

    // Main-process prompts (SSH auth, host keys).
    window.mx.on('prompt:request', async ({ id, kind, payload }) => {
      let value = null
      try {
        if (kind === 'password') value = await D.askPassword(payload)
        else if (kind === 'passphrase') value = await D.askPassphrase(payload)
        else if (kind === 'keyboard-interactive') value = await D.askKeyboardInteractive(payload)
        else if (kind === 'host-key') value = await D.askHostKey(payload)
        else if (kind === 'overwrite') value = await D.askOverwrite(payload)
      } catch (e) {
        U.err(e)
        // A crashed dialog must not be read as consent. Refusing is the safe
        // reading for every prompt kind we have.
        if (kind === 'overwrite') value = { action: 'cancel', applyToAll: false }
      }
      window.mx.reply(id, value)
    })

    window.mx.on('ssh:banner', ({ message }) => {
      if (message && message.trim()) U.toast(message.trim().slice(0, 300), 'info', 9000)
    })
    window.mx.on('ssh:error', ({ message }) => U.toast(message, 'err', 8000))
    window.mx.on('tunnel:error', ({ message }) => U.toast(`Tunnel: ${message}`, 'err', 8000))
    window.mx.on('toast', ({ level, message }) => U.toast(message, level || 'info'))
    window.mx.on('menu:action', ({ id }) => run(id))

    // Ribbon + sidebar buttons.
    for (const btn of U.$$('[data-action]')) {
      btn.addEventListener('click', (ev) => run(btn.dataset.action, ev))
    }
    U.$('#tab-add').addEventListener('click', (ev) => {
      const r = ev.target.closest('button').getBoundingClientRect()
      U.menu(r.left - 150, r.bottom + 2, [
        { label: 'Local shell', icon: 'i-session', kbd: '⌘T', onClick: openShell },
        { label: 'Quick connect…', icon: 'i-server', kbd: '⌘K', onClick: quickConnect },
        { label: 'New session…', icon: 'i-plus', kbd: '⇧⌘N', onClick: () => newSessionOfType('ssh') },
        'sep',
        { label: 'Home', icon: 'i-help', onClick: () => Tabs.openHome() }
      ])
    })

    // ⌘1…⌘9 select tabs; Electron accelerators cover the rest.
    document.addEventListener('keydown', (e) => {
      if (e.metaKey && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault()
        Tabs.byIndex(Number(e.key))
      }
    })

    Sidebar.init()
    await Sidebar.reload()
    Sidebar.switchPane('sessions')

    // Reopen last session's tabs; fall back to Home if there is nothing to
    // restore, or if the user turned restoring off.
    const restored = state.settings.ui.restoreTabs &&
      await Tabs.restore(state.settings.ui.openTabs).catch((e) => { U.err(e); return false })
    if (!restored) Tabs.openHome()

    // Keep the status bar honest about throughput/uptime.
    setInterval(refreshStatus, 2000)

    window.mx.tools.sysinfo().then((i) => { state.sysinfo = i }).catch(() => {})
  }

  return {
    init, run, launch, launchAdhoc, newSessionOfType, openShell, quickConnect,
    broadcast, runMacro, openTunnels, themeFor, applyAppearance, reloadSettings,
    reloadSessions: () => Sidebar.reload(),
    flatSessions: () => Sidebar.flatSessions(),
    setFocusedTerm, refreshStatus, setStatusSize, setStatusTransfers,
    get settings () { return state.settings },
    get schemes () { return state.schemes },
    get version () { return state.version },
    get focusedTerm () { return state.focusedTerm },
    get sysinfo () { return state.sysinfo },
    set sysinfo (v) { state.sysinfo = v }
  }
})()

window.MX = MX

window.addEventListener('DOMContentLoaded', () => {
  MX.init().catch((e) => {
    document.body.append(U.el('div', {
      style: 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#1e1e1e;color:#e05561;font:13px var(--mono);padding:40px;text-align:center;white-space:pre-wrap',
      text: `Gonds failed to start:\n\n${e.stack || e.message}`
    }))
  })
})
