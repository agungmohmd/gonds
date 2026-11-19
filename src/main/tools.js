'use strict'
// Network/system tools, and delegation of RDP / VNC / X11 to the macOS clients
// that already implement those protocols properly.
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')

// Lazy so this module stays loadable outside Electron (the self-check runs in plain node).
const openUrl = (url) => require('electron').shell.openExternal(url)

function run (file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', timeout: opts.timeout || 20000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout || '', stderr: stderr || (err ? err.message : '') }))
  })
}

// ---------------------------------------------------------------- netstat ----

async function netstat () {
  const { stdout } = await run('/usr/sbin/netstat', ['-an', '-p', 'tcp'])
  const rows = []
  for (const line of stdout.split('\n')) {
    const m = /^(tcp\d?)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(\S*)/.exec(line.trim())
    if (!m) continue
    rows.push({ proto: m[1], local: m[4], remote: m[5], state: m[6] || '' })
  }
  return rows
}

/** Listening sockets with the owning process. */
async function listeningPorts () {
  const { stdout, ok, stderr } = await run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'])
  if (!ok && !stdout) return { rows: [], error: stderr }
  const rows = []
  const lines = stdout.split('\n').slice(1)
  for (const line of lines) {
    const f = line.trim().split(/\s+/)
    if (f.length < 9) continue
    const addr = f[8]
    const portM = /:(\d+)$/.exec(addr)
    rows.push({
      command: f[0],
      pid: Number(f[1]),
      user: f[2],
      address: addr,
      port: portM ? Number(portM[1]) : null
    })
  }
  rows.sort((a, b) => (a.port || 0) - (b.port || 0))
  return { rows }
}

// ---------------------------------------------------------------- netscan ----

const COMMON_PORTS = [22, 80, 443, 3389, 5900, 21, 23, 25, 53, 110, 143, 445, 3306, 5432, 6379, 8080, 8443, 9000, 27017]

function probe (host, port, timeout) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    let done = false
    const finish = (open) => { if (!done) { done = true; sock.destroy(); resolve(open) } }
    sock.setTimeout(timeout)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
    sock.connect(port, host)
  })
}

/**
 * Scan a /24-style range for open ports. `cidr` accepts "192.168.1.0/24" or
 * "192.168.1.1-192.168.1.60".
 * trade-off: IPv4 only, max 1024 hosts, TCP connect scan. Enough to find boxes
 * on a LAN; it is not nmap and does not claim to be.
 */
async function netscan ({ range, ports, timeout = 400, concurrency = 128, onProgress }) {
  const hosts = expandRange(range)
  if (!hosts.length) throw new Error(`cannot parse range: ${range}`)
  if (hosts.length > 1024) throw new Error(`range covers ${hosts.length} hosts; limit is 1024`)
  const portList = (ports && ports.length ? ports : COMMON_PORTS).map(Number).filter((n) => n > 0 && n < 65536)

  const jobs = []
  for (const h of hosts) for (const p of portList) jobs.push([h, p])

  const found = new Map()
  let completed = 0
  let cursor = 0

  const worker = async () => {
    while (cursor < jobs.length) {
      const [h, p] = jobs[cursor++]
      const open = await probe(h, p, timeout)
      completed++
      if (open) {
        if (!found.has(h)) found.set(h, { host: h, ports: [] })
        found.get(h).ports.push(p)
      }
      if (onProgress && completed % 32 === 0) onProgress(completed, jobs.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker))
  if (onProgress) onProgress(jobs.length, jobs.length)

  const results = [...found.values()]
  results.forEach((r) => r.ports.sort((a, b) => a - b))
  results.sort((a, b) => cmpIp(a.host, b.host))
  // Reverse-resolve only the hosts that answered.
  await Promise.all(results.map(async (r) => {
    try {
      const names = await require('node:dns').promises.reverse(r.host)
      r.hostname = names[0] || null
    } catch { r.hostname = null }
  }))
  return { hosts: results, scanned: hosts.length, probes: jobs.length }
}

function ipToInt (ip) {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0
}
function intToIp (n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.') }
function cmpIp (a, b) { return (ipToInt(a) || 0) - (ipToInt(b) || 0) }

function expandRange (range) {
  const s = String(range || '').trim()
  const cidr = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(s)
  if (cidr) {
    const base = ipToInt(cidr[1])
    const bits = Number(cidr[2])
    if (base == null || bits < 8 || bits > 32) return []
    const size = 2 ** (32 - bits)
    const start = (base & (0xffffffff << (32 - bits))) >>> 0
    const out = []
    // Skip network and broadcast for /31 and wider.
    const from = size > 2 ? start + 1 : start
    const to = size > 2 ? start + size - 2 : start + size - 1
    for (let i = from; i <= to; i++) out.push(intToIp(i >>> 0))
    return out
  }
  const dash = /^(\d+\.\d+\.\d+\.\d+)\s*-\s*(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (dash) {
    const a = ipToInt(dash[1]); const b = ipToInt(dash[2])
    if (a == null || b == null || b < a) return []
    const out = []
    for (let i = a; i <= b; i++) out.push(intToIp(i))
    return out
  }
  const short = /^(\d+\.\d+\.\d+)\.(\d+)\s*-\s*(\d+)$/.exec(s)
  if (short) {
    const out = []
    for (let i = Number(short[2]); i <= Number(short[3]); i++) out.push(`${short[1]}.${i}`)
    return out
  }
  if (ipToInt(s) != null) return [s]
  return []
}

// ------------------------------------------------------------ system info ----

async function hwInfo () {
  const [hw, os_] = await Promise.all([
    run('/usr/sbin/system_profiler', ['SPHardwareDataType', '-json'], { timeout: 30000 }),
    run('/usr/bin/sw_vers', [])
  ])
  let model = null
  try { model = JSON.parse(hw.stdout).SPHardwareDataType?.[0] || null } catch {}
  return {
    hostname: os.hostname(),
    platform: `${process.platform} ${os.release()}`,
    swVers: os_.stdout.trim(),
    arch: process.arch,
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model,
    totalMem: os.totalmem(),
    freeMem: os.freemem(),
    uptime: os.uptime(),
    model,
    interfaces: Object.entries(os.networkInterfaces()).map(([name, addrs]) => ({
      name,
      addresses: (addrs || []).filter((a) => !a.internal).map((a) => `${a.address}/${a.family}`)
    })).filter((i) => i.addresses.length)
  }
}

async function processList () {
  const { stdout } = await run('/bin/ps', ['-Ao', 'pid,ppid,%cpu,%mem,user,comm'])
  const rows = []
  for (const line of stdout.split('\n').slice(1)) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!m) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]), mem: Number(m[4]), user: m[5], command: m[6] })
  }
  rows.sort((a, b) => b.cpu - a.cpu)
  return rows
}

// -------------------------------------------------------------- delegation ----

const RDP_APPS = [
  '/Applications/Windows App.app',
  '/Applications/Microsoft Remote Desktop.app'
]

function findRdpApp () {
  return RDP_APPS.find((p) => fs.existsSync(p)) || null
}

/** Open an RDP session using the installed macOS RDP client. */
async function openRdp (spec) {
  const host = spec.host
  if (!host) throw new Error('RDP: host required')
  const app = findRdpApp()
  // rdp:// URL scheme understood by Windows App / Microsoft Remote Desktop.
  const q = new URLSearchParams()
  q.set('full address', `s:${host}:${spec.port || 3389}`)
  if (spec.username) q.set('username', `s:${spec.username}`)
  if (spec.domain) q.set('domain', `s:${spec.domain}`)
  if (spec.fullscreen) q.set('screen mode id', 'i:2')
  const url = `rdp://${q.toString().replace(/&/g, '&')}`
  if (!app) {
    return { delegated: false, app: null, url, hint: 'Install “Windows App” from the Mac App Store to open RDP sessions.' }
  }
  await openUrl(url)
  return { delegated: true, app: path.basename(app, '.app'), url }
}

/** Open a VNC session with the built-in Screen Sharing client. */
async function openVnc (spec) {
  if (!spec.host) throw new Error('VNC: host required')
  const auth = spec.username ? `${encodeURIComponent(spec.username)}@` : ''
  const url = `vnc://${auth}${spec.host}:${spec.port || 5900}`
  await openUrl(url)
  return { delegated: true, app: 'Screen Sharing', url }
}

const XQUARTZ = '/Applications/Utilities/XQuartz.app'

function x11Status () {
  const installed = fs.existsSync(XQUARTZ)
  const display = process.env.DISPLAY || null
  // XQuartz's launchd socket is the real signal that a server is reachable.
  const sockets = (() => {
    try {
      return fs.readdirSync('/private/tmp')
        .filter((d) => d.startsWith('com.apple.launchd.'))
        .some((d) => { try { return fs.readdirSync(path.join('/private/tmp', d)).some((f) => f.startsWith('org.xquartz')) } catch { return false } })
    } catch { return false }
  })()
  return { installed, display, running: sockets || Boolean(display), path: installed ? XQUARTZ : null }
}

async function startX11 () {
  const st = x11Status()
  if (!st.installed) {
    return { started: false, hint: 'XQuartz is not installed. brew install --cask xquartz' }
  }
  await run('/usr/bin/open', ['-a', XQUARTZ])
  return { started: true, app: 'XQuartz' }
}

async function openBrowser (spec) {
  const url = spec.url || `https://${spec.host}${spec.port && spec.port !== 443 ? ':' + spec.port : ''}`
  await openUrl(url)
  return { delegated: true, url }
}

/** Open an FTP location in Finder (read-only) — macOS has no writable FTP mount. */
async function openFtp (spec) {
  const auth = spec.username ? `${encodeURIComponent(spec.username)}@` : ''
  const url = `ftp://${auth}${spec.host}:${spec.port || 21}`
  await openUrl(url)
  return { delegated: true, app: 'Finder', url, hint: 'Finder mounts FTP read-only. Use an SFTP session for read/write.' }
}

// ------------------------------------------------------- package front-end ----

function brewPath () {
  for (const p of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) if (fs.existsSync(p)) return p
  return null
}

async function brew (args) {
  const bin = brewPath()
  if (!bin) return { ok: false, stdout: '', stderr: 'Homebrew is not installed (https://brew.sh)' }
  return run(bin, args, { timeout: 120000 })
}

/** CLI tools this app can use but macOS does not ship, mapped to Homebrew. */
const SUGGESTED_PACKAGES = [
  { name: 'mosh', formula: 'mosh', why: 'roaming SSH sessions' },
  { name: 'telnet', formula: 'telnet', why: 'telnet sessions (removed from macOS)' },
  { name: 'rsh', formula: 'inetutils', why: 'rlogin/rsh clients' },
  { name: 'rsync', formula: 'rsync', why: 'faster directory sync than SFTP' },
  { name: 'sshpass', formula: 'sshpass', why: 'non-interactive password auth for scripts' },
  { name: 'xquartz', formula: 'xquartz', cask: true, why: 'X11 server for X11 forwarding' },
  { name: 'tmux', formula: 'tmux', why: 'persistent remote sessions' },
  { name: 'nmap', formula: 'nmap', why: 'real network scanning' },
  { name: 'iperf3', formula: 'iperf3', why: 'throughput testing' }
]

async function packageStatus () {
  const bin = brewPath()
  const out = []
  for (const p of SUGGESTED_PACKAGES) {
    let installed = false
    if (p.cask) installed = fs.existsSync('/Applications/Utilities/XQuartz.app') || fs.existsSync('/Applications/XQuartz.app')
    else installed = Boolean(require('./terminals').which(p.name))
    out.push({ ...p, installed })
  }
  return { brew: Boolean(bin), brewPath: bin, packages: out }
}

// ------------------------------------------------------------------ keygen ----

const sshKeygen = '/usr/bin/ssh-keygen'

async function generateKey ({ type = 'ed25519', bits, comment, file, passphrase = '' }) {
  if (!['ed25519', 'rsa', 'ecdsa'].includes(type)) throw new Error(`unsupported key type: ${type}`)
  const target = file || path.join(os.homedir(), '.ssh', `id_${type}_gonds`)
  if (fs.existsSync(target)) throw new Error(`${target} already exists`)
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const args = ['-t', type, '-f', target, '-N', passphrase, '-C', comment || `${os.userInfo().username}@${os.hostname()}`]
  if (type === 'rsa') args.push('-b', String(bits || 4096))
  if (type === 'ecdsa') args.push('-b', String(bits || 521))
  const r = await run(sshKeygen, args, { timeout: 60000 })
  if (!r.ok) throw new Error(r.stderr || 'ssh-keygen failed')
  return {
    privateKey: target,
    publicKey: `${target}.pub`,
    publicKeyText: fs.readFileSync(`${target}.pub`, 'utf8').trim(),
    fingerprint: (await run(sshKeygen, ['-lf', `${target}.pub`])).stdout.trim()
  }
}

function listLocalKeys () {
  const dir = path.join(os.homedir(), '.ssh')
  let names = []
  try { names = fs.readdirSync(dir) } catch { return [] }
  return names
    .filter((n) => n.endsWith('.pub'))
    .map((n) => {
      const priv = path.join(dir, n.slice(0, -4))
      return fs.existsSync(priv) ? { privateKey: priv, publicKey: path.join(dir, n), name: n.slice(0, -4) } : null
    })
    .filter(Boolean)
}

module.exports = {
  run, netstat, listeningPorts, netscan, expandRange, hwInfo, processList,
  openRdp, openVnc, openBrowser, openFtp, x11Status, startX11,
  brew, brewPath, packageStatus, generateKey, listLocalKeys,
  ipToInt, intToIp
}
