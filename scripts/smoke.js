#!/usr/bin/env node
'use strict'
// End-to-end smoke run: boots a throwaway SSH/SFTP server, launches Gonds
// against an isolated profile, drives the real UI, prints a pass/fail table and
// leaves a screenshot behind. Never touches the user's own session store.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')

const root = path.join(__dirname, '..')
const fixture = require(path.join(root, 'test', 'sshfixture'))

const shot = process.env.SMOKE_PNG || path.join(os.tmpdir(), 'gonds-smoke.png')

// GONDS_BIN points the run at a packaged build instead of the dev tree,
// e.g. dist/mac-arm64/Gonds.app/Contents/MacOS/Gonds
function electronBin () {
  if (process.env.GONDS_BIN) return process.env.GONDS_BIN
  const p = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
  if (!fs.existsSync(p)) {
    console.error('Electron binary missing. See docs/SESSION-STATE.md → environment notes.')
    process.exit(2)
  }
  return p
}

async function main () {
  const srv = await fixture.start()

  // Isolated profile, pre-trusting the fixture host key so no prompt blocks the run.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gonds-profile-'))
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gonds-scratch-'))
  // Big enough that a cancel lands mid-stream rather than after the fact.
  const bigFile = path.join(scratch, 'big.bin')
  fs.writeFileSync(bigFile, Buffer.alloc(64 * 1024 * 1024, 7))
  const fp = 'SHA256:' + crypto.createHash('sha256').update(srv.publicSSH).digest('base64').replace(/=+$/, '')
  fs.writeFileSync(path.join(profile, 'known_hosts.json'),
    JSON.stringify({ [`${srv.host}:${srv.port}`]: { fingerprint: fp, addedAt: new Date().toISOString() } }, null, 2))

  // Seed a distinctive window size so the restore path is observable.
  const seededBounds = { x: 60, y: 60, width: 1180, height: 760 }
  fs.writeFileSync(path.join(profile, 'settings.json'),
    JSON.stringify({ ui: { windowBounds: seededBounds, maximised: false } }, null, 2))

  // A packaged build already knows its app path; only the dev binary needs one.
  const args = process.env.GONDS_BIN ? [] : [root]
  const child = spawn(electronBin(), [...args, `--user-data-dir=${profile}`], {
    env: {
      ...process.env,
      GONDS_SMOKE: shot,
      GONDS_SMOKE_SCENARIO: path.join(root, 'test', 'smoke-scenario.js'),
      GONDS_SMOKE_SSH: JSON.stringify({
        host: srv.host,
        port: srv.port,
        username: srv.username,
        password: srv.password,
        echoPort: srv.echoPort,
        scratch,
        bigFile,
        seededBounds
      })
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stderr += d })

  const timer = setTimeout(() => {
    console.error('Smoke run timed out after 120s; killing Electron.')
    child.kill('SIGKILL')
  }, 120000)

  const code = await new Promise((r) => child.on('exit', r))
  clearTimeout(timer)

  // Did main write the geometry back out on close?
  let persistedBounds = null
  try {
    persistedBounds = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).ui?.windowBounds
  } catch {}

  // Proven from the server side: the forward really carried a channel.
  const tcpip = [...srv.tcpipRequests]
  const uploaded = fs.existsSync(path.join(srv.root)) &&
    fs.readdirSync(srv.root).filter((n) => n.startsWith('smoke-'))

  await srv.close()
  fs.rmSync(profile, { recursive: true, force: true })
  fs.rmSync(scratch, { recursive: true, force: true })

  const line = stdout.split('\n').find((l) => l.startsWith('SMOKE '))
  if (!line) {
    console.error('No SMOKE result. exit=' + code)
    console.error(stdout.trim() || '(no stdout)')
    console.error(stderr.split('\n').filter((l) => !/VizNullHypothesis/.test(l)).join('\n').trim())
    process.exit(1)
  }

  const res = JSON.parse(line.slice(6))

  // Server-side corroboration — these cannot be faked by the renderer.
  res.steps = res.steps || []
  if (res.forwardPort) {
    res.steps.push({
      name: 'fixture saw a direct-tcpip channel for the forward',
      pass: tcpip.length > 0,
      detail: JSON.stringify(tcpip)
    })
  }
  res.steps.push({
    name: 'uploaded file landed on the server filesystem',
    pass: Array.isArray(uploaded) && uploaded.length > 0,
    detail: JSON.stringify(uploaded)
  })
  res.steps.push({
    name: 'window geometry is written back to settings on close',
    pass: Boolean(persistedBounds && persistedBounds.width > 0 && persistedBounds.height > 0),
    detail: JSON.stringify(persistedBounds)
  })

  for (const s of res.steps) {
    console.log(`  ${s.pass ? 'ok  ' : 'FAIL'} ${s.name}${s.detail && !s.pass ? `\n       ${s.detail}` : ''}`)
  }
  res.passed = res.steps.filter((s) => s.pass).length
  res.failed = res.steps.filter((s) => !s.pass).length
  if (res.error) console.error('\nscenario error:\n' + res.error)
  for (const p of res.problems || []) console.error('  renderer: ' + p)

  console.log(`\nprobe: ${JSON.stringify(res.probe)}`)
  console.log(`screenshot: ${shot}`)
  console.log(`\n${res.passed || 0} passed, ${res.failed || 0} failed`)

  process.exit((res.failed || res.error || !res.steps) ? 1 : 0)
}

main().catch((err) => { console.error(err); process.exit(1) })
