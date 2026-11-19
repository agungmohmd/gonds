#!/usr/bin/env node
'use strict'
// Opt-in smoke run against a real, third-party SSH server.
//
// Default target is Rebex's public test server, whose credentials Rebex
// publishes for exactly this purpose (https://test.rebex.net/). It is
// read-only; this run never writes to it.
//
//   npm run smoke:remote
//   REMOTE_HOST=host REMOTE_PORT=22 REMOTE_USER=u REMOTE_PASS=p npm run smoke:remote
const fs = require('node:fs')
const os = require('node:os')
const net = require('node:net')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn, execFileSync } = require('node:child_process')

const root = path.join(__dirname, '..')
const shot = process.env.SMOKE_PNG || path.join(os.tmpdir(), 'gonds-smoke-remote.png')

const target = {
  host: process.env.REMOTE_HOST || 'test.rebex.net',
  port: Number(process.env.REMOTE_PORT || 22),
  username: process.env.REMOTE_USER || 'demo',
  password: process.env.REMOTE_PASS || 'password'
}

function electronBin () {
  if (process.env.GONDS_BIN) return process.env.GONDS_BIN
  return path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
}

function reachable (host, port, ms = 6000) {
  return new Promise((resolve) => {
    const s = new net.Socket()
    const done = (v) => { s.destroy(); resolve(v) }
    s.setTimeout(ms)
    s.once('connect', () => done(true))
    s.once('timeout', () => done(false))
    s.once('error', () => done(false))
    s.connect(port, host)
  })
}

/** Independent fingerprint via ssh-keygen, to compare against what the UI shows. */
function keyscanFingerprint (host, port) {
  const scan = execFileSync('/usr/bin/ssh-keyscan', ['-T', '8', '-p', String(port), host], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const lines = scan.split('\n').filter((l) => l && !l.startsWith('#'))
  if (!lines.length) throw new Error('ssh-keyscan returned no keys')
  // Gonds verifies whichever key the negotiated host-key algorithm yields;
  // every advertised key is a legitimate expectation, so return them all.
  return lines.map((l) => {
    const blob = Buffer.from(l.trim().split(/\s+/)[2], 'base64')
    return 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
  })
}

async function main () {
  if (!await reachable(target.host, target.port)) {
    console.error(`${target.host}:${target.port} is unreachable — skipping the remote smoke run.`)
    process.exit(process.env.REMOTE_REQUIRED ? 1 : 0)
  }

  let fingerprints = []
  try {
    fingerprints = keyscanFingerprint(target.host, target.port)
  } catch (err) {
    console.error('warning: ssh-keyscan failed (' + err.message + '); fingerprint comparison will be skipped')
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gonds-rprofile-'))
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gonds-rscratch-'))
  // Deliberately NOT seeding known_hosts: the prompt is the thing under test.

  const args = process.env.GONDS_BIN ? [] : [root]
  const child = spawn(electronBin(), [...args, `--user-data-dir=${profile}`], {
    env: {
      ...process.env,
      GONDS_SMOKE: shot,
      GONDS_SMOKE_SCENARIO: path.join(root, 'test', 'smoke-remote.js'),
      GONDS_SMOKE_SSH: JSON.stringify({ ...target, scratch, expectedFingerprints: fingerprints })
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stderr += d })

  const timer = setTimeout(() => {
    console.error('Remote smoke run timed out after 150s; killing Electron.')
    child.kill('SIGKILL')
  }, 150000)

  const code = await new Promise((r) => child.on('exit', r))
  clearTimeout(timer)
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
  console.log(`target: ${target.username}@${target.host}:${target.port}`)
  console.log(`host keys advertised: ${fingerprints.join(', ') || '(unknown)'}\n`)
  for (const s of res.steps || []) {
    console.log(`  ${s.pass ? 'ok  ' : 'FAIL'} ${s.name}${s.detail && !s.pass ? `\n       ${s.detail}` : ''}`)
  }
  if (res.remoteListing) console.log('\nremote root: ' + JSON.stringify(res.remoteListing))
  if (res.error) console.error('\nscenario error:\n' + res.error)
  for (const p of res.problems || []) console.error('  renderer: ' + p)

  console.log(`\nscreenshot: ${shot}`)
  console.log(`${res.passed || 0} passed, ${res.failed || 0} failed`)
  process.exit((res.failed || res.error || !res.steps) ? 1 : 0)
}

main().catch((err) => { console.error(err); process.exit(1) })
