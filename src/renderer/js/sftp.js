'use strict'
/* global window, document, U, D */

/** Global transfer ledger, shared by every SFTP panel. */
const Transfers = (() => {
  const rows = new Map()
  const views = new Set()

  window.mx.on('transfer:update', (t) => {
    rows.set(t.id, t)
    if (t.state !== 'running') setTimeout(() => { rows.delete(t.id); paint() }, 4000)
    paint()
  })

  function paint () {
    const list = [...rows.values()].slice(-40)
    for (const v of views) v(list)
    const running = list.filter((t) => t.state === 'running')
    window.MX?.setStatusTransfers(running.length
      ? `${running.length} transfer${running.length > 1 ? 's' : ''}`
      : '')
  }

  return {
    subscribe (fn) { views.add(fn); fn([...rows.values()]); return () => views.delete(fn) },
    active: () => [...rows.values()].filter((t) => t.state === 'running')
  }
})()

/** Turn a batch result list into one honest sentence. */
function summarise (verb, results, dest) {
  const done = results.filter((r) => r.ok && !r.skipped).length
  const skipped = results.filter((r) => r.skipped).length
  const cancelled = results.filter((r) => r.cancelled).length
  const failed = results.filter((r) => !r.ok && !r.cancelled).length
  const bits = [`${verb} ${done} file(s)${dest ? ` to ${dest}` : ''}`]
  if (skipped) bits.push(`${skipped} skipped`)
  if (cancelled) bits.push(`${cancelled} cancelled`)
  if (failed) bits.push(`${failed} failed`)
  const level = failed ? 'err' : (cancelled || skipped) ? 'warn' : 'ok'
  return [bits.join(' · '), level, failed || cancelled ? 7000 : 4200]
}

class SftpPanel {
  /**
   * @param {object} opts
   *   mode:   'remote' | 'local'
   *   connId: function|string — SSH connection id (remote mode)
   *   allowToggle: show Remote/Local switch
   *   peer:   function returning the other panel (for internal drag transfers)
   *   onPathChange: fn(path, mode)
   */
  constructor (opts = {}) {
    this.mode = opts.mode || 'remote'
    this._connId = opts.connId
    this.opts = opts
    this.path = null
    this.entries = []
    this.sel = new Set()
    this.showHidden = false
    this.follow = Boolean(window.MX?.settings?.transfers?.followTerminalCwd)
    this.el = U.el('div', { class: 'sftp' })
    this._build()
  }

  get connId () { return typeof this._connId === 'function' ? this._connId() : this._connId }

  _build () {
    const tb = U.el('div', { class: 'sftp-toolbar' })
    const mk = (iconId, title, fn) => U.el('button', { class: 'mini', title, onclick: fn }, U.icon(iconId))

    tb.append(
      mk('i-up', 'Parent folder', () => this.up()),
      mk('i-refresh', 'Refresh', () => this.reload()),
      mk('i-folder', 'Home', () => this.goHome()),
      mk('i-plus', 'New folder', () => this.mkdir()),
      mk('i-upload', 'Upload…', () => this.uploadDialog()),
      mk('i-download', 'Download selected…', () => this.downloadSelected()),
      mk('i-trash', 'Delete selected', () => this.removeSelected())
    )
    this.toolbar = tb

    this.pathInput = U.el('input', {
      type: 'text',
      spellcheck: 'false',
      onkeydown: (e) => { if (e.key === 'Enter') this.go(this.pathInput.value) }
    })

    const head = U.el('div', { class: 'sftp-head' }, tb, U.el('div', { class: 'sftp-path' }, this.pathInput))

    if (this.opts.allowToggle) {
      this.remoteBtn = U.el('button', { text: 'Remote', class: this.mode === 'remote' ? 'active' : '', onclick: () => this.setMode('remote') })
      this.localBtn = U.el('button', { text: 'Local', class: this.mode === 'local' ? 'active' : '', onclick: () => this.setMode('local') })
      this.hiddenBtn = U.el('button', { text: 'Hidden', class: this.showHidden ? 'active' : '', onclick: () => { this.showHidden = !this.showHidden; this.hiddenBtn.classList.toggle('active'); this.paint() } })
      this.followBtn = U.el('button', {
        text: 'Follow',
        title: 'Follow the terminal’s working directory (needs OSC 7 from your shell)',
        class: this.follow ? 'active' : '',
        onclick: () => { this.follow = !this.follow; this.followBtn.classList.toggle('active') }
      })
      head.append(U.el('div', { class: 'sftp-side' }, this.remoteBtn, this.localBtn, this.hiddenBtn, this.followBtn))
    }

    this.list = U.el('div', { class: 'sftp-list', tabindex: '0' })
    this.foot = U.el('div', { class: 'sftp-foot' })
    this.xferHost = U.el('div', { class: 'xfer' })
    this.dropHint = U.el('div', { class: 'sftp-drop-hint', text: 'Drop to upload' })

    this.el.append(this.dropHint, head, this.list, this.xferHost, this.foot)

    if (this.opts.resizable !== false) {
      const grip = U.el('div', { class: 'sftp-resize' })
      this.el.append(grip)
      let base = 0
      grip.addEventListener('mousedown', () => { base = this.el.offsetWidth })
      U.drag(grip, (dx) => {
        const w = Math.max(170, Math.min(640, base + dx))
        this.el.style.width = `${w}px`
        window.mx.settings.patch({ ui: { sftpPanelWidth: w } }).catch(() => {})
      })
    }

    this._bindDnd()
    this._bindKeys()
    this.unsubscribe = Transfers.subscribe((list) => this._paintTransfers(list))
  }

  _bindKeys () {
    this.list.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace') { e.preventDefault(); this.up() }
      if (e.key === 'Enter' && this.sel.size === 1) {
        const entry = this.entries.find((x) => x.path === [...this.sel][0])
        if (entry) this.activate(entry)
      }
      if ((e.key === 'Delete' || (e.metaKey && e.key === 'Backspace')) && this.sel.size) {
        e.preventDefault(); this.removeSelected()
      }
      if (e.metaKey && e.key === 'a') { e.preventDefault(); this.entries.forEach((x) => this.sel.add(x.path)); this.paint() }
    })
  }

  _bindDnd () {
    const stop = (e) => { e.preventDefault(); e.stopPropagation() }

    this.el.addEventListener('dragenter', (e) => { stop(e); if (this._acceptsDrop(e)) this.el.classList.add('dragover') })
    this.el.addEventListener('dragover', (e) => { stop(e); if (this._acceptsDrop(e)) e.dataTransfer.dropEffect = 'copy' })
    this.el.addEventListener('dragleave', (e) => {
      if (!this.el.contains(e.relatedTarget)) this.el.classList.remove('dragover')
    })
    this.el.addEventListener('drop', async (e) => {
      stop(e)
      this.el.classList.remove('dragover')
      // 1. Finder / external files
      const files = [...(e.dataTransfer.files || [])]
      if (files.length) {
        const paths = files.map((f) => window.mx.pathForFile(f)).filter(Boolean)
        if (paths.length) return this.receiveLocalPaths(paths, this.path)
        return U.toast('Could not resolve the dropped file paths', 'warn')
      }
      // 2. Internal panel-to-panel drag
      const payload = e.dataTransfer.getData('application/x-gonds-files')
      if (payload) {
        try {
          const { mode, connId, paths } = JSON.parse(payload)
          return this.receiveInternal(mode, connId, paths, this._dropTarget(e) || this.path)
        } catch (err) { U.err(err) }
      }
    })
  }

  _dropTarget (e) {
    const row = e.target.closest?.('.frow')
    if (!row) return null
    const entry = this.entries.find((x) => x.path === row.dataset.path)
    return entry && entry.isDir ? entry.path : null
  }

  _acceptsDrop (e) {
    return [...(e.dataTransfer.types || [])].some((t) => t === 'Files' || t === 'application/x-gonds-files')
  }

  // --------------------------------------------------------------- loading --
  async setMode (mode) {
    if (this.mode === mode) return
    this.mode = mode
    this.remoteBtn?.classList.toggle('active', mode === 'remote')
    this.localBtn?.classList.toggle('active', mode === 'local')
    this.sel.clear()
    this.path = null
    await this.goHome()
  }

  async goHome () {
    try {
      const home = this.mode === 'local' ? await window.mx.files.home() : await window.mx.sftp.home(this.connId)
      await this.go(home)
    } catch (e) { this.showError(e) }
  }

  async go (dir) {
    try {
      const res = this.mode === 'local'
        ? await window.mx.files.localList(dir)
        : await window.mx.sftp.list(this.connId, dir)
      this.path = res.path
      this.parent = res.parent
      this.entries = res.entries
      this.sel.clear()
      this.pathInput.value = res.path
      this.paint()
      this.opts.onPathChange?.(res.path, this.mode)
    } catch (e) { this.showError(e) }
  }

  reload () { return this.path ? this.go(this.path) : this.goHome() }
  up () { return this.parent ? this.go(this.parent) : null }

  /** Called by the terminal's OSC 7 handler. */
  followCwd (cwd) {
    if (!this.follow || this.mode !== 'remote' || !cwd) return
    if (this.path === cwd) return
    this.go(cwd)
  }

  showError (e) {
    U.clear(this.list)
    this.list.append(U.el('div', { class: 'sb-empty' }, U.el('span', { class: 'err', text: e.message || String(e) })))
    this.foot.textContent = ''
  }

  // ---------------------------------------------------------------- render --
  paint () {
    U.clear(this.list)
    const visible = this.entries.filter((x) => this.showHidden || !x.hidden)

    if (this.parent) {
      this.list.append(U.el('div', {
        class: 'frow dir',
        ondblclick: () => this.up(),
        onclick: () => this.up()
      }, U.icon('i-up', 'fi'), U.el('span', { class: 'fn', text: '..' }), U.el('span'), U.el('span')))
    }

    for (const entry of visible) {
      const row = U.el('div', {
        class: `frow ${entry.isDir ? 'dir' : ''} ${this.sel.has(entry.path) ? 'sel' : ''} ${entry.hidden ? 'hidden-entry' : ''}`,
        dataset: { path: entry.path },
        draggable: 'true',
        title: `${entry.modeString || ''}  ${U.bytes(entry.size)}  ${U.date(entry.mtime)}`,
        onclick: (e) => this.clickRow(e, entry),
        ondblclick: () => this.activate(entry),
        oncontextmenu: (e) => this.rowMenu(e, entry),
        ondragstart: (e) => this.startDrag(e, entry)
      },
      U.icon(entry.isDir ? 'i-folder' : 'i-file', 'fi'),
      U.el('span', { class: 'fn', text: entry.name + (entry.isLink ? ' →' : '') }),
      U.el('span', { class: 'fs', text: entry.isDir ? '' : U.bytes(entry.size) }),
      U.el('span', { class: 'fm', text: U.date(entry.mtime) })
      )
      this.list.append(row)
    }

    if (!visible.length) {
      this.list.append(U.el('div', { class: 'sb-empty', text: this.entries.length ? 'only hidden entries here' : 'empty folder' }))
    }

    const dirs = visible.filter((x) => x.isDir).length
    const size = visible.filter((x) => !x.isDir).reduce((a, b) => a + (b.size || 0), 0)
    U.clear(this.foot)
    this.foot.append(
      U.el('span', { text: `${visible.length - dirs} files · ${dirs} dirs · ${U.bytes(size)}` }),
      U.el('span', { class: 'sb-grow' }),
      U.el('span', { text: this.mode === 'local' ? 'local' : 'remote' })
    )
  }

  _paintTransfers (list) {
    U.clear(this.xferHost)
    for (const t of list.slice(-6)) {
      const pct = t.total ? Math.min(100, (t.bytes / t.total) * 100) : 0
      const label = t.state === 'cancelled'
        ? ' — cancelled'
        : t.error ? ` — ${t.error}` : ''
      this.xferHost.append(U.el('div', { class: `xfer-row ${t.state}` },
        U.el('span', { class: 'nm', text: `${t.direction === 'upload' ? '↑' : '↓'} ${t.name}${label}` }),
        U.el('span', { class: 'bar' }, U.el('i', { style: `width:${t.state === 'done' ? 100 : pct}%` })),
        t.state === 'running'
          ? U.el('button', {
            class: 'xcancel',
            title: 'Cancel this transfer and anything queued behind it',
            onclick: () => window.mx.transfers.cancel(t.id, 'batch').catch(U.err)
          }, U.icon('i-close'))
          : U.el('span', { class: 'xcancel' })
      ))
    }
  }

  clickRow (e, entry) {
    if (e.metaKey) {
      this.sel.has(entry.path) ? this.sel.delete(entry.path) : this.sel.add(entry.path)
    } else if (e.shiftKey && this.sel.size) {
      const visible = this.entries.filter((x) => this.showHidden || !x.hidden)
      const last = [...this.sel].pop()
      const a = visible.findIndex((x) => x.path === last)
      const b = visible.findIndex((x) => x.path === entry.path)
      if (a >= 0 && b >= 0) {
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) this.sel.add(visible[i].path)
      }
    } else {
      this.sel.clear()
      this.sel.add(entry.path)
    }
    this.paint()
    this.list.focus()
  }

  activate (entry) {
    if (entry.isDir) return this.go(entry.path)
    if (this.mode === 'local') return window.mx.files.openExternal(entry.path).catch(U.err)
    return this.editRemote(entry)
  }

  startDrag (e, entry) {
    if (!this.sel.has(entry.path)) { this.sel.clear(); this.sel.add(entry.path); this.paint() }
    e.dataTransfer.setData('application/x-gonds-files', JSON.stringify({
      mode: this.mode,
      connId: this.connId,
      paths: [...this.sel]
    }))
    e.dataTransfer.effectAllowed = 'copy'
  }

  // ------------------------------------------------------------- transfers --
  async receiveLocalPaths (paths, destDir) {
    if (this.mode === 'local') return U.toast('Drop into the remote panel to upload', 'warn')
    if (!this.connId) return U.toast('No SSH connection for this panel', 'warn')
    try {
      const { results } = await window.mx.sftp.upload(this.connId, paths, destDir || this.path)
      U.toast(...summarise('Uploaded', results))
      this.reload()
    } catch (e) { U.err(e) }
  }

  async receiveInternal (srcMode, srcConnId, paths, destDir) {
    if (srcMode === this.mode && srcConnId === this.connId) {
      return U.toast('Same panel — nothing to transfer', 'warn')
    }
    try {
      if (this.mode === 'remote') {
        if (srcMode !== 'local') return U.toast('Remote-to-remote copy is not supported', 'warn')
        await this.receiveLocalPaths(paths, destDir)
      } else {
        const { results } = await window.mx.sftp.download(srcConnId, paths, destDir || this.path)
        U.toast(...summarise('Downloaded', results))
        this.reload()
      }
    } catch (e) { U.err(e) }
  }

  async uploadDialog () {
    if (this.mode !== 'remote') return U.toast('Switch to the remote panel to upload', 'warn')
    const paths = await window.mx.sftp.pickUploadFiles()
    if (!paths.length) return
    await this.receiveLocalPaths(paths, this.path)
  }

  async downloadSelected () {
    if (this.mode !== 'remote') return U.toast('Downloads come from the remote panel', 'warn')
    if (!this.sel.size) return U.toast('Select something first', 'warn')
    const peer = this.opts.peer?.()
    let dest = peer && peer.mode === 'local' ? peer.path : null
    if (!dest) dest = await window.mx.sftp.pickDownloadDir()
    if (!dest) return
    try {
      const { results } = await window.mx.sftp.download(this.connId, [...this.sel], dest)
      U.toast(...summarise('Downloaded', results, dest))
      peer?.reload()
    } catch (e) { U.err(e) }
  }

  async mkdir () {
    const name = await D.input({ title: 'New folder', label: 'Name', placeholder: 'folder' })
    if (!name) return
    try {
      if (this.mode === 'local') await window.mx.files.localMkdir(this.path, name)
      else await window.mx.sftp.mkdir(this.connId, this.path, name)
      this.reload()
    } catch (e) { U.err(e) }
  }

  async removeSelected () {
    if (!this.sel.size) return
    const targets = [...this.sel]
    const ok = await D.confirm({
      title: 'Delete',
      message: `Delete ${targets.length} item(s)?`,
      detail: targets.slice(0, 8).join('\n') + (targets.length > 8 ? `\n… and ${targets.length - 8} more` : ''),
      okLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    try {
      if (this.mode === 'local') await window.mx.files.localRemove(targets)
      else await window.mx.sftp.remove(this.connId, targets)
      this.sel.clear()
      this.reload()
    } catch (e) { U.err(e) }
  }

  async renameEntry (entry) {
    const name = await D.input({ title: 'Rename', label: 'New name', value: entry.name })
    if (!name || name === entry.name) return
    const dir = this.mode === 'local' ? this.path : this.path
    const to = this.mode === 'local' ? `${dir}/${name}` : `${dir.replace(/\/$/, '')}/${name}`
    try {
      if (this.mode === 'local') await window.mx.files.localRename(entry.path, to)
      else await window.mx.sftp.rename(this.connId, entry.path, to)
      this.reload()
    } catch (e) { U.err(e) }
  }

  async chmodEntry (entry) {
    if (this.mode === 'local') return U.toast('Use Finder or chmod for local permissions', 'warn')
    const current = U.modeOctal(entry.mode)
    const val = await D.input({ title: `Permissions — ${entry.name}`, label: 'Octal mode', value: current, hint: 'e.g. 0644 for files, 0755 for directories' })
    if (!val) return
    const mode = parseInt(val, 8)
    if (!Number.isFinite(mode)) return U.toast('Not a valid octal mode', 'warn')
    try {
      await window.mx.sftp.chmod(this.connId, entry.path, mode)
      this.reload()
    } catch (e) { U.err(e) }
  }

  /** Open a remote text file in a modal editor and write it back over SFTP. */
  async editRemote (entry) {
    let text
    try {
      text = await window.mx.sftp.read(this.connId, entry.path)
    } catch (e) { return U.err(e) }
    let area
    const api = D.open({
      title: `Edit — ${entry.path}`,
      icon: 'i-file',
      width: 'wide',
      body: (b) => {
        area = U.el('textarea', { rows: '24', spellcheck: 'false' }, text)
        area.style.cssText = 'width:100%;font-family:var(--mono);font-size:11.5px;resize:vertical'
        b.append(area)
        return area
      },
      footer: (ftr) => ftr.append(
        U.el('div', { class: 'left' }, U.el('span', { class: 'hint', text: `${U.bytes(entry.size)} · ${entry.modeString || ''}` })),
        U.el('button', { class: 'btn', text: 'Cancel', onclick: () => api.close(null) }),
        U.el('button', {
          class: 'btn primary',
          text: 'Save to server',
          onclick: async () => {
            try {
              await window.mx.sftp.write(this.connId, entry.path, area.value)
              U.toast('Saved', 'ok')
              api.close(true)
              this.reload()
            } catch (e) { U.err(e) }
          }
        })
      )
    })
  }

  rowMenu (e, entry) {
    e.preventDefault()
    if (!this.sel.has(entry.path)) { this.sel.clear(); this.sel.add(entry.path); this.paint() }
    const remote = this.mode === 'remote'
    U.menu(e.clientX, e.clientY, [
      { label: entry.isDir ? 'Open folder' : (remote ? 'Edit in place' : 'Open'), icon: 'i-file', onClick: () => this.activate(entry) },
      remote
        ? { label: 'Download…', icon: 'i-download', onClick: () => this.downloadSelected() }
        : { label: 'Reveal in Finder', icon: 'i-folder-open', onClick: () => window.mx.files.reveal(entry.path) },
      'sep',
      { label: 'Rename…', onClick: () => this.renameEntry(entry) },
      { label: 'New folder…', icon: 'i-plus', onClick: () => this.mkdir() },
      remote ? { label: 'Permissions…', icon: 'i-key', onClick: () => this.chmodEntry(entry) } : null,
      'sep',
      {
        label: 'Copy path',
        onClick: () => window.mx.clipboard.write([...this.sel].join('\n'))
      },
      { label: `Delete ${this.sel.size > 1 ? `${this.sel.size} items` : ''}`.trim(), icon: 'i-trash', danger: true, onClick: () => this.removeSelected() }
    ])
  }

  dispose () {
    this.unsubscribe?.()
    this.el.remove()
  }
}

window.SftpPanel = SftpPanel
window.Transfers = Transfers
