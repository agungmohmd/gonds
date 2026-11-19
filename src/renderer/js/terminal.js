'use strict'
/* global window, document, U, D, Terminal, FitAddon, SearchAddon, WebLinksAddon, Unicode11Addon, ResizeObserver */

const TermReg = (() => {
  const byId = new Map()

  // Single dispatcher for all terminal byte streams.
  window.mx.on('term:data', ({ id, data }) => byId.get(id)?._onData(data))
  window.mx.on('term:exit', ({ id, exitCode, signal }) => byId.get(id)?._onExit(exitCode, signal))

  return {
    add: (t) => byId.set(t.termId, t),
    remove: (id) => byId.delete(id),
    get: (id) => byId.get(id),
    all: () => [...byId.values()]
  }
})()

class Term {
  /**
   * @param {object} spec session spec (type, host, …)
   * @param {object} hooks { onTitle, onExit, onCwd, onFocus, onConn }
   */
  constructor (spec, hooks = {}) {
    this.spec = spec
    this.hooks = hooks
    this.termId = null
    this.connId = null
    this.alive = false
    this.cwd = null
    this.bytesIn = 0
    this.startedAt = null
    this.broadcast = false

    this.el = U.el('div', { class: 'termwrap' })
    this.host = U.el('div', { class: 'termhost' })
    this.el.append(this.host)

    this.el.addEventListener('mousedown', () => this.focus(), true)
    this._buildTerminal()
  }

  _buildTerminal () {
    const g = window.MX.settings
    const spec = this.spec
    const scheme = spec.scheme || g.terminal.scheme

    this.xterm = new Terminal({
      fontFamily: g.terminal.fontFamily,
      fontSize: spec.fontSize || g.terminal.fontSize,
      lineHeight: g.terminal.lineHeight,
      letterSpacing: g.terminal.letterSpacing,
      cursorStyle: g.terminal.cursorStyle,
      cursorBlink: g.terminal.cursorBlink,
      scrollback: g.terminal.scrollback,
      wordSeparator: g.terminal.wordSeparators,
      allowProposedApi: true,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: false,
      theme: window.MX.themeFor(scheme),
      windowsMode: false
    })

    this.fit = new FitAddon.FitAddon()
    this.search = new SearchAddon.SearchAddon()
    this.xterm.loadAddon(this.fit)
    this.xterm.loadAddon(this.search)
    this.xterm.loadAddon(new WebLinksAddon.WebLinksAddon((event, uri) => {
      event.preventDefault()
      window.mx.open.external(uri).catch(U.err)
    }))
    try {
      const u11 = new Unicode11Addon.Unicode11Addon()
      this.xterm.loadAddon(u11)
      this.xterm.unicode.activeVersion = '11'
    } catch { /* optional */ }

    this.xterm.open(this.host)

    this.xterm.onData((data) => {
      if (this.broadcast && window.MX.broadcast.active) {
        window.MX.broadcast.send(data, this)
        return
      }
      this.send(data)
    })

    this.xterm.onBinary((data) => {
      const bytes = new Uint8Array(data.length)
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 255
      this._sendBytes(bytes)
    })

    this.xterm.onTitleChange((title) => this.hooks.onTitle?.(title))

    this.xterm.onSelectionChange(() => {
      if (!window.MX.settings.terminal.copyOnSelect) return
      const sel = this.xterm.getSelection()
      if (sel) window.mx.clipboard.write(sel).catch(() => {})
    })

    this.xterm.onResize(({ cols, rows }) => {
      if (this.termId) window.mx.term.resize(this.termId, cols, rows).catch(() => {})
      window.MX.setStatusSize(`${cols}×${rows}`)
    })

    // OSC 7 carries the shell's cwd — this is what drives "SFTP follows terminal".
    this.xterm.parser.registerOscHandler(7, (payload) => {
      try {
        const u = new URL(payload)
        if (u.protocol === 'file:') {
          this.cwd = decodeURIComponent(u.pathname)
          this.hooks.onCwd?.(this.cwd)
        }
      } catch { /* malformed OSC 7 is not worth a message */ }
      return true
    })

    this._bindKeys()
    this._bindContextMenu()

    this.ro = new ResizeObserver(U.debounce(() => this.refit(), 40))
    this.ro.observe(this.host)
  }

  _bindKeys () {
    // Keys the UI owns before the terminal sees them.
    this.xterm.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const meta = e.metaKey && !e.ctrlKey && !e.altKey
      if (meta && e.key === 'c') {
        const sel = this.xterm.getSelection()
        if (sel) { window.mx.clipboard.write(sel); return false }
        return false // ⌘C with no selection must not reach the shell
      }
      if (meta && e.key === 'v') { this.paste(); return false }
      if (meta && e.key === 'f') { this.toggleFind(); return false }
      if (meta && e.key === 'a') { this.xterm.selectAll(); return false }
      if (meta && e.key === 'k') return true // handled globally
      if (meta && e.key === 'l') { this.clear(); return false }
      return true
    })
  }

  _bindContextMenu () {
    this.host.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      const sel = this.xterm.getSelection()
      const mode = window.MX.settings.terminal.rightClick
      if (mode === 'paste' && !e.shiftKey) { this.paste(); return }
      U.menu(e.clientX, e.clientY, [
        { label: 'Copy', icon: 'i-file', disabled: !sel, kbd: '⌘C', onClick: () => window.mx.clipboard.write(sel) },
        { label: 'Paste', icon: 'i-file', kbd: '⌘V', onClick: () => this.paste() },
        { label: 'Select all', onClick: () => this.xterm.selectAll() },
        'sep',
        { label: 'Find…', icon: 'i-search', kbd: '⌘F', onClick: () => this.toggleFind() },
        { label: 'Clear buffer', kbd: '⌘L', onClick: () => this.clear() },
        'sep',
        { label: 'Save output to file…', icon: 'i-download', onClick: () => this.saveBuffer() },
        { label: 'Copy all output', onClick: () => this.copyBuffer() },
        this.connId ? { label: 'Tunnels for this session…', icon: 'i-tunnel', onClick: () => window.MX.openTunnels(this) } : null,
        'sep',
        { label: this.broadcast ? 'Exclude from Broadcast' : 'Include in Broadcast', icon: 'i-broadcast', onClick: () => window.MX.broadcast.toggleTerm(this) },
        { label: 'Reconnect', icon: 'i-refresh', onClick: () => this.reconnect() }
      ])
    })
  }

  // ------------------------------------------------------------- lifecycle --
  async start () {
    this.refit(true)
    const { cols, rows } = this.xterm
    const spec = { ...this.spec, cols, rows, sessionId: this.spec.id }
    const res = await window.mx.term.open(spec)
    this.termId = res.id
    this.connId = res.connId || null
    this.kind = res.kind
    this.alive = true
    this.startedAt = Date.now()
    TermReg.add(this)
    if (res.degraded) this.banner(res.degraded)
    this.hooks.onConn?.(this.connId)
    setTimeout(() => this.refit(), 60)
    return res
  }

  async reconnect () {
    if (this.alive) {
      const ok = await D.confirm({ title: 'Reconnect', message: 'Close the current connection and reconnect?', okLabel: 'Reconnect' })
      if (!ok) return
      await this.dispose(false)
    }
    this.clearDeadOverlay()
    this.xterm.write('\r\n\x1b[2m— reconnecting —\x1b[0m\r\n')
    try {
      await this.start()
    } catch (e) {
      this.showDead(e.message)
      U.err(e)
    }
  }

  _onData (b64) {
    const bytes = U.b64ToBytes(b64)
    this.bytesIn += bytes.length
    this.xterm.write(bytes)
  }

  _onExit (code, signal) {
    this.alive = false
    TermReg.remove(this.termId)
    this.showDead(signal ? `terminated by signal ${signal}` : `exited with code ${code}`)
    this.hooks.onExit?.(code, signal)
  }

  send (text) {
    if (!this.termId || !this.alive) return
    window.mx.term.write(this.termId, U.strToB64(text)).catch(() => {})
  }

  _sendBytes (bytes) {
    if (!this.termId || !this.alive) return
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    }
    window.mx.term.write(this.termId, btoa(bin)).catch(() => {})
  }

  async paste () {
    const text = await window.mx.clipboard.read()
    if (!text) return
    const g = window.MX.settings.terminal
    if (g.pasteConfirmNewlines && /\n/.test(text.trim())) {
      const lines = text.trim().split('\n').length
      const ok = await D.confirm({
        title: 'Paste multiple lines',
        message: `Paste ${lines} lines into this terminal?`,
        detail: text.length > 400 ? text.slice(0, 400) + '…' : text,
        okLabel: 'Paste'
      })
      if (!ok) return
    }
    if (this.broadcast && window.MX.broadcast.active) return window.MX.broadcast.send(text, this)
    this.send(text)
  }

  clear () { this.xterm.clear() }

  /** Whole scrollback as plain text, trailing blank lines trimmed. */
  bufferText () {
    const lines = []
    const buf = this.xterm.buffer.active
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
    return lines.join('\n') + '\n'
  }

  /** Write the scrollback to a file the user picks. */
  async saveBuffer () {
    const text = this.bufferText()
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const base = (this.spec.name || 'terminal').replace(/[^\w.-]+/g, '_')
    try {
      const res = await window.mx.term.saveOutput(`${base}-${stamp}.txt`, text)
      if (res.cancelled) return
      U.toast(`Saved ${U.bytes(res.bytes)} to ${res.file}`, 'ok', 6000)
    } catch (e) { U.err(e) }
  }

  async copyBuffer () {
    await window.mx.clipboard.write(this.bufferText())
    U.toast('Terminal output copied to clipboard', 'ok')
  }

  refit (silent) {
    if (!this.host.clientWidth || !this.host.clientHeight) return
    try { this.fit.fit() } catch { /* pre-layout */ }
    if (!silent && this.termId) {
      window.mx.term.resize(this.termId, this.xterm.cols, this.xterm.rows).catch(() => {})
    }
  }

  focus () {
    window.MX.setFocusedTerm(this)
    this.xterm.focus()
    this.el.classList.add('focused')
  }

  blur () { this.el.classList.remove('focused') }

  setTheme (schemeName) {
    this.xterm.options.theme = window.MX.themeFor(schemeName)
  }

  setFontSize (px) {
    this.xterm.options.fontSize = px
    this.refit()
  }

  // ------------------------------------------------------------- find bar --
  toggleFind () {
    if (this.findbar) { this.closeFind(); return }
    const inp = U.el('input', { type: 'text', placeholder: 'Find…', spellcheck: 'false' })
    const cnt = U.el('span', { class: 'cnt', text: '' })
    const opts = { decorations: { activeMatchColorOverviewRuler: '#e0a030', matchOverviewRuler: '#3b82c4' } }

    this.search.onDidChangeResults?.(({ resultIndex, resultCount }) => {
      cnt.textContent = resultCount ? `${resultIndex + 1}/${resultCount}` : 'no match'
    })

    const next = () => this.search.findNext(inp.value, opts)
    const prev = () => this.search.findPrevious(inp.value, opts)

    inp.addEventListener('input', U.debounce(() => { if (inp.value) next(); else cnt.textContent = '' }, 150))
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? prev() : next() }
      if (e.key === 'Escape') { e.preventDefault(); this.closeFind() }
    })

    this.findbar = U.el('div', { class: 'findbar' },
      inp, cnt,
      U.el('button', { class: 'btn sm', text: '↑', onclick: prev }),
      U.el('button', { class: 'btn sm', text: '↓', onclick: next }),
      U.el('button', { class: 'btn sm', text: '✕', onclick: () => this.closeFind() })
    )
    this.el.append(this.findbar)
    inp.focus()
  }

  closeFind () {
    this.search.clearDecorations?.()
    this.findbar?.remove()
    this.findbar = null
    this.xterm.focus()
  }

  // --------------------------------------------------------------- banners --
  banner (text) {
    const b = U.el('div', { class: 'term-banner' },
      U.el('span', { text }),
      U.el('button', { text: 'dismiss', onclick: () => { b.remove(); this.refit() } })
    )
    this.el.prepend(b)
    this.refit()
  }

  showDead (reason) {
    this.clearDeadOverlay()
    this.deadEl = U.el('div', { class: 'term-dead' },
      U.el('div', { text: `Session closed — ${reason}` }),
      U.el('div', { class: 'row' },
        U.el('button', { class: 'btn primary', text: 'Reconnect', onclick: () => this.reconnect() }),
        U.el('button', { class: 'btn', text: 'Close tab', onclick: () => this.hooks.onRequestClose?.() })
      )
    )
    this.el.append(this.deadEl)
  }

  clearDeadOverlay () {
    this.deadEl?.remove()
    this.deadEl = null
  }

  async dispose (closeRemote = true) {
    this.ro?.disconnect()
    this.closeFind()
    if (this.termId) {
      TermReg.remove(this.termId)
      if (closeRemote) await window.mx.term.close(this.termId).catch(() => {})
    }
    this.alive = false
    if (closeRemote) {
      this.xterm.dispose()
      this.el.remove()
    }
  }

  stats () {
    return {
      kind: this.kind,
      alive: this.alive,
      bytesIn: this.bytesIn,
      uptime: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      cols: this.xterm.cols,
      rows: this.xterm.rows
    }
  }
}

window.Term = Term
window.TermReg = TermReg
