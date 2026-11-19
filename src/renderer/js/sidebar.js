'use strict'
/* global window, document, U, D, Tabs */

const Sidebar = (() => {
  let tree = { nodes: [] }
  let filter = ''
  let selectedId = null

  const treeEl = () => U.$('#session-tree')

  // ----------------------------------------------------------------- tree --
  async function reload () {
    tree = await window.mx.sessions.get()
    paint()
    return tree
  }

  function flatSessions (nodes = tree.nodes, out = []) {
    for (const n of nodes) {
      if (n.type === 'folder') flatSessions(n.children || [], out)
      else out.push(n)
    }
    return out
  }

  function matches (node) {
    if (!filter) return true
    const hay = [node.name, node.host, node.username, node.type, ...(node.tags || [])].filter(Boolean).join(' ').toLowerCase()
    return hay.includes(filter)
  }

  function subtreeMatches (node) {
    if (node.type !== 'folder') return matches(node)
    return matches(node) || (node.children || []).some(subtreeMatches)
  }

  function paint () {
    const host = treeEl()
    U.clear(host)
    if (!tree.nodes.length) {
      host.append(U.el('div', { class: 'sb-empty', html: 'No sessions yet.<br><b>+</b> creates one.<br>Import from <code>~/.ssh/config</code> or CSV with the ↓ button.' }))
      return
    }
    const rendered = renderNodes(tree.nodes, 0)
    if (!rendered.length && filter) {
      host.append(U.el('div', { class: 'sb-empty', text: `Nothing matches “${filter}”.` }))
      return
    }
    rendered.forEach((n) => host.append(n))
  }

  function renderNodes (nodes, depth) {
    const out = []
    for (const node of nodes) {
      if (!subtreeMatches(node)) continue
      out.push(renderNode(node, depth))
      if (node.type === 'folder' && (node.expanded || filter)) {
        out.push(...renderNodes(node.children || [], depth + 1))
      }
    }
    return out
  }

  function renderNode (node, depth) {
    const isFolder = node.type === 'folder'
    const running = !isFolder && Tabs.list().some((t) => t.spec?.id === node.id && t.terms.some((x) => x.alive))

    const row = U.el('div', {
      class: `tnode ${isFolder ? 'folder' : ''} ${selectedId === node.id ? 'sel' : ''} ${running ? 'running' : ''}`,
      dataset: { id: node.id, type: node.type },
      draggable: 'true',
      style: `padding-left:${6 + depth * 13}px`,
      title: isFolder ? node.name : describe(node),
      onclick: () => {
        selectedId = node.id
        if (isFolder) toggleFolder(node)
        else paint()
      },
      ondblclick: () => { if (!isFolder) window.MX.launch(node) },
      oncontextmenu: (e) => nodeMenu(e, node),
      ondragstart: (e) => {
        e.dataTransfer.setData('text/x-gonds-node', node.id)
        e.dataTransfer.effectAllowed = 'move'
      },
      ondragover: (e) => {
        if (!e.dataTransfer.types.includes('text/x-gonds-node')) return
        e.preventDefault()
        row.classList.add('drop-into')
      },
      ondragleave: () => row.classList.remove('drop-into'),
      ondrop: async (e) => {
        row.classList.remove('drop-into')
        const src = e.dataTransfer.getData('text/x-gonds-node')
        if (!src || src === node.id) return
        try {
          const parentId = isFolder ? node.id : findParentId(node.id)
          await window.mx.sessions.move(src, parentId, -1)
          await reload()
        } catch (err) { U.err(err) }
      }
    })

    row.append(
      U.el('span', { class: 'tw', text: isFolder ? (node.expanded || filter ? '▾' : '▸') : '' }),
      U.icon(isFolder ? (node.expanded || filter ? 'i-folder-open' : 'i-folder') : U.typeIcon(node.type), 'ti'),
      U.el('span', { class: 'tl', text: node.name }),
      isFolder
        ? U.el('span', { class: 'tb', text: String((node.children || []).length) })
        : U.el('span', { class: 'tb', text: U.TYPE_LABEL[node.type] || node.type })
    )
    return row
  }

  function describe (node) {
    const bits = [U.TYPE_LABEL[node.type] || node.type]
    if (node.host) bits.push(`${node.username ? node.username + '@' : ''}${node.host}${node.port ? ':' + node.port : ''}`)
    if (node.device) bits.push(`${node.device} @ ${node.baud}`)
    if (node.jumpHosts?.length) bits.push(`via ${node.jumpHosts.join(' → ')}`)
    if (node.description) bits.push(node.description)
    return bits.join('\n')
  }

  function findParentId (id, nodes = tree.nodes, parent = null) {
    for (const n of nodes) {
      if (n.id === id) return parent
      if (n.children) {
        const hit = findParentId(id, n.children, n.id)
        if (hit !== undefined && hit !== false) return hit
      }
    }
    return undefined
  }

  async function toggleFolder (node) {
    node.expanded = !node.expanded
    await window.mx.sessions.save({ id: node.id, expanded: node.expanded })
    paint()
  }

  function nodeMenu (e, node) {
    e.preventDefault()
    selectedId = node.id
    paint()
    const isFolder = node.type === 'folder'
    U.menu(e.clientX, e.clientY, [
      !isFolder ? { label: 'Open', icon: 'i-session', onClick: () => window.MX.launch(node) } : null,
      !isFolder ? { label: 'Open in new tab', onClick: () => window.MX.launch(node, true) } : null,
      isFolder ? { label: 'Open every session in folder', icon: 'i-broadcast', onClick: () => openFolder(node) } : null,
      'sep',
      { label: isFolder ? 'New session in folder…' : 'New session here…', icon: 'i-plus', onClick: () => newSession(isFolder ? node.id : findParentId(node.id)) },
      { label: 'New folder…', icon: 'i-folder', onClick: () => newFolder(isFolder ? node.id : findParentId(node.id)) },
      'sep',
      { label: 'Edit…', onClick: () => edit(node) },
      { label: 'Duplicate', onClick: async () => { await window.mx.sessions.duplicate(node.id); reload() } },
      !isFolder ? { label: 'Copy ssh command', onClick: () => copySshCommand(node) } : null,
      'sep',
      { label: 'Delete', icon: 'i-trash', danger: true, onClick: () => remove(node) }
    ])
  }

  async function copySshCommand (node) {
    const parts = ['ssh']
    if (node.port && node.port !== 22) parts.push('-p', String(node.port))
    if (node.privateKey) parts.push('-i', node.privateKey)
    for (const j of node.jumpHosts || []) parts.push('-J', j)
    if (node.compression) parts.push('-C')
    parts.push(node.username ? `${node.username}@${node.host}` : node.host)
    await window.mx.clipboard.write(parts.join(' '))
    U.toast('Copied to clipboard', 'ok')
  }

  async function openFolder (node) {
    const list = flatSessions(node.children || [])
    if (!list.length) return U.toast('Folder is empty', 'warn')
    if (list.length > 8) {
      const ok = await D.confirm({ title: 'Open folder', message: `Open ${list.length} sessions at once?`, okLabel: 'Open all' })
      if (!ok) return
    }
    for (const s of list) await window.MX.launch(s, true)
  }

  async function newSession (parentId, preset) {
    const saved = await D.sessionEdit(preset || {}, parentId)
    if (saved) { await reload(); window.MX.launch(saved) }
  }

  async function newFolder (parentId) {
    const name = await D.input({ title: 'New folder', label: 'Name', placeholder: 'Production' })
    if (!name) return
    await window.mx.sessions.save({ type: 'folder', name, expanded: true }, parentId)
    await reload()
  }

  async function edit (node) {
    if (node.type === 'folder') {
      const name = await D.input({ title: 'Rename folder', label: 'Name', value: node.name })
      if (name) { await window.mx.sessions.save({ id: node.id, name }); await reload() }
      return
    }
    const saved = await D.sessionEdit(node, findParentId(node.id))
    if (saved) await reload()
  }

  async function remove (node) {
    const kids = node.type === 'folder' ? flatSessions(node.children || []).length : 0
    const ok = await D.confirm({
      title: 'Delete',
      message: `Delete “${node.name}”?`,
      detail: kids ? `This folder contains ${kids} session(s); all of them will be removed.` : 'Any stored password is removed from the Keychain too.',
      okLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    await window.mx.sessions.remove(node.id)
    await reload()
  }

  async function importSessions () {
    try {
      const res = await window.mx.sessions.import()
      if (res.cancelled) return
      await reload()
      U.toast(`Imported ${res.imported} session(s) into ${res.folders} folder(s) from ${res.format}`, 'ok', 6000)
      if (res.warnings?.length) {
        D.info({
          title: `Import warnings (${res.warnings.length})`,
          body: U.el('pre', { class: 'out', text: res.warnings.join('\n') })
        })
      }
    } catch (e) { U.err(e) }
  }

  async function importSshConfig () {
    try {
      const res = await window.mx.sessions.importSshConfig()
      await reload()
      U.toast(`Imported ${res.imported} host(s) from ~/.ssh/config`, 'ok')
    } catch (e) { U.err(e) }
  }

  // ------------------------------------------------------------- side tabs --
  function switchPane (name) {
    for (const p of U.$$('.sb-pane')) p.hidden = p.dataset.pane !== name
    for (const b of U.$$('.sb-tab')) b.classList.toggle('active', b.dataset.pane === name)
    if (name === 'tools') paintTools()
    if (name === 'macros') paintMacros()
    if (name === 'tunnels') paintTunnels()
  }

  function paintTools () {
    const host = U.$('#tools-pane')
    U.clear(host)
    const item = (iconId, label, fn, hint) => U.el('div', { class: 'tnode', onclick: fn, title: hint || label },
      U.el('span', { class: 'tw' }), U.icon(iconId, 'ti'), U.el('span', { class: 'tl', text: label }))
    host.append(
      U.el('div', { class: 'sb-empty', style: 'padding:8px 10px 2px', html: '<b>Network</b>' }),
      item('i-search', 'Network scanner', () => window.ToolsUI.netscan()),
      item('i-tunnel', 'Network connections', () => window.ToolsUI.netstat()),
      item('i-server', 'Listening ports', () => window.ToolsUI.ports()),
      U.el('div', { class: 'sb-empty', style: 'padding:8px 10px 2px', html: '<b>SSH</b>' }),
      item('i-key', 'Key generator', () => window.ToolsUI.keygen()),
      item('i-key', 'Known host keys', () => window.ToolsUI.knownHosts()),
      item('i-key', 'Saved passwords', () => window.ToolsUI.passwords()),
      U.el('div', { class: 'sb-empty', style: 'padding:8px 10px 2px', html: '<b>System</b>' }),
      item('i-tools', 'System information', () => window.ToolsUI.sysinfo()),
      item('i-broadcast', 'Process list', () => window.ToolsUI.processes()),
      item('i-package', 'Packages (Homebrew)', () => window.ToolsUI.packages()),
      item('i-server', 'X11 server (XQuartz)', () => window.ToolsUI.x11()),
      U.el('div', { class: 'sb-empty', style: 'padding:8px 10px 2px', html: '<b>Sessions</b>' }),
      item('i-download', 'Import sessions…', importSessions),
      item('i-download', 'Import ~/.ssh/config', importSshConfig),
      item('i-upload', 'Export sessions (CSV)…', async () => {
        const r = await window.mx.sessions.export()
        if (!r.cancelled) U.toast(`Exported to ${r.file}`, 'ok')
      })
    )
  }

  function paintMacros () {
    const host = U.$('#macros-pane')
    U.clear(host)
    const macros = window.MX.settings.macros || []
    host.append(U.el('div', { class: 'sb-actions', style: 'padding:6px' },
      U.el('button', { class: 'btn sm', text: '+ New macro', onclick: () => window.ToolsUI.macroEdit() }),
      U.el('button', { class: 'btn sm', text: 'Manage…', onclick: () => window.ToolsUI.macros() })
    ))
    if (!macros.length) {
      host.append(U.el('div', { class: 'sb-empty', html: 'No macros.<br>A macro is a list of lines sent to the focused terminal.' }))
      return
    }
    for (const m of macros) {
      host.append(U.el('div', {
        class: 'tnode',
        title: m.lines?.join('\n'),
        onclick: () => window.MX.runMacro(m),
        oncontextmenu: (e) => {
          e.preventDefault()
          U.menu(e.clientX, e.clientY, [
            { label: 'Run in focused terminal', icon: 'i-macro', onClick: () => window.MX.runMacro(m) },
            { label: 'Run in all terminals', icon: 'i-broadcast', onClick: () => window.MX.runMacro(m, true) },
            'sep',
            { label: 'Edit…', onClick: () => window.ToolsUI.macroEdit(m) },
            { label: 'Delete', danger: true, onClick: async () => { await window.mx.macros.remove(m.id); await window.MX.reloadSettings(); paintMacros() } }
          ])
        }
      },
      U.el('span', { class: 'tw' }), U.icon('i-macro', 'ti'),
      U.el('span', { class: 'tl', text: m.name }),
      U.el('span', { class: 'tb', text: `${(m.lines || []).length}L` })
      ))
    }
  }

  async function paintTunnels () {
    const host = U.$('#tunnels-pane')
    U.clear(host)
    host.append(U.el('div', { class: 'sb-actions', style: 'padding:6px' },
      U.el('button', { class: 'btn sm', text: '+ New tunnel', onclick: () => window.MX.openTunnels() })
    ))
    const live = []
    for (const tab of Tabs.list()) {
      for (const term of tab.terms) {
        if (!term.connId) continue
        try {
          const list = await window.mx.tunnel.list(term.connId)
          for (const t of list) live.push({ tab, term, t })
        } catch { /* connection closed mid-enumeration */ }
      }
    }
    if (!live.length) {
      host.append(U.el('div', { class: 'sb-empty', html: 'No active tunnels.<br>Open an SSH session, then add a local, remote or SOCKS forward.' }))
      return
    }
    for (const { tab, term, t } of live) {
      host.append(U.el('div', {
        class: 'tnode',
        title: `${tab.title}\n${describeTunnel(t)}`,
        oncontextmenu: (e) => {
          e.preventDefault()
          U.menu(e.clientX, e.clientY, [
            { label: 'Copy address', onClick: () => window.mx.clipboard.write(t.kind === 'remote' ? `${t.remoteHost || 'localhost'}:${t.remotePort}` : `127.0.0.1:${t.localPort}`) },
            { label: 'Stop tunnel', danger: true, onClick: async () => { await window.mx.tunnel.remove(term.connId, t.id); paintTunnels() } }
          ])
        }
      },
      U.el('span', { class: 'tw' }), U.icon('i-tunnel', 'ti'),
      U.el('span', { class: 'tl', text: describeTunnel(t) }),
      U.el('span', { class: 'tb', text: t.kind || 'local' })
      ))
    }
  }

  function describeTunnel (t) {
    if (t.kind === 'remote') return `remote ${t.remotePort} → localhost:${t.localPort}`
    if (t.kind === 'dynamic') return `socks5 127.0.0.1:${t.localPort}`
    return `${t.localPort} → ${t.remoteHost}:${t.remotePort}`
  }

  // ----------------------------------------------------------------- init --
  function init () {
    U.$('#session-filter').addEventListener('input', U.debounce((e) => {
      filter = e.target.value.trim().toLowerCase()
      paint()
    }, 90))

    for (const b of U.$$('.sb-tab')) b.addEventListener('click', () => switchPane(b.dataset.pane))

    treeEl().addEventListener('contextmenu', (e) => {
      if (e.target.closest('.tnode')) return
      e.preventDefault()
      U.menu(e.clientX, e.clientY, [
        { label: 'New session…', icon: 'i-plus', onClick: () => newSession(null) },
        { label: 'New folder…', icon: 'i-folder', onClick: () => newFolder(null) },
        'sep',
        { label: 'Import sessions…', icon: 'i-download', onClick: importSessions },
        { label: 'Import ~/.ssh/config', onClick: importSshConfig }
      ])
    })

    // Dropping on empty tree space moves to root.
    treeEl().addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('text/x-gonds-node')) e.preventDefault()
    })
    treeEl().addEventListener('drop', async (e) => {
      if (e.target.closest('.tnode')) return
      const src = e.dataTransfer.getData('text/x-gonds-node')
      if (!src) return
      await window.mx.sessions.move(src, null, -1)
      await reload()
    })

    const sb = U.$('#sidebar')
    let base = 0
    const grip = U.$('#sidebar-resize')
    grip.addEventListener('mousedown', () => { base = sb.offsetWidth })
    U.drag(grip, (dx) => {
      const w = Math.max(170, Math.min(520, base + dx))
      sb.style.width = `${w}px`
      window.mx.settings.patch({ ui: { sidebarWidth: w } }).catch(() => {})
      Tabs.active?.terms?.forEach((t) => t.refit())
    })
  }

  return {
    init, reload, paint, flatSessions, newSession, newFolder, remove,
    importSessions, importSshConfig, switchPane, paintTunnels, paintMacros,
    describeTunnel
  }
})()

window.Sidebar = Sidebar
