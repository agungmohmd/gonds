'use strict'
// Throwaway in-process SSH server for the smoke run: password auth, an echoing
// shell, and a read-only SFTP subsystem backed by a real temp directory.
// Exists so SSH/SFTP can be verified end to end without touching a real host.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const net = require('node:net')
const { execFileSync } = require('node:child_process')
const { Server, utils } = require('ssh2')

const { OPEN_MODE, STATUS_CODE } = utils.sftp

const USER = 'smoke'
const PASS = 'smokepass'

function makeHostKey (dir) {
  const keyPath = path.join(dir, 'host_ed25519')
  execFileSync('/usr/bin/ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-q'])
  const pem = fs.readFileSync(keyPath)
  const parsed = utils.parseKey(pem)
  if (parsed instanceof Error) throw parsed
  return { pem, publicSSH: parsed.getPublicSSH() }
}

function attrsFor (st) {
  return {
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000)
  }
}

/**
 * Start the fixture. Returns { port, publicSSH, root, close() }.
 * `root` is a temp tree the SFTP side serves.
 */
function start () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gonds-sshfix-'))
  const root = path.join(dir, 'root')
  fs.mkdirSync(path.join(root, 'etc'), { recursive: true })
  fs.writeFileSync(path.join(root, 'readme.txt'), 'hello from the fixture\n')
  fs.writeFileSync(path.join(root, 'etc', 'motd'), 'fixture motd\n')

  const { pem, publicSSH } = makeHostKey(dir)
  const handles = new Map()
  let handleSeq = 0
  const tcpipRequests = []

  // Upstream target for tunnel tests: echoes whatever it is sent.
  const echo = net.createServer((s) => s.pipe(s))

  const server = new Server({ hostKeys: [pem] }, (client) => {
    // Offers publickey as well as password, and accepts no key at all. That is
    // the shape of a stock sshd, and the shape that used to leave a user with
    // an ssh-agent configured unable to reach the password prompt.
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === USER && ctx.password === PASS) return ctx.accept()
      ctx.reject(['publickey', 'password'])
    })

    client.on('ready', () => {
      // direct-tcpip: what `ssh -L` and `-D` ride on. Connects for real, so a
      // forward can be proven end to end against a local echo server.
      client.on('tcpip', (accept, reject, info) => {
        tcpipRequests.push(`${info.destIP}:${info.destPort}`)
        const upstream = net.connect(info.destPort, info.destIP)
        upstream.on('error', () => { try { reject() } catch {} })
        upstream.on('connect', () => {
          const chan = accept()
          chan.pipe(upstream).pipe(chan)
          chan.on('error', () => upstream.destroy())
        })
      })

      client.on('session', (acceptSession) => {
        const session = acceptSession()
        session.on('pty', (accept) => accept && accept())
        session.on('window-change', (accept) => accept && accept())

        session.on('shell', (accept) => {
          const stream = accept()
          stream.write('fixture shell ready\r\n$ ')
          let line = ''
          stream.on('data', (chunk) => {
            const text = chunk.toString('utf8')
            stream.write(text) // echo, like a real tty
            line += text
            if (/[\r\n]/.test(text)) {
              const cmd = line.replace(/[\r\n]+$/, '').trim()
              line = ''
              // Only echo is implemented — nothing is executed.
              const m = /^echo\s+(.*)$/.exec(cmd)
              stream.write('\r\n' + (m ? m[1] : cmd ? `sh: ${cmd}: not found` : '') + '\r\n$ ')
            }
          })
        })

        session.on('sftp', (accept) => {
          const sftp = accept()
          const resolve = (p) => {
            const abs = path.resolve(root, '.' + path.posix.resolve('/', p))
            return abs.startsWith(root) ? abs : root
          }

          sftp.on('REALPATH', (reqid, p) => {
            const abs = resolve(p)
            const shown = '/' + path.relative(root, abs)
            sftp.name(reqid, [{ filename: shown === '/.' ? '/' : shown.replace(/\/$/, '') || '/', longname: shown, attrs: {} }])
          })

          sftp.on('OPENDIR', (reqid, p) => {
            const abs = resolve(p)
            if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
            const h = Buffer.from(String(++handleSeq))
            handles.set(h.toString(), { abs, done: false })
            sftp.handle(reqid, h)
          })

          sftp.on('READDIR', (reqid, h) => {
            const st = handles.get(h.toString())
            if (!st) return sftp.status(reqid, STATUS_CODE.FAILURE)
            if (st.done) return sftp.status(reqid, STATUS_CODE.EOF)
            st.done = true
            const names = fs.readdirSync(st.abs).map((name) => {
              const s = fs.lstatSync(path.join(st.abs, name))
              return { filename: name, longname: `${s.isDirectory() ? 'd' : '-'}rw-r--r-- 1 u g ${s.size} x ${name}`, attrs: attrsFor(s) }
            })
            sftp.name(reqid, names)
          })

          const statHandler = (reqid, p) => {
            const abs = resolve(p)
            if (!fs.existsSync(abs)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
            sftp.attrs(reqid, attrsFor(fs.lstatSync(abs)))
          }
          sftp.on('STAT', statHandler)
          sftp.on('LSTAT', statHandler)
          // ssh2's createReadStream issues FSTAT on the open handle.
          sftp.on('FSTAT', (reqid, h) => {
            const st = handles.get(h.toString())
            if (!st) return sftp.status(reqid, STATUS_CODE.FAILURE)
            sftp.attrs(reqid, attrsFor(fs.lstatSync(st.abs)))
          })

          sftp.on('OPEN', (reqid, p, flags) => {
            const abs = resolve(p)
            const h = Buffer.from(String(++handleSeq))
            if (flags & (OPEN_MODE.WRITE | OPEN_MODE.CREAT | OPEN_MODE.TRUNC)) {
              try {
                const fd = fs.openSync(abs, (flags & OPEN_MODE.APPEND) ? 'a' : 'w')
                handles.set(h.toString(), { abs, fd })
                return sftp.handle(reqid, h)
              } catch { return sftp.status(reqid, STATUS_CODE.FAILURE) }
            }
            if (!fs.existsSync(abs)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
            handles.set(h.toString(), { abs, data: fs.readFileSync(abs) })
            sftp.handle(reqid, h)
          })

          sftp.on('READ', (reqid, h, offset, length) => {
            const st = handles.get(h.toString())
            if (!st || !st.data) return sftp.status(reqid, STATUS_CODE.FAILURE)
            if (offset >= st.data.length) return sftp.status(reqid, STATUS_CODE.EOF)
            sftp.data(reqid, st.data.subarray(offset, offset + length))
          })

          sftp.on('WRITE', (reqid, h, offset, data) => {
            const st = handles.get(h.toString())
            if (!st || st.fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE)
            try {
              fs.writeSync(st.fd, data, 0, data.length, offset)
              sftp.status(reqid, STATUS_CODE.OK)
            } catch { sftp.status(reqid, STATUS_CODE.FAILURE) }
          })

          sftp.on('CLOSE', (reqid, h) => {
            const st = handles.get(h.toString())
            if (st && st.fd !== undefined) { try { fs.closeSync(st.fd) } catch {} }
            handles.delete(h.toString())
            sftp.status(reqid, STATUS_CODE.OK)
          })

          const okOr = (reqid, fn) => {
            try { fn(); sftp.status(reqid, STATUS_CODE.OK) } catch { sftp.status(reqid, STATUS_CODE.FAILURE) }
          }
          sftp.on('MKDIR', (reqid, p) => okOr(reqid, () => fs.mkdirSync(resolve(p))))
          sftp.on('RMDIR', (reqid, p) => okOr(reqid, () => fs.rmdirSync(resolve(p))))
          sftp.on('REMOVE', (reqid, p) => okOr(reqid, () => fs.unlinkSync(resolve(p))))
          sftp.on('RENAME', (reqid, from, to) => okOr(reqid, () => fs.renameSync(resolve(from), resolve(to))))
          sftp.on('SETSTAT', (reqid, p, attrs) => okOr(reqid, () => {
            if (attrs.mode !== undefined) fs.chmodSync(resolve(p), attrs.mode & 0o7777)
          }))
          sftp.on('FSETSTAT', (reqid, h, attrs) => {
            const st = handles.get(h.toString())
            if (!st) return sftp.status(reqid, STATUS_CODE.FAILURE)
            okOr(reqid, () => { if (attrs.mode !== undefined) fs.chmodSync(st.abs, attrs.mode & 0o7777) })
          })
        })
      })
    })

    client.on('error', () => {})
  })

  return new Promise((resolve) => {
    echo.listen(0, '127.0.0.1', () => server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        echoPort: echo.address().port,
        host: '127.0.0.1',
        username: USER,
        password: PASS,
        publicSSH,
        root,
        tcpipRequests,
        close: () => new Promise((r) => {
          echo.close()
          server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); r() })
        })
      })
    }))
  })
}

module.exports = { start, USER, PASS }
