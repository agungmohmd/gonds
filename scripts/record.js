#!/usr/bin/env node
'use strict'
// Record the introduction video.
//
// Launches Gonds against a throwaway profile, drives the UI with
// test/demo-scenario.js, captures a frame per tick from inside Electron, then
// assembles them with ffmpeg. Frames come from capturePage rather than the OS
// screen recorder, which needs a Screen Recording grant the terminal usually
// does not have.
//
//   npm run demo
//   REMOTE_HOST=… REMOTE_USER=… REMOTE_PASS=… npm run demo
//
// Default target is Rebex's public SSH/SFTP test server, whose credentials
// Rebex publishes for this purpose. The run is read-only.
const fs = require('node:fs')
const os = require('node:os')
const net = require('node:net')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')

const root = path.join(__dirname, '..')
const outDir = path.join(root, 'demo')
const frames = path.join(outDir, 'frames')
const FPS = Number(process.env.DEMO_FPS || 8)

const target = {
  host: process.env.REMOTE_HOST || 'test.rebex.net',
  port: Number(process.env.REMOTE_PORT || 22),
  username: process.env.REMOTE_USER || 'demo',
  password: process.env.REMOTE_PASS || 'password'
}

function have (bin) {
  try { execFileSync('/usr/bin/which', [bin], { stdio: 'pipe' }); return true } catch { return false }
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

async function main () {
  if (!have('ffmpeg')) {
    console.error('ffmpeg is required to assemble the video:  brew install ffmpeg')
    process.exit(2)
  }
  if (!await reachable(target.host, target.port)) {
    console.error(`${target.host}:${target.port} is unreachable — cannot record the demo.`)
    process.exit(1)
  }

  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(frames, { recursive: true })

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gonds-demo-'))
  const dest = path.join(os.tmpdir(), 'gonds-demo-downloads')
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(dest, { recursive: true })

  // A fixed window size keeps the video dimensions predictable, and an empty
  // session tree keeps the author's own hosts out of the recording.
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
    ui: { windowBounds: { x: 80, y: 60, width: 1440, height: 900 }, maximised: false, restoreTabs: false }
  }, null, 2))

  const electron = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
  const child = spawn(electron, [root, `--user-data-dir=${profile}`], {
    env: {
      ...process.env,
      GONDS_RECORD: frames,
      GONDS_RECORD_FPS: String(FPS),
      GONDS_RECORD_WIDTH: '1440',
      GONDS_SMOKE: path.join(outDir, 'final.png'),
      GONDS_SMOKE_SCENARIO: path.join(root, 'test', 'demo-scenario.js'),
      GONDS_SMOKE_SSH: JSON.stringify({ ...target, dest })
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let stdout = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', () => {})

  const timer = setTimeout(() => { console.error('timed out'); child.kill('SIGKILL') }, 180000)
  await new Promise((r) => child.on('exit', r))
  clearTimeout(timer)
  fs.rmSync(profile, { recursive: true, force: true })

  const line = stdout.split('\n').find((l) => l.startsWith('SMOKE '))
  const res = line ? JSON.parse(line.slice(6)) : {}
  for (const s of res.steps || []) console.log('  · ' + s)
  if (res.error) console.error('\nscenario error:\n' + res.error)

  const shot = fs.readdirSync(frames).filter((f) => f.endsWith('.png')).sort()
  if (shot.length < FPS * 5) {
    console.error(`only ${shot.length} frames captured — something went wrong`)
    process.exit(1)
  }

  // Drop the first second: window creation and first paint are not interesting.
  for (const f of shot.slice(0, FPS)) fs.rmSync(path.join(frames, f))
  const kept = fs.readdirSync(frames).filter((f) => f.endsWith('.png')).sort()
  kept.forEach((f, i) => fs.renameSync(path.join(frames, f), path.join(frames, `s${String(i + 1).padStart(5, '0')}.png`)))

  const mp4 = path.join(outDir, 'gonds-demo.mp4')
  const gif = path.join(outDir, 'gonds-demo.gif')

  const run = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' })

  // yuv420p and even dimensions: what every player and every social site wants.
  run(['-framerate', String(FPS), '-i', path.join(frames, 's%05d.png'),
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'slow',
    '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4])

  // A palette pass keeps the GIF from banding the terminal text into mush.
  const pal = path.join(outDir, 'palette.png')
  run(['-framerate', String(FPS), '-i', path.join(frames, 's%05d.png'),
    '-vf', 'fps=10,scale=1000:-1:flags=lanczos,palettegen=stats_mode=diff', pal])
  run(['-framerate', String(FPS), '-i', path.join(frames, 's%05d.png'), '-i', pal,
    '-lavfi', 'fps=10,scale=1000:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3', gif])
  fs.rmSync(pal, { force: true })

  const secs = (kept.length / FPS).toFixed(1)
  const mb = (f) => (fs.statSync(f).size / 1048576).toFixed(1) + ' MB'
  console.log(`\n  ${kept.length} frames · ${secs}s @ ${FPS}fps`)
  console.log(`  ${mp4}  ${mb(mp4)}`)
  console.log(`  ${gif}  ${mb(gif)}`)
  console.log(`\n  frames kept in ${frames} — delete when you are happy with the cut`)
}

main().catch((err) => { console.error(err); process.exit(1) })
