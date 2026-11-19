'use strict'
// Session tree persistence + CSV / ssh_config import.
const fs = require('node:fs')
const path = require('node:path')

const SESSION_TYPES = [
  'ssh', 'telnet', 'rlogin', 'mosh', 'serial', 'shell',
  'sftp', 'ftp', 'rdp', 'vnc', 'x11', 'browser'
]

const DEFAULT_PORTS = {
  ssh: 22, telnet: 23, rlogin: 513, mosh: 22, sftp: 22,
  ftp: 21, rdp: 3389, vnc: 5900, x11: 6000, browser: 443
}

let storePath = null
let tree = null

function defaults () {
  return {
    version: 1,
    nodes: [
      { id: 'folder-user', type: 'folder', name: 'User sessions', expanded: true, children: [] }
    ]
  }
}

function init (userDataDir) {
  storePath = path.join(userDataDir, 'sessions.json')
  try {
    tree = JSON.parse(fs.readFileSync(storePath, 'utf8'))
    if (!Array.isArray(tree.nodes)) throw new Error('bad shape')
  } catch {
    tree = defaults()
    persist()
  }
  return tree
}

function persist () {
  const tmp = storePath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(tree, null, 2))
  fs.renameSync(tmp, storePath) // atomic: a crash mid-write cannot truncate the store
}

function get () { return tree }

let seq = 0
function newId (prefix = 'n') {
  seq += 1
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}`
}

/** Depth-first walk yielding [node, parentArray, index]. */
function * walk (nodes = tree.nodes, parent = null) {
  for (let i = 0; i < nodes.length; i++) {
    yield [nodes[i], nodes, i, parent]
    if (nodes[i].children) yield * walk(nodes[i].children, nodes[i])
  }
}

function find (id) {
  for (const [node, arr, idx, parent] of walk()) {
    if (node.id === id) return { node, arr, idx, parent }
  }
  return null
}

function containerFor (parentId) {
  if (!parentId) return tree.nodes
  const hit = find(parentId)
  if (!hit) return tree.nodes
  if (hit.node.type !== 'folder') return hit.arr
  hit.node.children = hit.node.children || []
  return hit.node.children
}

/** Create or update a node. Returns the stored node. */
function save (node, parentId) {
  if (node.id) {
    const hit = find(node.id)
    if (hit) {
      Object.assign(hit.node, node)
      persist()
      return hit.node
    }
  }
  const created = { ...node, id: node.id || newId(node.type === 'folder' ? 'f' : 's') }
  if (created.type === 'folder') created.children = created.children || []
  containerFor(parentId).push(created)
  persist()
  return created
}

function remove (id) {
  const hit = find(id)
  if (!hit) return false
  hit.arr.splice(hit.idx, 1)
  persist()
  return true
}

/** Move `id` into `parentId` (null = root) at `index` (-1 = append). */
function move (id, parentId, index = -1) {
  const hit = find(id)
  if (!hit) return false
  if (id === parentId) return false
  // Refuse to move a folder into its own subtree.
  if (hit.node.children) {
    for (const [d] of walk(hit.node.children, hit.node)) {
      if (d.id === parentId) return false
    }
  }
  hit.arr.splice(hit.idx, 1)
  const target = containerFor(parentId)
  if (index < 0 || index > target.length) target.push(hit.node)
  else target.splice(index, 0, hit.node)
  persist()
  return true
}

function duplicate (id) {
  const hit = find(id)
  if (!hit) return null
  const clone = JSON.parse(JSON.stringify(hit.node))
  const reid = (n) => {
    n.id = newId(n.type === 'folder' ? 'f' : 's')
    if (n.children) n.children.forEach(reid)
  }
  reid(clone)
  clone.name = `${clone.name} (copy)`
  hit.arr.splice(hit.idx + 1, 0, clone)
  persist()
  return clone
}

function flatSessions (nodes = tree.nodes, out = []) {
  for (const n of nodes) {
    if (n.type === 'folder') flatSessions(n.children || [], out)
    else out.push(n)
  }
  return out
}

// ---------------------------------------------------------------- import ----

/**
 * Parse CSV with a header row. Recognised columns (case-insensitive):
 * name, type, host, port, username/user, folder, description.
 */
function parseCsv (text) {
  const warnings = []
  const rows = csvRows(text)
  if (!rows.length) return { nodes: [], warnings: ['CSV is empty'] }

  const header = rows[0].map((h) => h.trim().toLowerCase())
  const col = (...names) => {
    for (const n of names) {
      const i = header.indexOf(n)
      if (i >= 0) return i
    }
    return -1
  }
  const ix = {
    name: col('name', 'session', 'label'),
    type: col('type', 'protocol'),
    host: col('host', 'hostname', 'address', 'ip'),
    port: col('port'),
    user: col('username', 'user', 'login'),
    folder: col('folder', 'group', 'category'),
    desc: col('description', 'notes', 'comment')
  }
  if (ix.host < 0) return { nodes: [], warnings: ['CSV has no host/hostname column'] }

  const folders = new Map()
  const pick = (row, i) => (i >= 0 && row[i] !== undefined ? row[i].trim() : '')

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row.length || row.every((c) => !c.trim())) continue
    const host = pick(row, ix.host)
    if (!host) continue

    let type = pick(row, ix.type).toLowerCase() || 'ssh'
    if (!SESSION_TYPES.includes(type)) {
      warnings.push(`Row ${r + 1}: unknown type "${type}", imported as SSH`)
      type = 'ssh'
    }
    const folderName = pick(row, ix.folder) || 'Imported (CSV)'
    if (!folders.has(folderName)) {
      folders.set(folderName, { id: newId('f'), type: 'folder', name: folderName, expanded: true, children: [] })
    }
    const port = Number(pick(row, ix.port))
    folders.get(folderName).children.push({
      id: newId('s'),
      type,
      name: pick(row, ix.name) || host,
      host,
      port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORTS[type],
      username: pick(row, ix.user),
      description: pick(row, ix.desc),
      importedFrom: 'csv'
    })
  }
  return { nodes: [...folders.values()], warnings }
}

/** Minimal RFC4180 reader: quoted fields, escaped quotes, embedded newlines. */
function csvRows (text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
      continue
    }
    if (c === '"') { quoted = true; continue }
    if (c === ',') { row.push(field); field = ''; continue }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      rows.push(row); row = []
      continue
    }
    field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.length)
}

/** Parse OpenSSH config Host blocks into sessions. */
function parseSshConfig (text) {
  const out = []
  let cur = null
  const flush = () => {
    if (cur && cur.host) out.push(cur)
    cur = null
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(\S+)\s+(.*)$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    const val = m[2].trim()
    if (key === 'host') {
      flush()
      if (val.includes('*') || val.includes('?')) continue // patterns aren't sessions
      cur = { id: newId('s'), type: 'ssh', name: val.split(/\s+/)[0], host: val.split(/\s+/)[0], port: 22, username: '', importedFrom: 'ssh_config' }
      continue
    }
    if (!cur) continue
    if (key === 'hostname') cur.host = val
    else if (key === 'port') cur.port = Number(val) || 22
    else if (key === 'user') cur.username = val
    else if (key === 'identityfile') cur.privateKey = val.replace(/^~/, process.env.HOME || '~')
    else if (key === 'proxyjump') cur.jumpHosts = val.split(',').map((s) => s.trim()).filter(Boolean)
  }
  flush()
  if (!out.length) return { nodes: [], warnings: ['No concrete Host entries found'] }
  return {
    nodes: [{ id: newId('f'), type: 'folder', name: 'Imported (ssh_config)', expanded: true, children: out }],
    warnings: []
  }
}

function importText (text, format) {
  if (format !== 'csv' && format !== 'ssh_config') {
    throw new Error(`unsupported import format: ${format}`)
  }
  const parsed = format === 'csv' ? parseCsv(text) : parseSshConfig(text)
  let count = 0
  for (const folder of parsed.nodes) {
    tree.nodes.push(folder)
    count += (folder.children || []).length
  }
  if (count) persist()
  return { imported: count, folders: parsed.nodes.length, warnings: parsed.warnings }
}

/** Export the whole tree to CSV (flat, one row per session). */
function exportCsv () {
  const esc = (v) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = ['name,type,host,port,username,folder,description']
  const visit = (nodes, folder) => {
    for (const n of nodes) {
      if (n.type === 'folder') visit(n.children || [], n.name)
      else lines.push([n.name, n.type, n.host, n.port, n.username, folder, n.description].map(esc).join(','))
    }
  }
  visit(tree.nodes, '')
  return lines.join('\n') + '\n'
}

module.exports = {
  init, get, save, remove, move, duplicate, find, flatSessions, persist,
  importText, exportCsv, parseCsv, parseSshConfig, csvRows
}
