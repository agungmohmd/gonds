'use strict'
const { contextBridge, ipcRenderer, webUtils } = require('electron')

/** Unwraps main's { ok, data, error } envelope so callers can just await. */
async function call (channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args)
  if (!res) throw new Error(`${channel}: no response`)
  if (!res.ok) throw new Error(res.error)
  return res.data
}

const listeners = new Map()
function on (channel, fn) {
  const wrapped = (_e, payload) => fn(payload)
  if (!listeners.has(channel)) listeners.set(channel, new Set())
  listeners.get(channel).add(wrapped)
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
    listeners.get(channel)?.delete(wrapped)
  }
}

contextBridge.exposeInMainWorld('mx', {
  settings: {
    get: () => call('settings:get'),
    patch: (p) => call('settings:patch', p),
    reset: () => call('settings:reset'),
    theme: (name) => call('settings:theme', name),
    hotkeys: () => call('settings:hotkeys'),
    setHotkeys: (map) => call('settings:set-hotkeys', map),
    setOpenTabs: (tabs) => call('settings:set-open-tabs', tabs)
  },
  sessions: {
    get: () => call('sessions:get'),
    save: (node, parentId) => call('sessions:save', node, parentId),
    remove: (id) => call('sessions:delete', id),
    move: (id, parentId, index) => call('sessions:move', id, parentId, index),
    duplicate: (id) => call('sessions:duplicate', id),
    import: () => call('sessions:import'),
    importSshConfig: () => call('sessions:import-ssh-config'),
    export: () => call('sessions:export')
  },
  secret: {
    set: (account, secret) => call('secret:set', account, secret),
    get: (account) => call('secret:get', account),
    remove: (account) => call('secret:delete', account),
    list: () => call('secret:list')
  },
  term: {
    open: (spec) => call('term:open', spec),
    write: (id, dataB64) => call('term:write', id, dataB64),
    resize: (id, cols, rows) => call('term:resize', id, cols, rows),
    close: (id) => call('term:close', id),
    list: () => call('term:list'),
    broadcast: (ids, dataB64) => call('term:broadcast', ids, dataB64),
    saveOutput: (name, text) => call('term:save-output', name, text)
  },
  files: {
    localList: (dir) => call('files:local-list', dir),
    localRoots: () => call('files:local-roots'),
    localMkdir: (dir, name) => call('files:local-mkdir', dir, name),
    localRemove: (targets) => call('files:local-remove', targets),
    localRename: (from, to) => call('files:local-rename', from, to),
    home: () => call('files:local-home'),
    reveal: (p) => call('files:reveal', p),
    openExternal: (p) => call('files:open-external', p)
  },
  sftp: {
    home: (c) => call('sftp:home', c),
    list: (c, dir) => call('sftp:list', c, dir),
    mkdir: (c, dir, name) => call('sftp:mkdir', c, dir, name),
    remove: (c, targets) => call('sftp:remove', c, targets),
    rename: (c, from, to) => call('sftp:rename', c, from, to),
    chmod: (c, target, mode) => call('sftp:chmod', c, target, mode),
    read: (c, target) => call('sftp:read', c, target),
    write: (c, target, text) => call('sftp:write', c, target, text),
    upload: (c, localPaths, remoteDir) => call('sftp:upload', c, localPaths, remoteDir),
    download: (c, remotePaths, localDir) => call('sftp:download', c, remotePaths, localDir),
    pickDownloadDir: () => call('sftp:pick-download-dir'),
    pickUploadFiles: () => call('sftp:pick-upload-files')
  },
  transfers: {
    list: () => call('transfers:list'),
    cancel: (id, scope) => call('transfers:cancel', id, scope),
    cancelAll: () => call('transfers:cancel-all')
  },
  tunnel: {
    add: (connId, spec) => call('tunnel:add', connId, spec),
    remove: (connId, tunnelId) => call('tunnel:remove', connId, tunnelId),
    list: (connId) => call('tunnel:list', connId)
  },
  open: {
    rdp: (spec) => call('open:rdp', spec),
    vnc: (spec) => call('open:vnc', spec),
    ftp: (spec) => call('open:ftp', spec),
    browser: (spec) => call('open:browser', spec),
    external: (url) => call('shell:open-external', url)
  },
  x11: { status: () => call('x11:status'), start: () => call('x11:start') },
  tools: {
    netstat: () => call('tools:netstat'),
    ports: () => call('tools:ports'),
    netscan: (opts) => call('tools:netscan', opts),
    sysinfo: () => call('tools:sysinfo'),
    processes: () => call('tools:processes'),
    packages: () => call('tools:packages'),
    brew: (args) => call('tools:brew', args),
    keygen: (opts) => call('tools:keygen', opts),
    listKeys: () => call('tools:list-keys'),
    knownHosts: () => call('tools:known-hosts'),
    forgetHost: (host, port) => call('tools:forget-host', host, port),
    pickKey: () => call('tools:pick-key'),
    serialDevices: () => call('tools:serial-devices')
  },
  macros: {
    save: (m) => call('macros:save', m),
    remove: (id) => call('macros:delete', id)
  },
  clipboard: {
    read: () => call('clipboard:read'),
    write: (text) => call('clipboard:write', text)
  },
  app: {
    confirm: (opts) => call('app:confirm', opts),
    paths: () => call('app:paths')
  },
  // Electron 32 removed File.path; this is the supported replacement.
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) } catch { return null }
  },
  // Answer a main-process prompt (password, passphrase, host key, kbd-interactive).
  reply: (id, value) => ipcRenderer.invoke('prompt:reply', { id, value }),
  on
})
