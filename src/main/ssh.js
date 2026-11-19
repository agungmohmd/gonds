'use strict'
// SSH connection manager: interactive shells, SFTP, port forwarding, jump hosts.
// One ssh2 Client per session instance; the SFTP panel and any tunnels share
// it, so a tab costs exactly one connection.
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const crypto = require('node:crypto')
const { Client, utils: sshUtils } = require('ssh2')

const conns = new Map() // connId -> Connection

let knownHostsPath = null
let knownHosts = {}

function init (userDataDir) {
  knownHostsPath = path.join(userDataDir, 'known_hosts.json')
  try {
    knownHosts = JSON.parse(fs.readFileSync(knownHostsPath, 'utf8'))
  } catch {
    knownHosts = {}
  }
}

function saveKnownHosts () {
  if (!knownHostsPath) return
  fs.writeFileSync(knownHostsPath, JSON.stringify(knownHosts, null, 2))
}

function fingerprint (keyBuf) {
  const b64 = crypto.createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '')
  return `SHA256:${b64}`
}

function hostKeyId (host, port) { return `${host}:${port || 22}` }

function forgetHostKey (host, port) {
  delete knownHosts[hostKeyId(host, port)]
  saveKnownHosts()
}

function listKnownHosts () {
  return Object.entries(knownHosts).map(([k, v]) => ({ host: k, ...v }))
}

let connSeq = 0

class Connection {
  constructor (spec, hooks) {
    this.id = `c${++connSeq}`
    this.spec = spec
    this.hooks = hooks
    this.client = null
    this.sftp = null
    this.tunnels = new Map() // tunnelId -> { spec, server|null }
    this.parents = [] // jump-host Connections we own and must tear down
    this.closed = false
    this.authCancelled = false
  }

  async open () {
    const chain = Array.isArray(this.spec.jumpHosts) ? this.spec.jumpHosts.filter(Boolean) : []
    let sock = null

    // Walk the jump-host chain: each hop is a real SSH connection whose
    // forwardOut channel becomes the transport for the next hop.
    let prev = null
    for (const hop of chain) {
      const hopSpec = typeof hop === 'string' ? parseHop(hop) : hop
      const hopConn = new Connection({ ...hopSpec, jumpHosts: [], _isJump: true }, this.hooks)
      hopConn.inboundSock = prev ? await prev.forward(hopSpec.host, hopSpec.port || 22) : null
      await hopConn.connect(hopConn.inboundSock)
      this.parents.push(hopConn)
      prev = hopConn
    }
    if (prev) sock = await prev.forward(this.spec.host, this.spec.port || 22)

    await this.connect(sock)
    return this
  }

  forward (host, port) {
    return new Promise((resolve, reject) => {
      this.client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
        if (err) return reject(new Error(`jump host ${this.spec.host}: ${err.message}`))
        resolve(stream)
      })
    })
  }

  connect (sock) {
    const spec = this.spec
    return new Promise((resolve, reject) => {
      const client = new Client()
      this.client = client
      let settled = false
      const fail = (err) => { if (!settled) { settled = true; reject(err) } }

      client.on('ready', () => { settled = true; resolve() })
      client.on('error', (err) => {
        const e = this.authCancelled && /authentication methods failed/i.test(err.message)
          ? new Error('authentication cancelled')
          : err
        fail(e)
        if (settled && !this.closed) this.hooks.onError?.(this.id, e.message)
      })
      client.on('close', () => {
        if (!this.closed) { this.closed = true; this.hooks.onClose?.(this.id) }
      })
      client.on('banner', (msg) => this.hooks.onBanner?.(this.id, msg))

      client.on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
        this.hooks.askKeyboardInteractive(this.id, { name, instructions: instr, prompts })
          .then((answers) => finish(answers || []))
          .catch(() => finish([]))
      })

      const username = spec.username || process.env.USER
      const connectCfg = {
        host: spec.host,
        port: spec.port || 22,
        username,
        sock: sock || undefined,
        readyTimeout: (spec.connectTimeout || 20) * 1000,
        keepaliveInterval: spec.keepalive === false ? 0 : (spec.keepaliveInterval || 30) * 1000,
        keepaliveCountMax: 3,
        compress: spec.compression ? 'force' : false,
        agentForward: Boolean(spec.agentForward),
        hostVerifier: (keyBuf, cb) => this.verify(keyBuf).then(cb, () => cb(false)),
        authHandler: this.authHandler(spec, username)
      }

      if (spec.algorithms) connectCfg.algorithms = spec.algorithms

      client.connect(connectCfg)
    })
  }

  /**
   * Drive authentication one method at a time, the way OpenSSH does.
   *
   * The point of doing this lazily rather than stuffing every credential into
   * the connect config: a configured ssh-agent used to suppress the password
   * prompt entirely, so an account the agent holds no key for simply failed
   * with "All configured authentication methods failed" and no way to type a
   * password. Here each method is offered in turn, and the user is only asked
   * for a secret at the moment the server actually wants one.
   */
  authHandler (spec, username) {
    const done = new Set()
    let passwordTries = 0
    const MAX_PASSWORD_TRIES = 3

    return (methodsLeft, partialSuccess, callback) => {
      // methodsLeft is null on the first call, before the server has told us.
      const offered = (m) => !methodsLeft || methodsLeft.includes(m)
      const once = (m) => { if (done.has(m)) return false; done.add(m); return true }

      const run = async () => {
        // 'none' both probes the server's method list and succeeds outright on
        // hosts that ask for nothing.
        if (once('none')) return { type: 'none', username }

        if (offered('publickey') && spec.privateKey && once('publickey')) {
          const keyPath = spec.privateKey.replace(/^~/, process.env.HOME || '~')
          let keyData
          try {
            keyData = fs.readFileSync(keyPath)
          } catch (err) {
            this.hooks.onError?.(this.id, `cannot read private key ${keyPath}: ${err.message}`)
            return null
          }
          let passphrase = spec.passphrase
          const parsed = sshUtils.parseKey(keyData, passphrase)
          if (parsed instanceof Error && /passphrase|encrypted/i.test(parsed.message)) {
            passphrase = await this.hooks.askPassphrase(this.id, keyPath)
            if (passphrase == null) { this.authCancelled = true; return false }
          }
          return { type: 'publickey', username, key: keyData, passphrase: passphrase || undefined }
        }

        if (offered('publickey') && spec.useAgent !== false && process.env.SSH_AUTH_SOCK && once('agent')) {
          return { type: 'agent', username, agent: process.env.SSH_AUTH_SOCK }
        }

        if (offered('password') && passwordTries < MAX_PASSWORD_TRIES) {
          passwordTries++
          // A password stored in the Keychain gets one shot before we ask.
          if (spec.password && passwordTries === 1) {
            return { type: 'password', username, password: spec.password }
          }
          const pw = await this.hooks.askPassword(this.id, {
            ...spec,
            retry: passwordTries > 1,
            attempt: passwordTries
          })
          if (pw == null) { this.authCancelled = true; return false }
          return { type: 'password', username, password: pw }
        }

        if (offered('keyboard-interactive') && once('keyboard-interactive')) {
          return { type: 'keyboard-interactive', username }
        }

        return false // nothing left to try
      }

      run().then(
        (next) => callback(next === null ? false : next),
        () => callback(false)
      )
    }
  }

  async verify (keyBuf) {
    const id = hostKeyId(this.spec.host, this.spec.port)
    const fp = fingerprint(keyBuf)
    const known = knownHosts[id]
    if (known && known.fingerprint === fp) return true

    const verdict = await this.hooks.verifyHostKey(this.id, {
      host: this.spec.host,
      port: this.spec.port || 22,
      fingerprint: fp,
      changed: Boolean(known),
      previousFingerprint: known ? known.fingerprint : null
    })
    if (verdict === 'accept-always') {
      knownHosts[id] = { fingerprint: fp, addedAt: new Date().toISOString() }
      saveKnownHosts()
      return true
    }
    return verdict === 'accept-once'
  }

  shell (opts) {
    return new Promise((resolve, reject) => {
      const window = { cols: opts.cols || 80, rows: opts.rows || 24, term: opts.term || 'xterm-256color' }
      const ptyOpts = { ...window }
      const env = {}
      if (this.spec.env) Object.assign(env, this.spec.env)
      const shellOpts = Object.keys(env).length ? { env } : {}
      if (this.spec.x11Forward) shellOpts.x11 = true

      this.client.shell(ptyOpts, shellOpts, (err, stream) => {
        if (err) return reject(err)
        resolve(stream)
      })
    })
  }


  getSftp () {
    if (this.sftp) return Promise.resolve(this.sftp)
    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) return reject(err)
        this.sftp = sftp
        sftp.on('close', () => { this.sftp = null })
        resolve(sftp)
      })
    })
  }

  /** Local -> remote forward. Listens locally, pipes each client over SSH. */
  addLocalForward (t) {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        this.client.forwardOut(t.bindAddress || '127.0.0.1', t.localPort, t.remoteHost, t.remotePort, (err, stream) => {
          if (err) { socket.destroy(); this.hooks.onTunnelError?.(this.id, t.id, err.message); return }
          socket.pipe(stream).pipe(socket)
          stream.on('error', () => socket.destroy())
          socket.on('error', () => stream.end())
        })
      })
      server.on('error', reject)
      server.listen(t.localPort, t.bindAddress || '127.0.0.1', () => {
        this.tunnels.set(t.id, { spec: t, server })
        resolve({ ...t, state: 'listening', actualPort: server.address().port })
      })
    })
  }

  /** Remote -> local forward. Asks the server to listen. */
  addRemoteForward (t) {
    return new Promise((resolve, reject) => {
      this.client.forwardIn(t.bindAddress || '0.0.0.0', t.remotePort, (err, port) => {
        if (err) return reject(err)
        this.tunnels.set(t.id, { spec: { ...t, remotePort: port }, server: null })
        resolve({ ...t, remotePort: port, state: 'listening' })
      })
    })
  }

  /** Dynamic SOCKS5 forward (ssh -D). */
  addDynamicForward (t) {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => socks5(socket, (host, port, done) => {
        this.client.forwardOut('127.0.0.1', t.localPort, host, port, (err, stream) => {
          if (err) return done(err)
          done(null, stream)
        })
      }))
      server.on('error', reject)
      server.listen(t.localPort, t.bindAddress || '127.0.0.1', () => {
        this.tunnels.set(t.id, { spec: t, server })
        resolve({ ...t, state: 'listening' })
      })
    })
  }

  removeTunnel (tunnelId) {
    const t = this.tunnels.get(tunnelId)
    if (!t) return false
    if (t.server) t.server.close()
    else this.client.unforwardIn(t.spec.bindAddress || '0.0.0.0', t.spec.remotePort, () => {})
    this.tunnels.delete(tunnelId)
    return true
  }

  end () {
    this.closed = true
    for (const id of [...this.tunnels.keys()]) this.removeTunnel(id)
    try { this.client?.end() } catch {}
    for (const p of this.parents.reverse()) p.end()
  }
}

function parseHop (str) {
  // user@host:port
  const m = /^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/.exec(str.trim())
  if (!m) throw new Error(`invalid jump host: ${str}`)
  return { username: m[1] || undefined, host: m[2], port: m[3] ? Number(m[3]) : 22 }
}

/** Minimal SOCKS5 CONNECT server used by dynamic forwards. */
function socks5 (socket, connect) {
  let stage = 0
  let buf = Buffer.alloc(0)
  socket.on('error', () => socket.destroy())
  socket.on('data', onData)

  function onData (chunk) {
    buf = Buffer.concat([buf, chunk])
    if (stage === 0) {
      if (buf.length < 2) return
      const nMethods = buf[1]
      if (buf.length < 2 + nMethods) return
      buf = buf.subarray(2 + nMethods)
      socket.write(Buffer.from([0x05, 0x00])) // no auth
      stage = 1
      if (buf.length) onData(Buffer.alloc(0))
      return
    }
    if (stage === 1) {
      if (buf.length < 5) return
      if (buf[1] !== 0x01) { socket.write(Buffer.from([0x05, 0x07, 0, 1, 0, 0, 0, 0, 0, 0])); return socket.end() }
      const atyp = buf[3]
      let host, offset
      if (atyp === 0x01) {
        if (buf.length < 10) return
        host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`; offset = 8
      } else if (atyp === 0x03) {
        const len = buf[4]
        if (buf.length < 5 + len + 2) return
        host = buf.subarray(5, 5 + len).toString('utf8'); offset = 5 + len
      } else if (atyp === 0x04) {
        if (buf.length < 22) return
        const parts = []
        for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(4 + i).toString(16))
        host = parts.join(':'); offset = 20
      } else {
        socket.write(Buffer.from([0x05, 0x08, 0, 1, 0, 0, 0, 0, 0, 0])); return socket.end()
      }
      const port = buf.readUInt16BE(offset)
      const rest = buf.subarray(offset + 2)
      stage = 2
      socket.removeListener('data', onData)
      connect(host, port, (err, stream) => {
        if (err) {
          socket.write(Buffer.from([0x05, 0x05, 0, 1, 0, 0, 0, 0, 0, 0]))
          return socket.end()
        }
        socket.write(Buffer.from([0x05, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]))
        if (rest.length) stream.write(rest)
        socket.pipe(stream).pipe(socket)
        stream.on('error', () => socket.destroy())
      })
    }
  }
}

async function connect (spec, hooks) {
  const c = new Connection(spec, hooks)
  conns.set(c.id, c)
  try {
    await c.open()
  } catch (err) {
    conns.delete(c.id)
    c.end()
    throw err
  }
  return c
}

function getConn (id) { return conns.get(id) }

function close (id) {
  const c = conns.get(id)
  if (!c) return false
  c.end()
  conns.delete(id)
  return true
}

function closeAll () {
  for (const id of [...conns.keys()]) close(id)
}

module.exports = {
  init, connect, getConn, close, closeAll, fingerprint, parseHop,
  forgetHostKey, listKnownHosts, socks5
}
