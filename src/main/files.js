'use strict'
// Dual-pane file browser backend: local fs on the left, SFTP on the right.
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const ssh = require('./ssh')

function modeString (mode, isDir, isLink) {
  const t = isLink ? 'l' : isDir ? 'd' : '-'
  const bits = ['r', 'w', 'x']
  let s = ''
  for (let shift = 6; shift >= 0; shift -= 3) {
    const v = (mode >> shift) & 7
    for (let b = 0; b < 3; b++) s += (v & (4 >> b)) ? bits[b] : '-'
  }
  return t + s
}

// ------------------------------------------------------------------ local ----

async function localList (dir) {
  const target = path.resolve(dir || os.homedir())
  const entries = await fsp.readdir(target, { withFileTypes: true })
  const out = []
  for (const e of entries) {
    const full = path.join(target, e.name)
    let st = null
    try { st = await fsp.lstat(full) } catch { continue }
    const isLink = st.isSymbolicLink()
    let isDir = st.isDirectory()
    if (isLink) {
      try { isDir = (await fsp.stat(full)).isDirectory() } catch {}
    }
    out.push({
      name: e.name,
      path: full,
      isDir,
      isLink,
      size: st.size,
      mtime: st.mtimeMs,
      mode: st.mode & 0o7777,
      modeString: modeString(st.mode, isDir, isLink),
      hidden: e.name.startsWith('.')
    })
  }
  out.sort(sortEntries)
  return { path: target, parent: path.dirname(target) === target ? null : path.dirname(target), entries: out }
}

function sortEntries (a, b) {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
}

async function localMkdir (dir, name) {
  await fsp.mkdir(path.join(dir, name))
  return true
}

async function localRemove (targets) {
  for (const t of targets) await fsp.rm(t, { recursive: true, force: true })
  return true
}

async function localRename (from, to) {
  await fsp.rename(from, to)
  return true
}

function localRoots () {
  const home = os.homedir()
  const roots = [
    { name: 'Home', path: home },
    { name: 'Desktop', path: path.join(home, 'Desktop') },
    { name: 'Documents', path: path.join(home, 'Documents') },
    { name: 'Downloads', path: path.join(home, 'Downloads') },
    { name: '/', path: '/' },
    { name: '/Volumes', path: '/Volumes' }
  ]
  return roots.filter((r) => fs.existsSync(r.path))
}

// ------------------------------------------------------------------- SFTP ----

function sftpOf (connId) {
  const conn = ssh.getConn(connId)
  if (!conn) throw new Error('SFTP: connection is gone')
  return conn.getSftp()
}

function p (fn) {
  return new Promise((resolve, reject) => fn((err, res) => (err ? reject(err) : resolve(res))))
}

async function remoteHome (connId) {
  const sftp = await sftpOf(connId)
  return p((cb) => sftp.realpath('.', cb))
}

async function remoteList (connId, dir) {
  const sftp = await sftpOf(connId)
  const target = await p((cb) => sftp.realpath(dir && dir.length ? dir : '.', cb))
  const list = await p((cb) => sftp.readdir(target, cb))
  const out = list.map((e) => {
    const isLink = (e.attrs.mode & 0o170000) === 0o120000
    const isDir = (e.attrs.mode & 0o170000) === 0o040000
    return {
      name: e.filename,
      path: posixJoin(target, e.filename),
      isDir,
      isLink,
      size: e.attrs.size,
      mtime: e.attrs.mtime * 1000,
      mode: e.attrs.mode & 0o7777,
      modeString: e.longname ? e.longname.slice(0, 10) : modeString(e.attrs.mode, isDir, isLink),
      owner: e.attrs.uid,
      group: e.attrs.gid,
      hidden: e.filename.startsWith('.')
    }
  })
  // Symlinks report their own type; resolve directory-ness so navigation works.
  await Promise.all(out.filter((e) => e.isLink).map(async (e) => {
    try {
      const st = await p((cb) => sftp.stat(e.path, cb))
      e.isDir = st.isDirectory()
    } catch {}
  }))
  out.sort(sortEntries)
  const parent = target === '/' ? null : posixDirname(target)
  return { path: target, parent, entries: out }
}

function posixJoin (a, b) { return a.endsWith('/') ? a + b : `${a}/${b}` }
function posixDirname (t) {
  const trimmed = t.replace(/\/+$/, '')
  const i = trimmed.lastIndexOf('/')
  return i <= 0 ? '/' : trimmed.slice(0, i)
}

async function remoteMkdir (connId, dir, name) {
  const sftp = await sftpOf(connId)
  await p((cb) => sftp.mkdir(posixJoin(dir, name), cb))
  return true
}

async function remoteRemove (connId, targets) {
  const sftp = await sftpOf(connId)
  for (const t of targets) await rmrf(sftp, t)
  return true
}

async function rmrf (sftp, target) {
  let st
  try { st = await p((cb) => sftp.lstat(target, cb)) } catch { return }
  if (st.isDirectory()) {
    const kids = await p((cb) => sftp.readdir(target, cb))
    for (const k of kids) await rmrf(sftp, posixJoin(target, k.filename))
    await p((cb) => sftp.rmdir(target, cb))
  } else {
    await p((cb) => sftp.unlink(target, cb))
  }
}

async function remoteRename (connId, from, to) {
  const sftp = await sftpOf(connId)
  await p((cb) => sftp.rename(from, to, cb))
  return true
}

async function remoteChmod (connId, target, mode) {
  const sftp = await sftpOf(connId)
  await p((cb) => sftp.chmod(target, mode, cb))
  return true
}

async function remoteReadFile (connId, target, maxBytes = 2 * 1024 * 1024) {
  const sftp = await sftpOf(connId)
  const st = await p((cb) => sftp.stat(target, cb))
  if (st.size > maxBytes) throw new Error(`file is ${fmtBytes(st.size)} — too large to edit in place (limit ${fmtBytes(maxBytes)})`)
  const buf = await new Promise((resolve, reject) => {
    const chunks = []
    const rs = sftp.createReadStream(target)
    rs.on('data', (c) => chunks.push(c))
    rs.on('error', reject)
    rs.on('end', () => resolve(Buffer.concat(chunks)))
  })
  return buf.toString('utf8')
}

async function remoteWriteFile (connId, target, text) {
  const sftp = await sftpOf(connId)
  await new Promise((resolve, reject) => {
    const ws = sftp.createWriteStream(target)
    ws.on('error', reject)
    ws.on('close', resolve)
    ws.end(Buffer.from(text, 'utf8'))
  })
  return true
}

function fmtBytes (n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${i === 0 ? n : n.toFixed(1)} ${u[i]}`
}

// -------------------------------------------------------------- transfers ----

let xferSeq = 0
let batchSeq = 0
const transfers = new Map()
const batches = new Map()
let send = () => {}
let ask = async () => ({ action: 'overwrite' })
let policy = () => 'ask'

/**
 * @param sender    emit an IPC event to the renderer
 * @param asker     ask the renderer to resolve a filename conflict
 * @param getPolicy returns settings.transfers.overwritePolicy
 */
function init (sender, asker, getPolicy) {
  send = sender
  if (asker) ask = asker
  if (getPolicy) policy = getPolicy
}

function emit (t) {
  send('transfer:update', {
    id: t.id,
    batchId: t.batchId,
    direction: t.direction,
    name: t.name,
    from: t.from,
    to: t.to,
    bytes: t.bytes,
    total: t.total,
    state: t.state,
    error: t.error || null
  })
}

class Cancelled extends Error {
  constructor () { super('cancelled'); this.cancelled = true }
}

function newTransfer (batch, name, from, to, total) {
  const t = { id: `x${++xferSeq}`, batchId: batch.id, direction: batch.direction, name, from, to, bytes: 0, total, state: 'running' }
  transfers.set(t.id, t)
  batch.current = t
  emit(t)
  return t
}

function finish (t, err) {
  t.state = err ? (err.cancelled ? 'cancelled' : 'error') : 'done'
  if (err && !err.cancelled) t.error = err.message
  emit(t)
  setTimeout(() => transfers.delete(t.id), 60000)
}

function newBatch (direction) {
  const b = { id: `b${++batchSeq}`, direction, cancelled: false, current: null, overwriteAll: null, abort: null }
  batches.set(b.id, b)
  return b
}

/**
 * Cancel an in-flight transfer. `scope: 'batch'` also drops everything still
 * queued behind it, which is what the user means when a 500-file drag was a
 * mistake.
 */
function cancel (id, scope = 'batch') {
  const t = transfers.get(id)
  const b = t ? batches.get(t.batchId) : batches.get(id)
  if (!b) return false
  if (scope === 'batch' || !t) b.cancelled = true
  b.abort?.()
  return true
}

function cancelAll () {
  let n = 0
  for (const b of batches.values()) {
    if (!b.cancelled) { b.cancelled = true; b.abort?.(); n++ }
  }
  return n
}

/**
 * Decide what to do about an existing destination.
 * Returns 'overwrite' | 'skip' | 'cancel' | a replacement path.
 * trade-off: one decision per batch once the user says "apply to all" — a
 * 500-file directory must not raise 500 dialogs.
 */
async function resolveConflict (batch, info) {
  if (batch.overwriteAll) return applyChoice(batch.overwriteAll, info)
  const configured = policy()
  if (configured && configured !== 'ask') return applyChoice(configured, info)

  const answer = await ask({
    direction: batch.direction,
    name: info.name,
    path: info.dest,
    incomingSize: info.incomingSize,
    existingSize: info.existingSize,
    existingMtime: info.existingMtime
  })
  const choice = (answer && answer.action) || 'cancel'
  if (answer && answer.applyToAll) batch.overwriteAll = choice
  return applyChoice(choice, info)
}

function applyChoice (choice, info) {
  if (choice === 'cancel') return 'cancel'
  if (choice === 'skip') return 'skip'
  if (choice === 'rename') return info.freePath
  return 'overwrite'
}

/** `report.txt` -> `report (1).txt`: first candidate `exists` rejects. */
function freeName (exists, dest) {
  const slash = Math.max(dest.lastIndexOf('/'), dest.lastIndexOf(path.sep))
  const dot = dest.lastIndexOf('.')
  const hasExt = dot > slash + 1
  const stem = hasExt ? dest.slice(0, dot) : dest
  const ext = hasExt ? dest.slice(dot) : ''
  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem} (${i})${ext}`
    if (!exists(candidate)) return candidate
  }
  return `${stem} (${Date.now()})${ext}`
}

/** Recursively walk a local tree into a flat file list. */
async function walkLocal (root) {
  const files = []
  const dirs = []
  const base = path.dirname(root)
  const visit = async (abs) => {
    const st = await fsp.lstat(abs)
    const rel = path.relative(base, abs)
    if (st.isSymbolicLink()) return // trade-off: symlinks are not followed in transfers
    if (st.isDirectory()) {
      dirs.push(rel)
      for (const e of await fsp.readdir(abs)) await visit(path.join(abs, e))
    } else if (st.isFile()) {
      files.push({ abs, rel, size: st.size })
    }
  }
  await visit(root)
  return { files, dirs }
}

async function walkRemote (sftp, root) {
  const files = []
  const dirs = []
  const base = posixDirname(root)
  const visit = async (abs) => {
    const st = await p((cb) => sftp.lstat(abs, cb))
    const rel = abs.startsWith(base + '/') ? abs.slice(base.length + 1) : path.posix.basename(abs)
    if ((st.mode & 0o170000) === 0o120000) return
    if (st.isDirectory()) {
      dirs.push(rel)
      const kids = await p((cb) => sftp.readdir(abs, cb))
      for (const k of kids) await visit(posixJoin(abs, k.filename))
    } else {
      files.push({ abs, rel, size: st.size })
    }
  }
  await visit(root)
  return { files, dirs }
}

/** Pipe one stream into another: abortable, and reports progress. */
function pump (batch, t, makeRead, makeWrite) {
  return new Promise((resolve, reject) => {
    const rs = makeRead()
    const ws = makeWrite()
    let settled = false
    const done = (err) => {
      if (settled) return
      settled = true
      batch.abort = null
      err ? reject(err) : resolve()
    }
    batch.abort = () => {
      try { rs.destroy() } catch {}
      try { ws.destroy() } catch {}
      done(new Cancelled())
    }
    rs.on('data', (c) => { t.bytes += c.length; throttleEmit(t) })
    rs.on('error', done)
    ws.on('error', done)
    ws.on('close', () => done())
    rs.pipe(ws)
  })
}

async function runBatch (batch, items, h) {
  const results = []
  for (const item of items) {
    if (batch.cancelled) { results.push({ ok: false, path: item.dest, cancelled: true }); continue }

    let dest = item.dest
    const existing = await h.stat(dest)
    if (existing) {
      const verdict = await resolveConflict(batch, {
        name: item.rel,
        dest,
        incomingSize: item.size,
        existingSize: existing.size,
        existingMtime: existing.mtime,
        freePath: freeName(h.existsSync, dest)
      })
      if (verdict === 'cancel') {
        batch.cancelled = true
        results.push({ ok: false, path: dest, cancelled: true })
        continue
      }
      if (verdict === 'skip') { results.push({ ok: true, path: dest, skipped: true }); continue }
      if (verdict !== 'overwrite') dest = verdict
    }

    const t = newTransfer(batch, item.rel, item.src, dest, item.size)
    try {
      await h.transfer(item, dest, t)
      finish(t)
      results.push({ ok: true, path: dest })
    } catch (err) {
      finish(t, err)
      results.push({ ok: false, path: dest, error: err.message, cancelled: Boolean(err.cancelled) })
      if (err.cancelled) batch.cancelled = true
    }
  }
  batch.current = null
  setTimeout(() => batches.delete(batch.id), 60000)
  return results
}

async function upload (connId, localPaths, remoteDir) {
  const sftp = await sftpOf(connId)
  const batch = newBatch('upload')
  const items = []
  for (const lp of localPaths) {
    const { files, dirs } = await walkLocal(lp)
    for (const d of dirs) {
      try { await p((cb) => sftp.mkdir(toPosix(posixJoin(remoteDir, d)), cb)) } catch {}
    }
    for (const f of files) items.push({ rel: f.rel, src: f.abs, size: f.size, dest: toPosix(posixJoin(remoteDir, f.rel)) })
  }

  // SFTP has no synchronous stat, so remember the names this batch has already
  // claimed and let freeName() consult that instead.
  const claimed = new Set()
  const results = await runBatch(batch, items, {
    stat: async (dest) => {
      try {
        const st = await p((cb) => sftp.stat(dest, cb))
        return { size: st.size, mtime: st.mtime * 1000 }
      } catch { return null }
    },
    existsSync: (candidate) => claimed.has(candidate),
    transfer: (item, dest, t) => {
      claimed.add(dest)
      return pump(batch, t, () => fs.createReadStream(item.src), () => sftp.createWriteStream(dest))
    }
  })
  return { batchId: batch.id, results }
}

async function download (connId, remotePaths, localDir) {
  const sftp = await sftpOf(connId)
  const batch = newBatch('download')
  const items = []
  for (const rp of remotePaths) {
    const { files, dirs } = await walkRemote(sftp, rp)
    for (const d of dirs) await fsp.mkdir(path.join(localDir, d), { recursive: true })
    for (const f of files) items.push({ rel: f.rel, src: f.abs, size: f.size, dest: path.join(localDir, f.rel) })
  }

  const results = await runBatch(batch, items, {
    stat: async (dest) => {
      try {
        const st = await fsp.stat(dest)
        return { size: st.size, mtime: st.mtimeMs }
      } catch { return null }
    },
    existsSync: (candidate) => fs.existsSync(candidate),
    transfer: async (item, dest, t) => {
      await fsp.mkdir(path.dirname(dest), { recursive: true })
      return pump(batch, t, () => sftp.createReadStream(item.src), () => fs.createWriteStream(dest))
    }
  })
  return { batchId: batch.id, results }
}

// trade-off: 100 ms progress floor — the renderer cannot paint faster and a
// 4 KB-chunk stream would otherwise flood IPC.
const lastEmit = new Map()
function throttleEmit (t) {
  const now = Date.now()
  if (now - (lastEmit.get(t.id) || 0) < 100 && t.bytes < t.total) return
  lastEmit.set(t.id, now)
  emit(t)
}

function toPosix (s) { return s.split(path.sep).join('/') }

function listTransfers () {
  return [...transfers.values()].map((t) => ({ ...t }))
}

module.exports = {
  init, modeString, fmtBytes, sortEntries,
  localList, localMkdir, localRemove, localRename, localRoots,
  remoteHome, remoteList, remoteMkdir, remoteRemove, remoteRename, remoteChmod,
  remoteReadFile, remoteWriteFile,
  upload, download, cancel, cancelAll, listTransfers,
  posixJoin, posixDirname, walkLocal, freeName
}
