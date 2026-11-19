'use strict'
// trade-off: one runnable check for the logic that can actually be wrong —
// importers, range expansion, mode formatting, settings merge, SOCKS handshake.
// `npm test`. No framework.
const assert = require('node:assert')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gonds-test-'))
const sessions = require('../src/main/sessions')
const settings = require('../src/main/settings')
const files = require('../src/main/files')
const ssh = require('../src/main/ssh')
const tools = require('../src/main/tools')

let passed = 0
function test (name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`)
    process.exitCode = 1
  }
}

async function testAsync (name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`)
    process.exitCode = 1
  }
}

sessions.init(tmp)
settings.init(tmp)
ssh.init(tmp)

// ----------------------------------------------------------------- CSV ------
test('csv: header mapping + quoted fields with commas', () => {
  const csv = 'Name,Protocol,Hostname,Port,User,Group,Notes\n' +
    '"db, primary",ssh,10.0.0.1,2222,root,Databases,"say ""hi"""\n' +
    'cache,ssh,10.0.0.2,,redis,Databases,\n'
  const { nodes, warnings } = sessions.parseCsv(csv)
  assert.strictEqual(warnings.length, 0)
  assert.strictEqual(nodes.length, 1)
  assert.strictEqual(nodes[0].name, 'Databases')
  const [a, b] = nodes[0].children
  assert.strictEqual(a.name, 'db, primary')
  assert.strictEqual(a.port, 2222)
  assert.strictEqual(a.description, 'say "hi"')
  assert.strictEqual(b.port, 22, 'blank port should default')
})

test('csv: missing host column is rejected, not silently imported', () => {
  const { nodes, warnings } = sessions.parseCsv('name,type\nfoo,ssh\n')
  assert.strictEqual(nodes.length, 0)
  assert.ok(warnings[0].includes('host'))
})

test('csv: unknown protocol warns and imports as ssh', () => {
  const { nodes, warnings } = sessions.parseCsv('name,type,host\nx,quantum,10.0.0.1\n')
  assert.strictEqual(nodes[0].children[0].type, 'ssh')
  assert.ok(warnings[0].includes('quantum'))
})

test('csv: embedded newline inside quotes stays one row', () => {
  const rows = sessions.csvRows('a,b\n"line1\nline2",x\n')
  assert.strictEqual(rows.length, 2)
  assert.strictEqual(rows[1][0], 'line1\nline2')
})

// ---------------------------------------------------------- ssh_config ------
test('ssh_config: concrete hosts imported, wildcard patterns skipped', () => {
  const cfg = `Host *
  ServerAliveInterval 60

Host bastion
  HostName bastion.example.com
  User jump
  Port 2200

Host inner
  HostName 10.0.0.7
  User app
  IdentityFile ~/.ssh/app_key
  ProxyJump bastion
`
  const { nodes } = sessions.parseSshConfig(cfg)
  const kids = nodes[0].children
  assert.strictEqual(kids.length, 2, 'wildcard Host * must not become a session')
  assert.strictEqual(kids[0].host, 'bastion.example.com')
  assert.strictEqual(kids[0].port, 2200)
  assert.strictEqual(kids[1].username, 'app')
  assert.deepStrictEqual(kids[1].jumpHosts, ['bastion'])
  assert.ok(!kids[1].privateKey.startsWith('~'), 'tilde should be expanded')
})

// -------------------------------------------------------------- tree ops ----
test('tree: save / move / duplicate / remove', () => {
  const folder = sessions.save({ type: 'folder', name: 'F' })
  const s1 = sessions.save({ type: 'ssh', name: 'a', host: 'h1' })
  assert.ok(sessions.move(s1.id, folder.id, -1))
  const after = sessions.find(s1.id)
  assert.strictEqual(after.parent.id, folder.id)

  const copy = sessions.duplicate(s1.id)
  assert.notStrictEqual(copy.id, s1.id)
  assert.strictEqual(copy.name, 'a (copy)')

  assert.ok(sessions.remove(copy.id))
  assert.strictEqual(sessions.find(copy.id), null)
})

test('tree: a folder cannot be moved inside itself', () => {
  const outer = sessions.save({ type: 'folder', name: 'outer' })
  const inner = sessions.save({ type: 'folder', name: 'inner' }, outer.id)
  assert.strictEqual(sessions.move(outer.id, inner.id, -1), false)
  assert.strictEqual(sessions.move(outer.id, outer.id, -1), false)
})

test('tree: export round-trips through CSV import', () => {
  const csv = sessions.exportCsv()
  const { nodes } = sessions.parseCsv(csv)
  const flatBefore = sessions.flatSessions().length
  assert.ok(nodes.reduce((n, f) => n + f.children.length, 0) >= flatBefore - 1)
})

// -------------------------------------------------------------- settings ----
test('settings: deepMerge keeps untouched keys and replaces arrays', () => {
  const merged = settings.deepMerge({ a: { b: 1, c: 2 }, list: [1, 2] }, { a: { c: 9 }, list: [3] })
  assert.deepStrictEqual(merged, { a: { b: 1, c: 9 }, list: [3] })
})

test('settings: patch persists and survives re-init', () => {
  settings.patch({ terminal: { fontSize: 17 } })
  settings.init(tmp)
  assert.strictEqual(settings.get().terminal.fontSize, 17)
  assert.strictEqual(settings.get().terminal.scheme, 'Gonds Dark', 'unrelated keys must stay')
})

test('settings: every scheme defines the full 18-colour palette', () => {
  const keys = Object.keys(settings.SCHEMES.Console)
  for (const [name, scheme] of Object.entries(settings.SCHEMES)) {
    for (const k of keys) {
      assert.ok(/^#[0-9a-f]{6}$/i.test(scheme[k] || ''), `${name}.${k} is not a hex colour`)
    }
  }
})

test('settings: toXtermTheme maps PuTTY names to xterm names', () => {
  const t = settings.toXtermTheme('Dracula')
  assert.strictEqual(t.background, '#282a36')
  assert.strictEqual(t.brightRed, '#ff6e6e')
})

test('settings: macro save is idempotent on id', () => {
  const m = settings.saveMacro({ name: 'x', lines: ['a'] })
  settings.saveMacro({ ...m, name: 'y' })
  const all = settings.get().macros.filter((x) => x.id === m.id)
  assert.strictEqual(all.length, 1)
  assert.strictEqual(all[0].name, 'y')
})

// ----------------------------------------------------------------- files ----
test('files: modeString renders type and rwx triplets', () => {
  assert.strictEqual(files.modeString(0o040755, true, false), 'drwxr-xr-x')
  assert.strictEqual(files.modeString(0o100644, false, false), '-rw-r--r--')
  assert.strictEqual(files.modeString(0o120777, false, true), 'lrwxrwxrwx')
})

test('files: directories sort before files, then naturally', () => {
  const list = [
    { name: 'b.txt', isDir: false }, { name: 'a10', isDir: true },
    { name: 'a2', isDir: true }, { name: 'a.txt', isDir: false }
  ].sort(files.sortEntries)
  assert.deepStrictEqual(list.map((x) => x.name), ['a2', 'a10', 'a.txt', 'b.txt'])
})

test('files: posix path helpers', () => {
  assert.strictEqual(files.posixJoin('/var/log', 'syslog'), '/var/log/syslog')
  assert.strictEqual(files.posixJoin('/', 'etc'), '/etc')
  assert.strictEqual(files.posixDirname('/var/log/syslog'), '/var/log')
  assert.strictEqual(files.posixDirname('/var'), '/')
})

test('files: freeName picks the first free numbered name', () => {
  const taken = new Set(['/d/report (1).txt', '/d/report (2).txt'])
  assert.strictEqual(files.freeName((p) => taken.has(p), '/d/report.txt'), '/d/report (3).txt')
  assert.strictEqual(files.freeName(() => false, '/d/report.txt'), '/d/report (1).txt')
})

test('files: freeName handles a name with no extension', () => {
  assert.strictEqual(files.freeName(() => false, '/d/README'), '/d/README (1)')
})

test('files: freeName does not mistake a dotted directory for an extension', () => {
  assert.strictEqual(files.freeName(() => false, '/a.b/README'), '/a.b/README (1)')
})

test('files: fmtBytes', () => {
  assert.strictEqual(files.fmtBytes(512), '512 B')
  assert.strictEqual(files.fmtBytes(1536), '1.5 KB')
})

testAsync('files: walkLocal collects a real tree and skips symlinks', async () => {
  const root = path.join(tmp, 'walk')
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(root, 'one.txt'), 'x')
  fs.writeFileSync(path.join(root, 'sub', 'two.txt'), 'yy')
  fs.symlinkSync(path.join(root, 'one.txt'), path.join(root, 'link.txt'))
  const { files: found, dirs } = await files.walkLocal(root)
  assert.deepStrictEqual(found.map((f) => f.rel).sort(), ['walk/one.txt', 'walk/sub/two.txt'])
  assert.deepStrictEqual(dirs.sort(), ['walk', 'walk/sub'])
})

// ------------------------------------------------------------------- ssh ----
test('ssh: parseHop handles user@host:port forms', () => {
  assert.deepStrictEqual(ssh.parseHop('bastion'), { username: undefined, host: 'bastion', port: 22 })
  assert.deepStrictEqual(ssh.parseHop('jump@gw:2222'), { username: 'jump', host: 'gw', port: 2222 })
  assert.throws(() => ssh.parseHop('a@b@c:1:2'))
})

test('ssh: fingerprint is OpenSSH SHA256 format, unpadded', () => {
  const expected = 'SHA256:' + require('node:crypto')
    .createHash('sha256').update(Buffer.from('hello')).digest('base64').replace(/=+$/, '')
  const fp = ssh.fingerprint(Buffer.from('hello'))
  assert.strictEqual(fp, expected)
  assert.ok(!fp.endsWith('='), 'base64 padding must be stripped like OpenSSH')
})

testAsync('ssh: socks5 CONNECT handshake reaches the target host/port', async () => {
  const seen = []
  const server = net.createServer((socket) => ssh.socks5(socket, (host, port, done) => {
    seen.push(`${host}:${port}`)
    const through = new (require('node:stream').PassThrough)()
    done(null, through)
  }))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  const client = net.connect(port, '127.0.0.1')
  await new Promise((r) => client.once('connect', r))
  client.write(Buffer.from([0x05, 0x01, 0x00])) // greeting, no auth
  await new Promise((r) => client.once('data', r))
  // CONNECT to example.org:443 as a domain name
  const host = Buffer.from('example.org')
  client.write(Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, Buffer.from([0x01, 0xbb])
  ]))
  const reply = await new Promise((r) => client.once('data', r))
  assert.strictEqual(reply[0], 0x05)
  assert.strictEqual(reply[1], 0x00, 'expected SOCKS success')
  assert.deepStrictEqual(seen, ['example.org:443'])
  client.destroy()
  await new Promise((r) => server.close(r))
})

// ----------------------------------------------------------------- tools ----
test('tools: expandRange CIDR drops network and broadcast', () => {
  const h = tools.expandRange('192.168.1.0/24')
  assert.strictEqual(h.length, 254)
  assert.strictEqual(h[0], '192.168.1.1')
  assert.strictEqual(h[253], '192.168.1.254')
})

test('tools: expandRange /32 is the single host', () => {
  assert.deepStrictEqual(tools.expandRange('10.0.0.7/32'), ['10.0.0.7'])
})

test('tools: expandRange dashed and short forms', () => {
  assert.deepStrictEqual(tools.expandRange('10.0.0.1 - 10.0.0.3'), ['10.0.0.1', '10.0.0.2', '10.0.0.3'])
  assert.deepStrictEqual(tools.expandRange('10.0.0.8-10'), ['10.0.0.8', '10.0.0.9', '10.0.0.10'])
})

test('tools: expandRange rejects junk instead of guessing', () => {
  for (const bad of ['', 'not-an-ip', '999.1.1.1', '10.0.0.5-10.0.0.1', '10.0.0.0/4']) {
    assert.deepStrictEqual(tools.expandRange(bad), [], `expected [] for ${JSON.stringify(bad)}`)
  }
})

test('tools: ip int round-trip', () => {
  assert.strictEqual(tools.intToIp(tools.ipToInt('172.16.254.1')), '172.16.254.1')
  assert.strictEqual(tools.ipToInt('1.2.3'), null)
})

testAsync('tools: netscan finds a port we actually opened', async () => {
  const server = net.createServer(() => {})
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const res = await tools.netscan({ range: '127.0.0.1', ports: [port, port + 1 > 65535 ? 1 : port + 1], timeout: 500 })
  assert.strictEqual(res.hosts.length, 1)
  assert.ok(res.hosts[0].ports.includes(port), `expected ${port} in ${res.hosts[0].ports}`)
  await new Promise((r) => server.close(r))
})

test('tools: netscan refuses ranges above the stated limit', async () => {
  await assert.rejects(() => tools.netscan({ range: '10.0.0.0/20' }), /limit is 1024/)
})

// ---------------------------------------------------------------- summary ---
process.on('beforeExit', () => {
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`\n${passed} checks passed${process.exitCode ? ' — with failures above' : ''}`)
})
