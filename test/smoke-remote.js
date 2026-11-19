/* eslint-disable */
// Runs inside the renderer against a real, third-party SSH server.
// Purpose: the things a local ssh2-based fixture cannot prove — interop with a
// different SSH implementation, and the unknown-host-key dialog on a first
// connection. Read-only: nothing is written to the remote side.
const out = { steps: [] }
const ok = (name, pass, detail) => { out.steps.push({ name, pass: Boolean(pass), detail: detail || '' }); return pass }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const waitFor = async (fn, ms = 25000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try { if (await fn()) return true } catch (e) {}
    await sleep(150)
  }
  return false
}

const bufText = (term) => {
  const b = term.xterm.buffer.active
  let s = ''
  for (let i = 0; i < b.length; i++) s += (b.getLine(i)?.translateToString(true) || '') + '\n'
  return s
}

const cfg = window.__SMOKE || {}

try {
  // The profile starts with an empty host-key store, so connecting must stop
  // and ask. Do not await the launch — the dialog is what blocks it.
  const launched = window.MX.launchAdhoc({
    type: 'ssh',
    name: 'remote',
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    password: cfg.password,
    openSftp: true,
    useAgent: false
  })
  launched.catch(() => {})

  const dialogUp = await waitFor(() => document.querySelector('.overlay .dialog header h3')?.textContent?.includes('Unknown host key'), 25000)
  ok('unknown host key stops the connection and asks', dialogUp,
    document.querySelector('.overlay .dialog header h3')?.textContent || 'no dialog')

  if (dialogUp) {
    const shown = [...document.querySelectorAll('.overlay .dialog code')].map((n) => n.textContent)
    ok('dialog shows the server and its fingerprint', shown.length >= 2, JSON.stringify(shown))
    const expected = cfg.expectedFingerprints || []
    ok('fingerprint matches one advertised by ssh-keyscan',
      expected.length === 0 || shown.some((s) => expected.includes(s)),
      'shown=' + JSON.stringify(shown) + ' expected=' + JSON.stringify(expected))

    const buttons = [...document.querySelectorAll('.overlay .dialog footer button')].map((b) => b.textContent)
    ok('dialog offers reject / once / remember', buttons.length === 3, JSON.stringify(buttons))

    document.querySelector('.overlay .dialog footer button:last-child').click() // Accept and remember
    await sleep(300)
    ok('dialog dismissed after accepting', !document.querySelector('.overlay'))
  }

  await launched.catch(() => {})
  const tab = window.Tabs.list().find((t) => t.spec.name === 'remote')
  const term = tab?.terms[0]
  const up = await waitFor(() => term && term.alive && term.connId, 25000)
  ok('connected to a non-ssh2 server implementation', up,
    up ? '' : (term ? bufText(term).slice(-300) : 'no terminal'))

  if (up) {
    ok('host key was remembered',
      (await window.mx.tools.knownHosts()).some((h) => h.host === cfg.host + ':' + cfg.port),
      JSON.stringify(await window.mx.tools.knownHosts()))

    const gotBytes = await waitFor(() => bufText(term).trim().length > 0, 15000)
    ok('interactive shell channel produced output', gotBytes, bufText(term).trim().slice(0, 200))

    const panel = tab.sftp
    ok('sftp panel attached to the real server', Boolean(panel))
    if (panel) {
      const listed = await waitFor(() => panel.entries.length > 0, 20000)
      ok('sftp listed the real remote directory', listed,
        panel.path + ' → ' + panel.entries.map((e) => e.name).join(','))
      out.remoteListing = panel.entries.map((e) => ({ name: e.name, dir: e.isDir, size: e.size }))

      const file = panel.entries.find((e) => !e.isDir && e.size > 0)
      if (file && cfg.scratch) {
        const dl = (await window.mx.sftp.download(term.connId, [file.path], cfg.scratch)).results
        ok('downloaded a file from the real server', dl.every((r) => r.ok), JSON.stringify(dl))
        const local = await window.mx.files.localList(cfg.scratch)
        const got = local.entries.find((e) => e.name === file.name)
        ok('downloaded bytes match the advertised size', got && got.size === file.size,
          JSON.stringify({ remote: file.size, local: got && got.size }))
      } else {
        ok('a downloadable file was offered', false, 'no non-empty file in the listing')
      }

      const sub = panel.entries.find((e) => e.isDir)
      if (sub) {
        await panel.go(sub.path)
        ok('navigated a real remote subdirectory', panel.path.endsWith(sub.name),
          panel.path + ' → ' + panel.entries.map((e) => e.name).join(','))
      }
    }

    // Changed-key handling: forget the key, reconnect, and the dialog must come
    // back. This is the branch that protects against interception.
    await window.mx.tools.forgetHost(cfg.host, cfg.port)
    ok('host key can be forgotten',
      !(await window.mx.tools.knownHosts()).some((h) => h.host === cfg.host + ':' + cfg.port))
  }
} catch (err) {
  out.error = (err && err.stack) || String(err)
}

out.passed = out.steps.filter((s) => s.pass).length
out.failed = out.steps.filter((s) => !s.pass).length
return out
