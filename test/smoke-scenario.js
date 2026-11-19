/* eslint-disable */
// Runs inside the renderer (wrapped in an async IIFE by the smoke harness).
// `window.__SMOKE` carries the fixture SSH coordinates. Returns a result object.
const out = { steps: [] }
const ok = (name, pass, detail) => { out.steps.push({ name, pass: Boolean(pass), detail: detail || '' }); return pass }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const waitFor = async (fn, ms = 10000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try { if (await fn()) return true } catch (e) {}
    await sleep(120)
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
  // ---------------------------------------------------------------- home --
  ok('home shows the connect bar first', Boolean(document.querySelector('.home .hc-input')))
  ok('home offers new-session chips', document.querySelectorAll('.home .chip').length >= 6,
    document.querySelectorAll('.home .chip').length + ' chips')
  ok('home lists saved sessions below the connect bar', Boolean(document.querySelector('.home .recent')))
  ok('session tree present', Boolean(document.querySelector('#session-tree')))

  // -------------------------------------------------------- local shell --
  await window.MX.openShell()
  const shellTab = window.Tabs.list().find((t) => t.spec.type === 'shell')
  ok('local shell tab opened', Boolean(shellTab))
  const shellTerm = shellTab?.terms[0]
  ok('pty attached', await waitFor(() => shellTerm && shellTerm.alive && shellTerm.termId))
  if (shellTerm?.alive) {
    await sleep(900)
    shellTerm.send('echo GONDS_PTY_OK\n')
    const seen = await waitFor(() => bufText(shellTerm).includes('GONDS_PTY_OK'), 9000)
    ok('pty round-trip (echo)', seen, seen ? '' : bufText(shellTerm).slice(-300))
    ok('pty reports a sane geometry', shellTerm.xterm.cols > 20 && shellTerm.xterm.rows > 5,
      shellTerm.xterm.cols + 'x' + shellTerm.xterm.rows)
  }

  // ---------------------------------------------------------------- ssh --
  let sshTab = null
  let sshTerm = null
  if (cfg.port) {
    await window.MX.launchAdhoc({
      type: 'ssh',
      name: 'fixture',
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      password: cfg.password,
      openSftp: true,
      useAgent: false
    })
    sshTab = window.Tabs.list().find((t) => t.spec.name === 'fixture')
    sshTerm = sshTab?.terms[0]
    const up = await waitFor(() => sshTerm && sshTerm.alive && sshTerm.connId, 15000)
    ok('ssh connected (password auth, host key pre-trusted)', up,
      up ? '' : (sshTerm ? bufText(sshTerm).slice(-300) : 'no terminal'))

    if (up) {
      ok('ssh shell banner received', await waitFor(() => bufText(sshTerm).includes('fixture shell ready'), 8000))
      sshTerm.send('echo GONDS_SSH_OK\n')
      const seen = await waitFor(() => bufText(sshTerm).includes('GONDS_SSH_OK'), 8000)
      ok('ssh shell round-trip', seen, seen ? '' : bufText(sshTerm).slice(-300))

      // ------------------------------------------------------------ sftp --
      const panel = sshTab.sftp
      ok('sftp panel created for ssh tab', Boolean(panel))
      if (panel) {
        const listed = await waitFor(() => panel.entries.some((e) => e.name === 'readme.txt'), 10000)
        ok('sftp listed the remote root', listed, panel.entries.map((e) => e.name).join(','))
        ok('sftp marks directories', panel.entries.some((e) => e.name === 'etc' && e.isDir))
        ok('sftp renders rows', document.querySelectorAll('.sftp .frow').length > 0)

        await panel.go(panel.path.replace(/\/$/, '') + '/etc')
        ok('sftp navigated into a subdirectory', panel.entries.some((e) => e.name === 'motd'),
          panel.path + ' -> ' + panel.entries.map((e) => e.name).join(','))

        const text = await window.mx.sftp.read(sshTerm.connId, '/readme.txt')
        ok('sftp read a remote file', text.includes('hello from the fixture'), JSON.stringify(text).slice(0, 80))

        // -------------------------------------------------- write path --
        await panel.go('/')
        const stamp = 'smoke-' + Date.now()
        await window.mx.sftp.write(sshTerm.connId, '/' + stamp + '.txt', 'written by the smoke run\n')
        await panel.reload()
        ok('sftp wrote a new remote file', panel.entries.some((e) => e.name === stamp + '.txt'))

        const back = await window.mx.sftp.read(sshTerm.connId, '/' + stamp + '.txt')
        ok('sftp read back what it wrote', back === 'written by the smoke run\n', JSON.stringify(back))

        await window.mx.sftp.mkdir(sshTerm.connId, '/', stamp + '-dir')
        await panel.reload()
        ok('sftp mkdir', panel.entries.some((e) => e.name === stamp + '-dir' && e.isDir))

        await window.mx.sftp.rename(sshTerm.connId, '/' + stamp + '.txt', '/' + stamp + '-renamed.txt')
        await panel.reload()
        ok('sftp rename', panel.entries.some((e) => e.name === stamp + '-renamed.txt'))

        await window.mx.sftp.chmod(sshTerm.connId, '/' + stamp + '-renamed.txt', 0o600)
        await panel.reload()
        const renamed = panel.entries.find((e) => e.name === stamp + '-renamed.txt')
        ok('sftp chmod took effect', renamed && (renamed.mode & 0o777) === 0o600,
          renamed ? (renamed.mode & 0o777).toString(8) : 'missing')

        // -------------------------------------- upload / download loop --
        if (cfg.scratch) {
          const dl = (await window.mx.sftp.download(sshTerm.connId, ['/' + stamp + '-renamed.txt'], cfg.scratch)).results
          ok('sftp download wrote a local file', dl.every((r) => r.ok), JSON.stringify(dl))
          const local = await window.mx.files.localList(cfg.scratch)
          const got = local.entries.find((e) => e.name === stamp + '-renamed.txt')
          ok('downloaded file exists locally with content', got && got.size > 0, JSON.stringify(got && got.size))

          // Upload under a distinct name so it survives the delete step below
          // and the driver can confirm it on the server's own filesystem.
          const upName = stamp + '-upload.txt'
          await window.mx.files.localRename(got.path, cfg.scratch + '/' + upName)
          const up = (await window.mx.sftp.upload(sshTerm.connId, [cfg.scratch + '/' + upName], '/')).results
          ok('sftp upload reported success', up.every((r) => r.ok), JSON.stringify(up))
          await panel.reload()
          ok('uploaded file visible in the remote listing',
            panel.entries.some((e) => e.name === upName),
            panel.entries.map((e) => e.name).join(','))
        }

        await window.mx.sftp.remove(sshTerm.connId, ['/' + stamp + '-renamed.txt', '/' + stamp + '-dir'])
        await panel.reload()
        // The uploaded file is left behind on purpose for the driver to verify.
        ok('sftp delete removed file and directory',
          !panel.entries.some((e) => e.name === stamp + '-renamed.txt' || e.name === stamp + '-dir'),
          panel.entries.map((e) => e.name).join(','))
      }

      // -------------------------------------------------------- tunnel --
      if (cfg.echoPort) {
        const t = await window.mx.tunnel.add(sshTerm.connId, {
          kind: 'local', bindAddress: '127.0.0.1', localPort: 0,
          remoteHost: '127.0.0.1', remotePort: cfg.echoPort
        })
        ok('local forward started', Boolean(t.actualPort), JSON.stringify(t))
        // netscan connects from the main process, which drives a real
        // direct-tcpip channel through the forward. The driver then checks
        // that the fixture actually saw it.
        const probe = await window.mx.tools.netscan({ range: '127.0.0.1', ports: [t.actualPort], timeout: 1500 })
        ok('traffic traverses the forward', probe.hosts.length === 1, JSON.stringify(probe.hosts))
        out.forwardPort = t.actualPort

        const listed = await window.mx.tunnel.list(sshTerm.connId)
        ok('tunnel appears in the session list', listed.length === 1, JSON.stringify(listed))
        await window.mx.tunnel.remove(sshTerm.connId, t.id)
        ok('tunnel removed', (await window.mx.tunnel.list(sshTerm.connId)).length === 0)
      }

      // ----------------------------------------------------------- split --
      await sshTab.split('row')
      ok('split created a second terminal', sshTab.terms.length === 2, String(sshTab.terms.length))
      ok('both split terminals live', await waitFor(() => sshTab.terms.every((t) => t.alive), 15000))

      // ---------------------------------------------------------- layout --
      await sleep(400)
      const box = (n) => { const r = n.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height) }
      const paneH = sshTab.pane.getBoundingClientRect().height
      const chain = []
      for (let n = sshTerm.el; n && n !== sshTab.pane; n = n.parentElement) {
        const cs = getComputedStyle(n)
        chain.push(`${n.className}[${box(n)} d=${cs.display} as=${cs.alignSelf} fl=${cs.flex} h=${cs.height}]`)
      }
      const pcs = getComputedStyle(sshTab.pane)
      chain.push(`pane[${box(sshTab.pane)} d=${pcs.display} ai=${pcs.alignItems}]`)
      ok('terminal fills its pane vertically',
        sshTerm.el.getBoundingClientRect().height > paneH * 0.9, chain.join(' < '))
      ok('split halves the width',
        Math.abs(sshTab.terms[0].el.getBoundingClientRect().width - sshTab.terms[1].el.getBoundingClientRect().width) < 8,
        box(sshTab.terms[0].el) + ' | ' + box(sshTab.terms[1].el))
    }
  } else {
    ok('ssh fixture configured', false, 'no port supplied')
  }

  // ------------------------------------------------- overwrite behaviour --
  if (sshTerm?.connId && cfg.scratch) {
    const conn = sshTerm.connId
    const base = 'clash-' + Date.now() + '.txt'
    const local = cfg.scratch + '/' + base
    await window.mx.files.localRename(
      (await (async () => {
        await window.mx.sftp.write(conn, '/seed.txt', 'seed\n')
        const r = (await window.mx.sftp.download(conn, ['/seed.txt'], cfg.scratch)).results
        return r[0].path
      })()), local)

    // First upload: no clash, no dialog.
    await window.mx.settings.patch({ transfers: { overwritePolicy: 'ask' } })
    const first = (await window.mx.sftp.upload(conn, [local], '/')).results
    ok('first upload needs no decision', first.every((r) => r.ok && !r.skipped), JSON.stringify(first))

    // Second upload clashes: the dialog must appear and offer four ways out.
    const clash = window.mx.sftp.upload(conn, [local], '/')
    const asked = await waitFor(
      () => document.querySelector('.overlay .dialog header h3')?.textContent === 'File already exists', 8000)
    ok('overwrite prompt appears instead of clobbering', asked,
      document.querySelector('.overlay .dialog header h3')?.textContent || 'no dialog')
    if (asked) {
      const labels = [...document.querySelectorAll('.overlay .dialog footer button')].map((b) => b.textContent)
      ok('prompt offers cancel / skip / keep both / overwrite',
        labels.join(',') === 'Cancel transfer,Skip,Keep both,Overwrite', JSON.stringify(labels))
      ;[...document.querySelectorAll('.overlay .dialog footer button')].find((b) => b.textContent === 'Keep both').click()
    }
    const kept = (await clash).results
    const copyName = base.replace('.txt', ' (1).txt')
    ok('“Keep both” writes a numbered copy', kept[0]?.path?.endsWith(copyName), JSON.stringify(kept))

    // Skip must leave the original untouched.
    const skipRun = window.mx.sftp.upload(conn, [local], '/')
    if (await waitFor(() => document.querySelector('.overlay .dialog footer button'), 8000)) {
      ;[...document.querySelectorAll('.overlay .dialog footer button')].find((b) => b.textContent === 'Skip').click()
    }
    const skipped = (await skipRun).results
    ok('“Skip” reports the file as skipped', skipped[0]?.skipped === true, JSON.stringify(skipped))

    // A configured policy must not ask at all.
    await window.mx.settings.patch({ transfers: { overwritePolicy: 'overwrite' } })
    const silent = (await window.mx.sftp.upload(conn, [local], '/')).results
    ok('policy "overwrite" skips the prompt entirely',
      silent.every((r) => r.ok && !r.skipped) && !document.querySelector('.overlay'), JSON.stringify(silent))
    await window.mx.settings.patch({ transfers: { overwritePolicy: 'ask' } })

    await window.mx.sftp.remove(conn, ['/seed.txt', '/' + base, '/' + copyName]).catch(() => {})
  }

  // ------------------------------------------------------ cancelling work --
  if (sshTerm?.connId && cfg.bigFile) {
    let cancelled = false
    const stop = window.mx.on('transfer:update', (t) => {
      if (!cancelled && t.state === 'running' && t.name.includes('big.bin')) {
        cancelled = true
        window.mx.transfers.cancel(t.id, 'batch')
      }
    })
    const run = await window.mx.sftp.upload(sshTerm.connId, [cfg.bigFile], '/')
    stop()
    ok('cancel request was issued mid-stream', cancelled)
    ok('cancelled transfer is reported as cancelled, not failed',
      run.results.some((r) => r.cancelled) && !run.results.some((r) => r.ok),
      JSON.stringify(run.results))
    await window.mx.sftp.remove(sshTerm.connId, ['/big.bin']).catch(() => {})
  }

  // ------------------------------------------ interactive password prompt --
  // The spec deliberately carries no password, so ssh2 must ask the user.
  // This is the path that `el(tag, null, …)` used to kill outright.
  if (cfg.port) {
    const pending = window.MX.launchAdhoc({
      type: 'ssh', name: 'pwprompt', host: cfg.host, port: cfg.port,
      username: cfg.username, openSftp: false, useAgent: false
    })
    pending.catch(() => {})
    const asked = await waitFor(
      () => document.querySelector('.overlay .dialog header h3')?.textContent === 'SSH authentication', 12000)
    ok('password prompt appears when no password is stored', asked,
      document.querySelector('.overlay .dialog header h3')?.textContent || 'no dialog')
    if (asked) {
      const field = document.querySelector('.overlay .dialog input[type="password"]')
      ok('password prompt has a masked field', Boolean(field))
      field.value = cfg.password
      document.querySelector('.overlay .dialog footer button:last-child').click()
      await pending.catch(() => {})
      const tab = window.Tabs.list().find((t) => t.spec.name === 'pwprompt')
      const up = await waitFor(() => tab?.terms[0]?.alive && tab.terms[0].connId, 15000)
      ok('typed password completes the connection', up,
        tab ? bufText(tab.terms[0]).slice(-200) : 'no tab')
      tab?.close()
      await sleep(200)
    }
  }

  // ------------------------------- password prompt with an agent configured --
  // Regression: a configured ssh-agent used to suppress the password prompt
  // outright, so an account the agent holds no key for failed with "All
  // configured authentication methods failed" and no way to type anything.
  // The fixture advertises publickey as well as password, like a stock sshd.
  if (cfg.port) {
    const pending = window.MX.launchAdhoc({
      type: 'ssh', name: 'agentfallback', host: cfg.host, port: cfg.port,
      username: cfg.username, openSftp: false, useAgent: true
    })
    pending.catch(() => {})
    const asked = await waitFor(
      () => document.querySelector('.overlay .dialog header h3')?.textContent === 'SSH authentication', 15000)
    ok('password prompt still appears when ssh-agent is enabled', asked,
      document.querySelector('.overlay .dialog header h3')?.textContent || 'no dialog')
    if (asked) {
      document.querySelector('.overlay .dialog input[type="password"]').value = cfg.password
      document.querySelector('.overlay .dialog footer button:last-child').click()
      await pending.catch(() => {})
      const tab = window.Tabs.list().find((t) => t.spec.name === 'agentfallback')
      ok('falls back from agent to password and connects',
        await waitFor(() => tab?.terms[0]?.alive && tab.terms[0].connId, 15000),
        tab ? bufText(tab.terms[0]).slice(-200) : 'no tab')
      tab?.close()
      await sleep(200)
    }
  }

  // ------------------------------------------- wrong password is retryable --
  if (cfg.port) {
    const pending = window.MX.launchAdhoc({
      type: 'ssh', name: 'retry', host: cfg.host, port: cfg.port,
      username: cfg.username, openSftp: false, useAgent: false
    })
    pending.catch(() => {})
    let sawRetryHint = false
    for (let attempt = 1; attempt <= 2; attempt++) {
      const up = await waitFor(
        () => document.querySelector('.overlay .dialog header h3')?.textContent === 'SSH authentication', 15000)
      if (!up) break
      if (attempt === 2) {
        out.retryHintSeen = [...document.querySelectorAll('.overlay .dialog .hint')].map((n) => n.textContent)
        sawRetryHint = out.retryHintSeen.some((t) => /Authentication failed/.test(t))
      }
      document.querySelector('.overlay .dialog input[type="password"]').value =
        attempt === 1 ? 'definitely-not-the-password' : cfg.password
      document.querySelector('.overlay .dialog footer button:last-child').click()
      await sleep(400)
    }
    await pending.catch(() => {})
    ok('a rejected password re-prompts instead of giving up', sawRetryHint, JSON.stringify(out.retryHintSeen))
    const tab = window.Tabs.list().find((t) => t.spec.name === 'retry')
    ok('the second, correct password connects',
      await waitFor(() => tab?.terms[0]?.alive, 15000),
      tab ? bufText(tab.terms[0]).slice(-200) : 'no tab')
    tab?.close()
    await sleep(200)
  }

  // ------------------------------------------------- dialogs without icons --
  // Every one of these crashed before: they pass no `icon`, which used to make
  // the header builder call Object.entries(null).
  for (const [label, fn] of [
    ['About', () => window.ToolsUI.about()],
    ['System information', () => window.ToolsUI.sysinfo()],
    ['Keyboard shortcuts', () => window.ToolsUI.hotkeys()],
    ['X11 server', () => window.ToolsUI.x11()]
  ]) {
    fn()
    const opened = await waitFor(() => document.querySelector('.overlay .dialog'), 6000)
    ok(`${label} dialog opens`, opened)
    if (opened) {
      const dlg = document.querySelector('.overlay .dialog')
      ok(`${label} dialog has body content`, dlg.querySelector('.body').children.length > 0,
        'children=' + dlg.querySelector('.body').children.length)
      dlg.querySelector('header .x').click()
      await sleep(200)
    }
  }

  // D.confirm and D.input take no icon either.
  const confirmPromise = window.D.confirm({ title: 'Probe', message: 'ok?' })
  const confirmUp = await waitFor(() => document.querySelector('.overlay .dialog header h3')?.textContent === 'Probe', 4000)
  ok('confirm() dialog opens', confirmUp)
  if (confirmUp) document.querySelector('.overlay .dialog footer button:first-child').click()
  await confirmPromise
  await sleep(150)

  const inputPromise = window.D.input({ title: 'Probe input', label: 'Value', value: 'x' })
  const inputUp = await waitFor(() => document.querySelector('.overlay .dialog header h3')?.textContent === 'Probe input', 4000)
  ok('input() dialog opens', inputUp)
  if (inputUp) document.querySelector('.overlay .dialog footer button:last-child').click()
  ok('input() returns the typed value', (await inputPromise) === 'x')
  await sleep(150)

  // ------------------------------------------------------- save output ----
  if (shellTerm?.alive && cfg.scratch) {
    ok('bufferText returns the scrollback as text',
      shellTerm.bufferText().includes('GONDS_PTY_OK'),
      JSON.stringify(shellTerm.bufferText().slice(-120)))
    await shellTerm.copyBuffer()
    const clip = await window.mx.clipboard.read()
    ok('“Copy all output” puts the scrollback on the clipboard',
      clip.includes('GONDS_PTY_OK'), JSON.stringify(clip.slice(-80)))
    // The save path goes through a native dialog, which cannot be driven from
    // here — only its entry point is asserted. Writing the chosen file is left
    // to manual checking.
    ok('term.saveOutput is reachable from the renderer',
      typeof window.mx.term.saveOutput === 'function')
  }

  // --------------------------------------------------------- hotkey editor --
  {
    const hk = await window.mx.settings.hotkeys()
    ok('hotkey map is served with labels and defaults',
      hk.current && hk.defaults && hk.labels && Object.keys(hk.labels).length > 10,
      Object.keys(hk.current || {}).length + ' actions')

    const accel = window.ToolsUI.toAccelerator
    ok('accelerator capture builds Electron syntax',
      accel({ metaKey: true, shiftKey: true, key: 'k' }) === 'Cmd+Shift+K',
      String(accel({ metaKey: true, shiftKey: true, key: 'k' })))
    ok('accelerator capture rejects an unmodified letter',
      accel({ key: 'k' }) === null)
    ok('accelerator capture allows a bare function key',
      accel({ key: 'F5' }) === 'F5')
    ok('accelerator capture ignores a modifier held alone',
      accel({ metaKey: true, key: 'Meta' }) === null)

    // Round-trip a real change through main, then put it back.
    const original = hk.current['clear-terminal']
    await window.mx.settings.setHotkeys({ ...hk.current, 'clear-terminal': 'Cmd+Alt+L' })
    const after = await window.mx.settings.hotkeys()
    ok('a changed shortcut is persisted', after.current['clear-terminal'] === 'Cmd+Alt+L',
      after.current['clear-terminal'])
    await window.mx.settings.setHotkeys({ ...hk.current, 'clear-terminal': original })

    window.ToolsUI.hotkeyEditor()
    const edOpen = await waitFor(() => document.querySelector('.overlay .dialog tbody tr'), 6000)
    ok('hotkey editor lists every action with Record buttons', edOpen,
      document.querySelectorAll('.overlay .dialog tbody tr').length + ' rows')
    ok('each row offers a Record button',
      [...document.querySelectorAll('.overlay .dialog tbody button')].some((b) => b.textContent === 'Record'))
    document.querySelector('.overlay .dialog header .x').click()
    await sleep(200)
  }

  // ------------------------------------------------------ window geometry --
  if (cfg.seededBounds) {
    // The driver wrote these bounds into the profile before launch, so the
    // window must have come up at that size rather than the 1440x900 default.
    const w = window.outerWidth
    const h = window.outerHeight
    ok('window reopens at its saved size',
      Math.abs(w - cfg.seededBounds.width) <= 2 && Math.abs(h - cfg.seededBounds.height) <= 2,
      `got ${w}x${h}, saved ${cfg.seededBounds.width}x${cfg.seededBounds.height}`)
  }

  // --------------------------------------------------------- tab restore ---
  {
    const snap = window.Tabs.serialise()
    ok('tab layout serialises with an active index',
      Array.isArray(snap.tabs) && snap.tabs.length > 0 && Number.isInteger(snap.activeIndex),
      JSON.stringify(snap.tabs.map((t) => t.kind)))
    const dumped = JSON.stringify(snap)
    ok('no secret is written into the saved layout',
      !/"password"|"passphrase"/.test(dumped), dumped.slice(0, 160))
    ok('saved layout keeps the host so it can reconnect',
      snap.tabs.some((t) => t.spec && t.spec.host === cfg.host))
    out.savedLayout = snap.tabs.map((t) => t.kind + ':' + (t.spec?.name || ''))

    // Replay a layout the way a fresh launch would.
    const before = window.Tabs.list().length
    const reopened = await window.Tabs.restore({
      tabs: [{ kind: 'session', spec: { type: 'shell', name: 'restored-shell' }, pinned: true }],
      activeIndex: 0
    })
    ok('restore() reopens a saved tab', reopened && window.Tabs.list().length === before + 1,
      `${before} -> ${window.Tabs.list().length}`)
    const back = window.Tabs.list().find((t) => t.spec.name === 'restored-shell')
    ok('restored tab actually connects', await waitFor(() => back?.terms[0]?.alive, 10000))
    ok('restored tab keeps its pinned flag', back?.pinned === true)
    back?.close()
    await sleep(200)

    ok('restore() of an empty layout reports nothing done',
      (await window.Tabs.restore({ tabs: [], activeIndex: 0 })) === false)
  }

  // ---------------------------------------------------------- data tables --
  // A table built by ToolsUI.table() must keep its header row and its first
  // column; both used to be swallowed as if they were an attributes object.
  const probeTable = window.ToolsUI.table(
    [{ label: 'A', get: (r) => r.a }, { label: 'B', get: (r) => r.b }],
    [{ a: '1', b: '2' }]
  )
  ok('table renders a header row', probeTable.querySelectorAll('thead th').length === 2,
    'th=' + probeTable.querySelectorAll('thead th').length)
  ok('table renders every cell', probeTable.querySelectorAll('tbody td').length === 2,
    'td=' + probeTable.querySelectorAll('tbody td').length)
  ok('table keeps the first column value',
    probeTable.querySelector('tbody td')?.textContent === '1',
    JSON.stringify([...probeTable.querySelectorAll('tbody td')].map((n) => n.textContent)))

  // ------------------------------------------------------------- session --
  const created = await window.mx.sessions.save({ type: 'ssh', name: '__smoke_tmp', host: '10.255.255.1', port: 22 })
  await window.MX.reloadSessions()
  ok('session created and shown in tree', Boolean(created.id) &&
    [...document.querySelectorAll('#session-tree .tnode .tl')].some((n) => n.textContent === '__smoke_tmp'))
  await window.mx.sessions.remove(created.id)
  await window.MX.reloadSessions()
  ok('session deleted from tree',
    ![...document.querySelectorAll('#session-tree .tnode .tl')].some((n) => n.textContent === '__smoke_tmp'))

  // --------------------------------------------------------------- tools --
  window.ToolsUI.settings()
  ok('settings dialog opens', Boolean(document.querySelector('.overlay .dialog')))
  document.querySelector('.overlay .dialog header .x')?.click()
  await sleep(150)
  ok('settings dialog closes', !document.querySelector('.overlay'))

  const scan = await window.mx.tools.netscan({ range: '127.0.0.1', ports: cfg.port ? [cfg.port] : [22], timeout: 600 })
  ok('netscan sees the fixture port', cfg.port ? scan.hosts.length === 1 : true, JSON.stringify(scan.hosts))

  const keys = await window.mx.tools.listKeys()
  ok('ssh key discovery runs', Array.isArray(keys), String(keys.length) + ' key(s)')

  // ----------------------------------------------------------- broadcast --
  window.MX.broadcast.toggle()
  ok('broadcast engages', window.MX.broadcast.active)
  window.MX.broadcast.toggle()
  ok('broadcast disengages', !window.MX.broadcast.active)
} catch (err) {
  out.error = (err && err.stack) || String(err)
}

out.passed = out.steps.filter((s) => s.pass).length
out.failed = out.steps.filter((s) => !s.pass).length
return out
