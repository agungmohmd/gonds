'use strict'
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { app, BrowserWindow, ipcMain, Menu, dialog, shell, nativeTheme, clipboard, screen } = require('electron')

const sessions = require('./sessions')
const settings = require('./settings')
const ssh = require('./ssh')
const terminals = require('./terminals')
const files = require('./files')
const tools = require('./tools')
const keychain = require('./keychain')

let win = null

function send (channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

// --------------------------------------------------- renderer round-trips ----
// SSH auth and host-key decisions need a human. Main asks the renderer and
// awaits the answer, with no timeout: a connection may legitimately sit at a
// password prompt for as long as the user needs.
let promptSeq = 0
const pending = new Map()

function ask (kind, payload) {
  const id = `p${++promptSeq}`
  return new Promise((resolve) => {
    pending.set(id, resolve)
    send('prompt:request', { id, kind, payload })
  })
}

ipcMain.handle('prompt:reply', (_e, { id, value }) => {
  const resolve = pending.get(id)
  if (!resolve) return false
  pending.delete(id)
  resolve(value)
  return true
})

const sshHooks = {
  // Only non-secret fields cross to the renderer. `retry`/`attempt` are what
  // let the dialog say the last password was rejected.
  askPassword: (connId, spec) => ask('password', {
    connId,
    host: spec.host,
    username: spec.username,
    port: spec.port,
    retry: Boolean(spec.retry),
    attempt: spec.attempt || 1
  }),
  askPassphrase: (connId, keyPath) => ask('passphrase', { connId, keyPath }),
  askKeyboardInteractive: (connId, info) => ask('keyboard-interactive', { connId, ...info }),
  verifyHostKey: (connId, info) => ask('host-key', { connId, ...info }),
  onBanner: (connId, msg) => send('ssh:banner', { connId, message: msg }),
  onError: (connId, msg) => send('ssh:error', { connId, message: msg }),
  onClose: (connId) => send('ssh:close', { connId }),
  onTunnelError: (connId, tunnelId, msg) => send('tunnel:error', { connId, tunnelId, message: msg })
}

// A transfer found a file already sitting at the destination. Ask, unless
// settings say otherwise — overwriting someone's data silently is not a
// default anyone asked for.
const askConflict = (info) => ask('overwrite', info)

// ------------------------------------------------------------------ window ----

/**
 * Reuse the saved geometry only if it still lands on a display that exists —
 * otherwise an unplugged monitor leaves the window invisible off-screen.
 */
function savedBounds () {
  const b = settings.get().ui.windowBounds
  if (!b || !Number.isFinite(b.width) || !Number.isFinite(b.height)) return null
  const visible = screen.getAllDisplays().some((d) => {
    const w = d.workArea
    return b.x < w.x + w.width && b.x + b.width > w.x &&
           b.y < w.y + w.height && b.y + b.height > w.y
  })
  return visible ? b : null
}

function rememberBounds () {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
  const b = win.getNormalBounds()
  settings.patch({ ui: { windowBounds: { x: b.x, y: b.y, width: b.width, height: b.height }, maximised: win.isMaximized() } })
}

function createWindow () {
  const ui = settings.get().ui
  const b = savedBounds()
  win = new BrowserWindow({
    ...(b ? { x: b.x, y: b.y, width: b.width, height: b.height } : { width: 1440, height: 900 }),
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: ui.theme === 'light' ? '#f3f3f3' : '#1e1e1e',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 8 }, // centres the buttons in the 28px title bar
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  win.once('ready-to-show', () => {
    win.show()
    if (settings.get().ui.maximised) win.maximize()
  })

  // trade-off: a 400 ms debounce is plenty — this only has to survive a crash.
  let boundsTimer = null
  const queueBounds = () => {
    clearTimeout(boundsTimer)
    boundsTimer = setTimeout(rememberBounds, 400)
  }
  win.on('resize', queueBounds)
  win.on('move', queueBounds)
  win.on('close', () => { clearTimeout(boundsTimer); rememberBounds() })

  // Demo recorder: GONDS_RECORD=<dir> dumps a numbered PNG per frame while a
  // scenario drives the UI, for scripts/record.js to assemble. Frames come from
  // capturePage rather than the OS screen recorder, which needs a TCC grant the
  // terminal usually does not have.
  if (process.env.GONDS_RECORD) {
    const dir = process.env.GONDS_RECORD
    const fps = Number(process.env.GONDS_RECORD_FPS || 8)
    const width = Number(process.env.GONDS_RECORD_WIDTH || 1440)
    fs.mkdirSync(dir, { recursive: true })
    let n = 0
    let busy = false
    const timer = setInterval(async () => {
      if (busy || win.isDestroyed()) return // skip rather than queue: a slow
      busy = true                           // capture must not bunch frames up
      try {
        let img = await win.webContents.capturePage()
        const size = img.getSize()
        if (size.width > width) {
          img = img.resize({ width, height: Math.round(size.height * width / size.width), quality: 'good' })
        }
        fs.writeFileSync(path.join(dir, `f${String(++n).padStart(5, '0')}.png`), img.toPNG())
      } catch {} finally { busy = false }
    }, Math.round(1000 / fps))
    app.on('before-quit', () => clearInterval(timer))
  }

  // Smoke harness: GONDS_SMOKE=<png path> renders the window, reports any
  // renderer console error, writes a screenshot and exits. Used by npm run smoke.
  if (process.env.GONDS_SMOKE) {
    const problems = []
    // Electron >=30 passes a single event object on console-message.
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 'warning') {
        problems.push(`${e.sourceId || '?'}:${e.lineNumber ?? 0} ${e.message}`)
      }
    })
    win.webContents.on('render-process-gone', (_e, d) => problems.push(`renderer gone: ${d.reason}`))
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        let result = {}
        try {
          if (process.env.GONDS_SMOKE_SSH) {
            await win.webContents.executeJavaScript(
              `window.__SMOKE = ${process.env.GONDS_SMOKE_SSH}; true`)
          }
          const scenarioPath = process.env.GONDS_SMOKE_SCENARIO
          if (scenarioPath) {
            const code = fs.readFileSync(scenarioPath, 'utf8')
            result = await win.webContents.executeJavaScript(`(async () => {\n${code}\n})()`, true)
          }
          const probe = await win.webContents.executeJavaScript(`(() => ({
            tabs: document.querySelectorAll('#tabs .tab').length,
            chips: document.querySelectorAll('.home .chip').length,
            ribbon: document.querySelectorAll('#ribbon .rib').length,
            mxReady: Boolean(window.MX && window.MX.settings),
            fatal: document.body.innerText.includes('Gonds failed to start')
          }))()`)
          const img = await win.webContents.capturePage()
          fs.writeFileSync(process.env.GONDS_SMOKE, img.toPNG())
          console.log('SMOKE ' + JSON.stringify({ ...result, probe, problems }))
        } catch (err) {
          console.log('SMOKE ' + JSON.stringify({ ...result, error: err.message, problems }))
        }
        app.exit(0)
      }, 2000)
    })
  }

  // Links in terminal output open in the real browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  win.on('closed', () => { win = null })
}

function menuAction (id) {
  return () => send('menu:action', { id })
}

/** Accelerator for an action, as the user configured it. '' disables it. */
function accel (id) {
  const v = settings.get().hotkeys?.[id]
  return v === undefined ? settings.DEFAULT_HOTKEYS[id] : (v || undefined)
}

/** A menu entry whose shortcut is user-editable. */
function item (id, label) {
  return { label, accelerator: accel(id), click: menuAction(id) }
}

function buildMenu () {
  const template = [
    {
      label: app.name,
      submenu: [
        { label: 'About Gonds', click: menuAction('about') },
        { type: 'separator' },
        item('settings', 'Settings…'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Session',
      submenu: [
        item('new-session', 'New Session…'),
        item('quick-connect', 'Quick Connect…'),
        item('new-shell', 'New Local Shell'),
        { type: 'separator' },
        item('duplicate-tab', 'Duplicate Tab'),
        item('close-tab', 'Close Tab'),
        { type: 'separator' },
        { label: 'Import Sessions…', click: menuAction('import-sessions') },
        { label: 'Export Sessions…', click: menuAction('export-sessions') }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        item('copy', 'Copy'),
        item('paste', 'Paste'),
        item('select-all', 'Select All'),
        { type: 'separator' },
        item('find-in-terminal', 'Find in Terminal…'),
        item('clear-terminal', 'Clear Terminal')
      ]
    },
    {
      label: 'View',
      submenu: [
        item('toggle-sidebar', 'Toggle Sidebar'),
        item('toggle-sftp', 'Toggle SFTP Panel'),
        { type: 'separator' },
        item('split-right', 'Split Right'),
        item('split-down', 'Split Down'),
        { type: 'separator' },
        item('zoom-in', 'Zoom In'),
        item('zoom-out', 'Zoom Out'),
        item('zoom-reset', 'Actual Size'),
        { type: 'separator' },
        item('next-tab', 'Next Tab'),
        item('prev-tab', 'Previous Tab'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { label: 'Toggle Developer Tools', accelerator: 'Cmd+Alt+I', click: () => win?.webContents.toggleDevTools() }
      ]
    },
    {
      label: 'Tools',
      submenu: [
        item('broadcast', 'Broadcast'),
        { label: 'Macros…', click: menuAction('macros') },
        { label: 'SSH Tunnels…', click: menuAction('tunnels') },
        { type: 'separator' },
        { label: 'SSH Key Generator…', click: menuAction('keygen') },
        { label: 'Network Scanner…', click: menuAction('netscan') },
        { label: 'Network Connections…', click: menuAction('netstat') },
        { label: 'Listening Ports…', click: menuAction('ports') },
        { label: 'Process List…', click: menuAction('processes') },
        { type: 'separator' },
        { label: 'System Information…', click: menuAction('sysinfo') },
        { label: 'Packages…', click: menuAction('packages') },
        { label: 'X11 Server (XQuartz)', click: menuAction('x11') },
        { type: 'separator' },
        { label: 'Saved Passwords…', click: menuAction('passwords') },
        { label: 'Known Host Keys…', click: menuAction('known-hosts') }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
    },
    {
      role: 'help',
      submenu: [
        { label: 'Keyboard Shortcuts', click: menuAction('hotkeys') },
        { label: 'Build Notes', click: () => openDoc('SESSION-STATE.md') }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function openDoc (name) {
  // Packaged builds ship docs/ as extraResources; shell.openPath cannot read
  // inside app.asar, so the resources copy is tried first.
  for (const base of [process.resourcesPath, app.getAppPath()]) {
    if (!base) continue
    const p = path.join(base, 'docs', name)
    if (fs.existsSync(p)) return shell.openPath(p)
  }
  send('toast', { level: 'warn', message: `${name} is not bundled with this build` })
}

// -------------------------------------------------------------------- IPC ----

function handle (channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) }
    } catch (err) {
      return { ok: false, error: err.message || String(err) }
    }
  })
}

function registerIpc () {
  // --- settings
  handle('settings:get', () => ({ settings: settings.get(), schemes: settings.schemes(), platform: process.platform, version: app.getVersion() }))
  handle('settings:patch', (p) => settings.patch(p))
  handle('settings:reset', () => settings.reset())
  handle('settings:theme', (name) => settings.toXtermTheme(name))
  handle('settings:hotkeys', () => ({
    current: { ...settings.DEFAULT_HOTKEYS, ...(settings.get().hotkeys || {}) },
    defaults: settings.DEFAULT_HOTKEYS,
    labels: settings.HOTKEY_LABELS
  }))
  handle('settings:set-hotkeys', (map) => {
    settings.patch({ hotkeys: map })
    buildMenu() // accelerators live in the menu bar, so it has to be rebuilt
    return settings.get().hotkeys
  })
  // Written by the renderer whenever tabs change, read back at next launch.
  handle('settings:set-open-tabs', (tabs) => {
    settings.patch({ ui: { openTabs: tabs } })
    return true
  })

  // --- sessions
  handle('sessions:get', () => sessions.get())
  handle('sessions:save', (node, parentId) => sessions.save(node, parentId))
  handle('sessions:delete', (id) => {
    keychain.deletePassword(id).catch(() => {})
    return sessions.remove(id)
  })
  handle('sessions:move', (id, parentId, index) => sessions.move(id, parentId, index))
  handle('sessions:duplicate', (id) => sessions.duplicate(id))
  handle('sessions:import', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Import sessions',
      filters: [
        { name: 'CSV', extensions: ['csv'] },
        { name: 'SSH config', extensions: ['', 'config'] },
        { name: 'All files', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    if (r.canceled || !r.filePaths.length) return { cancelled: true }
    const file = r.filePaths[0]
    const text = fs.readFileSync(file, 'utf8')
    const format = /\.csv$/i.test(file) ? 'csv' : 'ssh_config'
    const res = sessions.importText(text, format)
    return { ...res, file, format }
  })
  handle('sessions:import-ssh-config', () => {
    const p = path.join(os.homedir(), '.ssh', 'config')
    if (!fs.existsSync(p)) throw new Error('~/.ssh/config does not exist')
    return sessions.importText(fs.readFileSync(p, 'utf8'), 'ssh_config')
  })
  handle('sessions:export', async () => {
    const r = await dialog.showSaveDialog(win, { title: 'Export sessions', defaultPath: 'gonds-sessions.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] })
    if (r.canceled || !r.filePath) return { cancelled: true }
    fs.writeFileSync(r.filePath, sessions.exportCsv())
    return { file: r.filePath }
  })

  // --- keychain
  handle('secret:set', (account, secret) => keychain.setPassword(account, secret))
  handle('secret:get', (account) => keychain.getPassword(account))
  handle('secret:delete', (account) => keychain.deletePassword(account))
  handle('secret:list', () => sessions.flatSessions().map((s) => ({ id: s.id, name: s.name, host: s.host, username: s.username })))

  // --- terminals
  handle('term:open', async (spec) => {
    const st = settings.get()
    const merged = {
      ...st.ssh,
      ...spec,
      env: spec.env,
      keepaliveInterval: spec.keepaliveInterval ?? st.ssh.keepaliveInterval
    }
    if (merged.type === 'ssh' || merged.type === 'sftp') {
      if (merged.savedPassword && merged.sessionId) {
        const pw = await keychain.getPassword(merged.sessionId)
        if (pw) merged.password = pw
      }
      if (!merged.username) merged.username = st.ssh.defaultUser || process.env.USER
    }
    return terminals.open(merged, sshHooks)
  })
  handle('term:write', (id, dataB64) => terminals.write(id, dataB64))
  handle('term:resize', (id, cols, rows) => terminals.resize(id, cols, rows))
  handle('term:close', (id) => terminals.close(id))
  handle('term:list', () => terminals.list())
  handle('term:broadcast', (ids, dataB64) => terminals.broadcast(ids, dataB64))

  // --- local files
  handle('files:local-list', (dir) => files.localList(dir))
  handle('files:local-roots', () => files.localRoots())
  handle('files:local-mkdir', (dir, name) => files.localMkdir(dir, name))
  handle('files:local-remove', (targets) => files.localRemove(targets))
  handle('files:local-rename', (from, to) => files.localRename(from, to))
  handle('files:local-home', () => os.homedir())
  handle('files:reveal', (p) => { shell.showItemInFolder(p); return true })
  handle('files:open-external', (p) => shell.openPath(p))

  // --- SFTP
  handle('sftp:home', (connId) => files.remoteHome(connId))
  handle('sftp:list', (connId, dir) => files.remoteList(connId, dir))
  handle('sftp:mkdir', (connId, dir, name) => files.remoteMkdir(connId, dir, name))
  handle('sftp:remove', (connId, targets) => files.remoteRemove(connId, targets))
  handle('sftp:rename', (connId, from, to) => files.remoteRename(connId, from, to))
  handle('sftp:chmod', (connId, target, mode) => files.remoteChmod(connId, target, mode))
  handle('sftp:read', (connId, target) => files.remoteReadFile(connId, target))
  handle('sftp:write', (connId, target, text) => files.remoteWriteFile(connId, target, text))
  handle('sftp:upload', (connId, localPaths, remoteDir) => files.upload(connId, localPaths, remoteDir))
  handle('sftp:download', (connId, remotePaths, localDir) => files.download(connId, remotePaths, localDir))
  handle('sftp:pick-download-dir', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Download to…', properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  handle('sftp:pick-upload-files', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Upload…', properties: ['openFile', 'openDirectory', 'multiSelections'] })
    return r.canceled ? [] : r.filePaths
  })
  handle('transfers:list', () => files.listTransfers())
  handle('transfers:cancel', (id, scope) => files.cancel(id, scope))
  handle('transfers:cancel-all', () => files.cancelAll())

  // --- tunnels
  handle('tunnel:add', async (connId, spec) => {
    const conn = ssh.getConn(connId)
    if (!conn) throw new Error('connection is gone')
    const t = { ...spec, id: spec.id || `tn-${Date.now().toString(36)}` }
    if (t.kind === 'remote') return conn.addRemoteForward(t)
    if (t.kind === 'dynamic') return conn.addDynamicForward(t)
    return conn.addLocalForward(t)
  })
  handle('tunnel:remove', (connId, tunnelId) => {
    const conn = ssh.getConn(connId)
    if (!conn) throw new Error('connection is gone')
    return conn.removeTunnel(tunnelId)
  })
  handle('tunnel:list', (connId) => {
    const conn = ssh.getConn(connId)
    if (!conn) return []
    return [...conn.tunnels.values()].map((t) => ({ ...t.spec, state: 'listening' }))
  })

  // --- delegated protocols
  handle('open:rdp', (spec) => tools.openRdp(spec))
  handle('open:vnc', (spec) => tools.openVnc(spec))
  handle('open:ftp', (spec) => tools.openFtp(spec))
  handle('open:browser', (spec) => tools.openBrowser(spec))
  handle('x11:status', () => tools.x11Status())
  handle('x11:start', () => tools.startX11())

  // --- tools
  handle('tools:netstat', () => tools.netstat())
  handle('tools:ports', () => tools.listeningPorts())
  handle('tools:netscan', (opts) => tools.netscan({
    ...opts,
    onProgress: (done, total) => send('netscan:progress', { done, total })
  }))
  handle('tools:sysinfo', () => tools.hwInfo())
  handle('tools:processes', () => tools.processList())
  handle('tools:packages', () => tools.packageStatus())
  handle('tools:brew', (args) => tools.brew(args))
  handle('tools:keygen', (opts) => tools.generateKey(opts))
  handle('tools:list-keys', () => tools.listLocalKeys())
  handle('tools:known-hosts', () => ssh.listKnownHosts())
  handle('tools:forget-host', (host, port) => { ssh.forgetHostKey(host, port); return true })
  handle('tools:pick-key', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Select private key',
      defaultPath: path.join(os.homedir(), '.ssh'),
      properties: ['openFile', 'showHiddenFiles']
    })
    return r.canceled ? null : r.filePaths[0]
  })
  handle('tools:serial-devices', () => {
    try {
      return fs.readdirSync('/dev')
        .filter((n) => n.startsWith('tty.') || n.startsWith('cu.'))
        .map((n) => `/dev/${n}`)
        .sort()
    } catch { return [] }
  })

  // --- macros
  handle('macros:save', (m) => settings.saveMacro(m))
  handle('macros:delete', (id) => settings.deleteMacro(id))

  // --- misc
  handle('term:save-output', async (suggestedName, text) => {
    const r = await dialog.showSaveDialog(win, {
      title: 'Save terminal output',
      defaultPath: path.join(app.getPath('downloads'), suggestedName),
      filters: [{ name: 'Text', extensions: ['txt', 'log'] }]
    })
    if (r.canceled || !r.filePath) return { cancelled: true }
    fs.writeFileSync(r.filePath, text, 'utf8')
    return { file: r.filePath, bytes: Buffer.byteLength(text, 'utf8') }
  })

  handle('clipboard:read', () => clipboard.readText())
  handle('clipboard:write', (text) => { clipboard.writeText(text); return true })
  handle('shell:open-external', (url) => {
    if (!/^(https?|mailto|vnc|rdp|ftp|sftp):/i.test(url)) throw new Error('blocked URL scheme')
    return shell.openExternal(url)
  })
  handle('app:confirm', async ({ title, message, detail, buttons, defaultId }) => {
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      title: title || 'Gonds',
      message: message || '',
      detail,
      buttons: buttons || ['Cancel', 'OK'],
      defaultId: defaultId ?? 1,
      cancelId: 0
    })
    return r.response
  })
  handle('app:paths', () => ({
    home: os.homedir(),
    userData: app.getPath('userData'),
    downloads: app.getPath('downloads'),
    appPath: app.getAppPath()
  }))
}

// ------------------------------------------------------------------- boot ----

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus() }
  })

  app.whenReady().then(() => {
    const userData = app.getPath('userData')
    fs.mkdirSync(userData, { recursive: true })
    settings.init(userData)
    sessions.init(userData)
    ssh.init(userData)
    terminals.init(send)
    files.init(send, askConflict, () => settings.get().transfers.overwritePolicy)
    nativeTheme.themeSource = settings.get().ui.theme === 'light' ? 'light' : 'dark'
    registerIpc()
    buildMenu()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => app.quit())

  app.on('before-quit', () => {
    terminals.closeAll()
    ssh.closeAll()
  })
}
