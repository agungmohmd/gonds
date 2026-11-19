'use strict'
// Terminal registry. Every tab's byte stream — local pty or SSH channel — is
// reduced to the same { write, resize, kill } handle so the renderer has one
// code path for all session types.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const pty = require('node-pty')
const ssh = require('./ssh')

const terms = new Map() // termId -> handle
let seq = 0
let send = () => {}

function init (sender) { send = sender }

function nextId () { return `t${++seq}` }

function loginShell () {
  if (process.env.SHELL && fs.existsSync(process.env.SHELL)) return process.env.SHELL
  // trade-off: dscl is the authoritative source on macOS; /bin/zsh is the 10.15+ default.
  try {
    const out = execFileSync('/usr/bin/dscl', ['.', '-read', `/Users/${os.userInfo().username}`, 'UserShell'], { encoding: 'utf8' })
    const m = /UserShell:\s*(\S+)/.exec(out)
    if (m && fs.existsSync(m[1])) return m[1]
  } catch {}
  return '/bin/zsh'
}

function baseEnv (extra) {
  const env = { ...process.env, ...(extra || {}) }
  env.TERM = env.TERM || 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'Gonds'
  // Electron injects these; they confuse child processes.
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  return env
}

function which (bin) {
  for (const dir of (process.env.PATH || '').split(':').concat(['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin'])) {
    if (!dir) continue
    const p = path.join(dir, bin)
    try { fs.accessSync(p, fs.constants.X_OK); return p } catch {}
  }
  return null
}

/** Spawn a local pty running `file args`. */
function spawnPty (id, file, args, opts) {
  const p = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: opts.cols || 80,
    rows: opts.rows || 24,
    cwd: opts.cwd || os.homedir(),
    env: baseEnv(opts.env),
    encoding: null // raw bytes; the renderer decodes UTF-8 incrementally
  })
  const handle = {
    id,
    kind: 'pty',
    write: (d) => p.write(Buffer.isBuffer(d) ? d : Buffer.from(d, 'utf8')),
    resize: (cols, rows) => { try { p.resize(cols, rows) } catch {} },
    kill: () => { try { p.kill() } catch {} },
    proc: p
  }
  p.onData((data) => send('term:data', { id, data: Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data, 'utf8').toString('base64') }))
  p.onExit(({ exitCode, signal }) => {
    send('term:exit', { id, exitCode, signal })
    terms.delete(id)
  })
  terms.set(id, handle)
  return handle
}

const HOST_RE = /^[A-Za-z0-9._:-]+$/ // guards against argv injection in delegated commands

function requireHost (host) {
  if (!host || !HOST_RE.test(host)) throw new Error(`invalid host: ${host || '(empty)'}`)
  return host
}

/**
 * Open a terminal for a session spec.
 * Returns { id, kind, connId? }.
 */
async function open (spec, hooks) {
  const id = nextId()
  const type = spec.type || 'ssh'

  if (type === 'shell') {
    const file = spec.command ? (which(spec.command.split(' ')[0]) || spec.command.split(' ')[0]) : loginShell()
    const args = spec.command ? spec.command.split(' ').slice(1) : ['-l']
    spawnPty(id, file, args, { ...spec, cwd: spec.cwd })
    return { id, kind: 'pty' }
  }

  if (type === 'serial') {
    const dev = spec.device
    if (!dev || !dev.startsWith('/dev/')) throw new Error('serial: device must be a /dev path')
    if (!fs.existsSync(dev)) throw new Error(`serial: ${dev} not present`)
    const screen = which('screen')
    if (!screen) throw new Error('serial: /usr/bin/screen not found')
    // trade-off: screen already speaks tty — no serialport native module needed.
    spawnPty(id, screen, [dev, String(spec.baud || 9600)], spec)
    return { id, kind: 'pty' }
  }

  if (type === 'telnet' || type === 'rlogin') {
    const host = requireHost(spec.host)
    const bin = which(type)
    if (bin) {
      const args = type === 'telnet'
        ? [host, String(spec.port || 23)]
        : (spec.username ? ['-l', spec.username, host] : [host])
      spawnPty(id, bin, args, spec)
      return { id, kind: 'pty' }
    }
    // macOS dropped telnet/rlogin in 10.13. nc carries the byte stream for the
    // common case (no option negotiation).
    const nc = which('nc')
    if (!nc) throw new Error(`${type}: neither ${type} nor nc is installed (brew install telnet)`)
    spawnPty(id, nc, [host, String(spec.port || (type === 'telnet' ? 23 : 513))], spec)
    return { id, kind: 'pty', degraded: `${type} not installed; using nc (no option negotiation)` }
  }

  if (type === 'mosh') {
    const host = requireHost(spec.host)
    const mosh = which('mosh')
    if (!mosh) throw new Error('mosh not installed (brew install mosh)')
    const args = []
    if (spec.port && spec.port !== 22) args.push('--ssh', `ssh -p ${spec.port}`)
    args.push(spec.username ? `${spec.username}@${host}` : host)
    spawnPty(id, mosh, args, spec)
    return { id, kind: 'pty' }
  }

  if (type === 'ssh' || type === 'sftp') {
    const conn = await ssh.connect(spec, hooks)
    if (type === 'sftp') {
      // SFTP-only tab: no shell channel, the file panel owns the connection.
      terms.set(id, {
        id,
        kind: 'sftp',
        connId: conn.id,
        write: () => {},
        resize: () => {},
        kill: () => ssh.close(conn.id)
      })
      return { id, kind: 'sftp', connId: conn.id }
    }

    const stream = await conn.shell({ cols: spec.cols, rows: spec.rows })
    terms.set(id, {
      id,
      kind: 'ssh',
      connId: conn.id,
      write: (d) => stream.write(Buffer.isBuffer(d) ? d : Buffer.from(d, 'utf8')),
      resize: (cols, rows) => { try { stream.setWindow(rows, cols, 0, 0) } catch {} },
      kill: () => { try { stream.end() } catch {}; ssh.close(conn.id) },
      stream
    })
    stream.on('data', (data) => send('term:data', { id, data: data.toString('base64') }))
    stream.stderr?.on('data', (data) => send('term:data', { id, data: data.toString('base64') }))
    stream.on('close', (code, signal) => {
      send('term:exit', { id, exitCode: code ?? 0, signal })
      terms.delete(id)
      ssh.close(conn.id)
    })

    if (spec.initCommands) {
      for (const line of String(spec.initCommands).split('\n')) {
        if (line.trim()) stream.write(line + '\n')
      }
    }
    return { id, kind: 'ssh', connId: conn.id }
  }

  throw new Error(`terminal: type "${type}" has no local terminal (it is delegated)`)
}

function write (id, dataB64) {
  const t = terms.get(id)
  if (!t) return false
  t.write(Buffer.from(dataB64, 'base64'))
  return true
}

function resize (id, cols, rows) {
  const t = terms.get(id)
  if (!t) return false
  t.resize(cols, rows)
  return true
}

function close (id) {
  const t = terms.get(id)
  if (!t) return false
  t.kill()
  terms.delete(id)
  return true
}

function closeAll () {
  for (const id of [...terms.keys()]) close(id)
}

function get (id) { return terms.get(id) }
function list () { return [...terms.values()].map((t) => ({ id: t.id, kind: t.kind, connId: t.connId })) }

/** Broadcast keystrokes to several terminals (Broadcast). */
function broadcast (ids, dataB64) {
  let n = 0
  for (const id of ids) if (write(id, dataB64)) n++
  return n
}

module.exports = { init, open, write, resize, close, closeAll, get, list, broadcast, which }
