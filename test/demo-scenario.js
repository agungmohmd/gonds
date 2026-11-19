/* eslint-disable */
// Drives the UI for the introduction video. Paced for a human watching, not
// for speed: every step pauses long enough to be read.
//
// The remote host is Rebex's public SSH/SFTP test server, whose credentials
// Rebex publishes for exactly this purpose. The session is read-only — the
// demo downloads one 379-byte file and writes nothing.
const cfg = window.__SMOKE || {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = { steps: [] }
const note = (s) => out.steps.push(s)

const waitFor = async (fn, ms = 25000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try { if (await fn()) return true } catch (e) {}
    await sleep(120)
  }
  return false
}

/** Fill a field one character at a time so the video shows it being typed. */
async function typeInto (el, text, perChar = 55) {
  el.focus()
  el.value = ''
  for (const ch of text) {
    el.value += ch
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(perChar)
  }
  await sleep(250)
}

/** Send keystrokes to a terminal at typing speed. */
async function typeInTerm (term, text, perChar = 45) {
  for (const ch of text) { term.send(ch); await sleep(perChar) }
  await sleep(200)
  term.send('\r')
}

try {
  // ---------------------------------------------------------- 1. the home --
  await sleep(1600)

  // ------------------------------------------- 2. type the host and connect --
  const field = document.querySelector('.home .hc-input')
  await typeInto(field, `${cfg.username}@${cfg.host}`)
  await sleep(600)
  document.querySelector('.home .hc-row .btn.primary').click()
  note('typed the host and pressed Connect')

  // ------------------------------------------------------- 3. the host key --
  const hostKey = await waitFor(
    () => document.querySelector('.overlay .dialog header h3')?.textContent?.includes('Unknown host key'), 25000)
  if (hostKey) {
    await sleep(2600) // let the fingerprint be read
    document.querySelector('.overlay .dialog footer button:last-child').click() // Accept and remember
    note('accepted the host key')
  }

  // ------------------------------------------------------- 4. the password --
  const pw = await waitFor(
    () => document.querySelector('.overlay .dialog header h3')?.textContent === 'SSH authentication', 20000)
  if (pw) {
    await sleep(900)
    await typeInto(document.querySelector('.overlay .dialog input[type="password"]'), cfg.password, 90)
    await sleep(500)
    document.querySelector('.overlay .dialog footer button:last-child').click()
    note('typed the password')
  }

  // -------------------------------------------------------- 5. the session --
  const tab = await waitFor(() => window.Tabs.list().find((t) => t.spec.host === cfg.host), 20000)
    ? window.Tabs.list().find((t) => t.spec.host === cfg.host)
    : null
  const term = tab?.terms[0]
  if (!await waitFor(() => term?.alive && term.connId, 25000)) throw new Error('did not connect')
  note('connected')
  await sleep(2200)

  // A real command against a real server.
  await typeInTerm(term, 'help')
  await sleep(2600)

  // ------------------------------------------------------- 6. the SFTP side --
  const panel = tab.sftp
  await waitFor(() => panel && panel.entries.length > 0, 20000)
  note('sftp panel listed ' + panel.entries.map((e) => e.name).join(', '))
  await sleep(2000)

  // Walk into a directory so the panel is visibly live, then back out.
  const dir = panel.entries.find((e) => e.isDir)
  if (dir) {
    await panel.go(dir.path)
    await sleep(2200)
    await panel.up()
    await sleep(1600)
  }

  // ---------------------------------------------------------- 7. download --
  const file = panel.entries.find((e) => !e.isDir && e.size > 0)
  if (file) {
    panel.sel.clear(); panel.sel.add(file.path); panel.paint()
    await sleep(1400)
    // The toolbar button opens a native folder picker, which cannot be driven
    // from here — so the destination is supplied directly. Same code path,
    // same progress UI, same toast.
    const res = await window.mx.sftp.download(term.connId, [file.path], cfg.dest)
    note('downloaded ' + JSON.stringify(res.results.map((r) => r.path)))
    await sleep(2400)

    // Show it actually landed: flip the panel to the local filesystem.
    await panel.setMode('local')
    await sleep(900)
    await panel.go(cfg.dest)
    await sleep(3000)
  }

  // ----------------------------------------------------------- 8. the end --
  window.Tabs.openHome()
  await sleep(2200)
} catch (err) {
  out.error = (err && err.stack) || String(err)
}
return out
