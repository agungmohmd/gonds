'use strict'
/* global window, document, U, D, Tabs */

const ToolsUI = (() => {
  const { el, icon } = U

  function table (cols, rows, opts = {}) {
    const thead = el('tr', {}, ...cols.map((c) => el('th', { text: c.label })))
    const tbody = el('tbody')
    for (const r of rows) {
      tbody.append(el('tr', {}, ...cols.map((c) => {
        const v = c.get(r)
        return el('td', { class: c.ui ? 'ui' : '' }, v instanceof Node ? v : String(v ?? ''))
      })))
    }
    const t = el('table', { class: 'data' }, el('thead', {}, thead), tbody)
    const wrap = el('div', { class: 'scroller' }, t)
    if (!rows.length) return el('div', { class: 'hint', text: opts.empty || 'Nothing to show.' })
    return wrap
  }

  function refreshFooter (api, reload) {
    api.footer.replaceChildren(
      el('div', { class: 'left' }, el('button', { class: 'btn', text: 'Refresh', onclick: reload })),
      el('button', { class: 'btn primary', text: 'Close', onclick: () => api.close(null) })
    )
  }

  // ------------------------------------------------------------- settings --
  function settings () {
    const s = JSON.parse(JSON.stringify(window.MX.settings))
    const schemes = window.MX.schemes
    let tab = 'terminal'
    let api

    const render = (b) => {
      U.clear(b)
      const strip = el('div', { class: 'tabstrip' })
      for (const [id, label] of [['terminal', 'Terminal'], ['appearance', 'Appearance'], ['ssh', 'SSH'], ['transfers', 'Transfers'], ['keys', 'Shortcuts']]) {
        strip.append(el('button', { class: tab === id ? 'active' : '', text: label, onclick: () => { tab = id; render(b) } }))
      }
      b.append(strip)
      b.append({ terminal: termPane, appearance: appearancePane, ssh: sshPane, transfers: xferPane, keys: keysPane }[tab]())
    }

    const num = (obj, key, min, max, w = 70) => el('input', {
      type: 'number', value: obj[key], min, max, style: `width:${w}px`,
      oninput: (e) => { obj[key] = Number(e.target.value) }
    })
    const text = (obj, key, ph) => el('input', {
      type: 'text', value: obj[key] ?? '', placeholder: ph || '', spellcheck: 'false',
      oninput: (e) => { obj[key] = e.target.value }
    })
    const check = (obj, key) => el('input', {
      type: 'checkbox', checked: Boolean(obj[key]),
      onchange: (e) => { obj[key] = e.target.checked }
    })
    const select = (obj, key, options) => el('select', {
      onchange: (e) => { obj[key] = e.target.value }
    }, ...options.map(([v, l]) => el('option', { value: v, selected: obj[key] === v }, l)))

    const termPane = () => {
      const t = s.terminal
      const g = el('div', { class: 'grid2' })
      g.append(el('label', { text: 'Font family' }), text(t, 'fontFamily'))
      g.append(el('label', { text: 'Font size' }), num(t, 'fontSize', 7, 36))
      g.append(el('label', { text: 'Line height' }), el('input', {
        type: 'number', step: '0.05', value: t.lineHeight, min: '0.8', max: '2.5', style: 'width:70px',
        oninput: (e) => { t.lineHeight = Number(e.target.value) }
      }))
      g.append(el('label', { text: 'Scrollback' }), num(t, 'scrollback', 100, 500000, 90))
      g.append(el('label', { text: 'Cursor' }), select(t, 'cursorStyle', [['block', 'Block'], ['bar', 'Bar'], ['underline', 'Underline']]))
      g.append(el('label', { text: 'Right click' }), select(t, 'rightClick', [['paste', 'Paste'], ['menu', 'Context menu']]))
      g.append(el('label', { text: 'Word separators' }), text(t, 'wordSeparators'))
      g.append(el('label', { text: 'Behaviour' }), el('div', { class: 'checks' },
        el('label', {}, check(t, 'cursorBlink'), 'Blink cursor'),
        el('label', {}, check(t, 'copyOnSelect'), 'Copy on select'),
        el('label', {}, check(t, 'pasteConfirmNewlines'), 'Confirm multi-line paste')
      ))
      return g
    }

    const appearancePane = () => {
      const wrap = el('div')
      const g = el('div', { class: 'grid2' })
      const schemeSel = el('select', {
        onchange: (e) => { s.terminal.scheme = e.target.value; paintSwatches() }
      }, ...Object.keys(schemes).map((n) => el('option', { value: n, selected: s.terminal.scheme === n }, n)))
      const sw = el('div', { class: 'swatches' })
      const paintSwatches = () => {
        U.clear(sw)
        const sc = schemes[s.terminal.scheme] || {}
        for (const k of ['BackgroundColour', 'ForegroundColour', 'Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White']) {
          sw.append(el('i', { style: `background:${sc[k] || '#000'}`, title: `${k} ${sc[k]}` }))
        }
      }
      paintSwatches()
      g.append(el('label', { text: 'Colour scheme' }), el('div', { class: 'row' }, schemeSel, sw))
      g.append(el('label', { text: 'App theme' }), select(s.ui, 'theme', [['dark', 'Dark'], ['light', 'Light']]))
      g.append(el('label', { text: 'Layout' }), el('div', { class: 'checks' },
        el('label', {}, check(s.ui, 'sidebarVisible'), 'Show sidebar'),
        el('label', {}, check(s.ui, 'sftpAutoOpen'), 'Open SFTP panel on SSH'),
        el('label', {}, check(s.ui, 'showStatusBar'), 'Show status bar'),
        el('label', {}, check(s.ui, 'confirmCloseTab'), 'Confirm tab close'),
        el('label', {}, check(s.ui, 'restoreTabs'), 'Reopen tabs on launch')
      ))
      wrap.append(g)
      wrap.append(el('div', { class: 'hint', style: 'margin-top:12px', text: 'Scheme keys use PuTTY’s names, so existing PuTTY and xterm palettes paste in directly.' }))
      return wrap
    }

    const sshPane = () => {
      const g = el('div', { class: 'grid2' })
      g.append(el('label', { text: 'Default user' }), text(s.ssh, 'defaultUser'))
      g.append(el('label', { text: 'Connect timeout' }), num(s.ssh, 'connectTimeout', 3, 300))
      g.append(el('label', { text: 'Keepalive interval' }), num(s.ssh, 'keepaliveInterval', 5, 600))
      g.append(el('label', { text: 'Defaults' }), el('div', { class: 'checks' },
        el('label', {}, check(s.ssh, 'keepalive'), 'Keepalive'),
        el('label', {}, check(s.ssh, 'compression'), 'Compression'),
        el('label', {}, check(s.ssh, 'useAgent'), 'Use ssh-agent'),
        el('label', {}, check(s.ssh, 'agentForward'), 'Forward agent'),
        el('label', {}, check(s.ssh, 'x11Forward'), 'Forward X11')
      ))
      g.append(el('div', {
        class: 'wide2 hint',
        text: 'Host keys are verified against Gonds’s own store (not ~/.ssh/known_hosts). A changed key always prompts.'
      }))
      return g
    }

    const xferPane = () => {
      const g = el('div', { class: 'grid2' })
      g.append(el('label', { text: 'SFTP panel width' }), num(s.ui, 'sftpPanelWidth', 170, 640, 90))
      g.append(el('label', { text: 'Behaviour' }), el('div', { class: 'checks' },
        el('label', {}, check(s.transfers, 'followTerminalCwd'), 'Follow terminal cwd (OSC 7)')
      ))
      g.append(el('label', { text: 'If the file exists' }), select(s.transfers, 'overwritePolicy', [
        ['ask', 'Ask every time'],
        ['overwrite', 'Overwrite'],
        ['skip', 'Skip'],
        ['rename', 'Keep both (rename)']
      ]))
      g.append(el('div', {
        class: 'wide2 hint',
        text: 'Directory transfers skip symlinks rather than following them. A running transfer can be cancelled from the ✕ in the SFTP panel’s progress list; cancelling also drops whatever is still queued behind it.'
      }))
      return g
    }

    const keysPane = () => {
      const wrap = el('div')
      wrap.append(el('div', { class: 'hint', style: 'margin-bottom:10px' },
        'Shortcuts drive the macOS menu bar and are edited in their own window.'))
      wrap.append(el('button', {
        class: 'btn primary',
        text: 'Edit keyboard shortcuts…',
        onclick: () => { api.close(null); hotkeyEditor() }
      }))
      wrap.append(table(
        [{ label: 'Action', get: (r) => r[0], ui: true }, { label: 'Shortcut', get: (r) => prettyAccel(r[1]) }],
        Object.entries(s.hotkeys)
      ))
      return wrap
    }

    api = D.open({
      title: 'Settings',
      icon: 'i-settings',
      width: 'wide',
      body: render,
      footer: (f) => f.append(
        el('div', { class: 'left' }, el('button', {
          class: 'btn danger',
          text: 'Reset to defaults',
          onclick: async () => {
            if (!await D.confirm({ title: 'Reset settings', message: 'Restore every setting to its default?', okLabel: 'Reset', danger: true })) return
            await window.mx.settings.reset()
            await window.MX.reloadSettings()
            api.close(null)
            U.toast('Settings reset', 'ok')
          }
        })),
        el('button', { class: 'btn', text: 'Cancel', onclick: () => api.close(null) }),
        el('button', {
          class: 'btn primary',
          text: 'Apply',
          onclick: async () => {
            await window.mx.settings.patch(s)
            await window.MX.reloadSettings()
            window.MX.applyAppearance()
            api.close(true)
            U.toast('Settings applied', 'ok')
          }
        })
      )
    })
  }

  // ------------------------------------------------------------- netscan ---
  function netscan () {
    let api, out, rangeInp, portsInp, runBtn, progress
    const unsub = window.mx.on('netscan:progress', ({ done, total }) => {
      if (progress) progress.textContent = `${done}/${total} probes`
    })

    const run = async () => {
      runBtn.disabled = true
      U.clear(out)
      out.append(el('div', { class: 'hint', text: 'scanning…' }))
      try {
        const ports = portsInp.value.split(',').map((x) => Number(x.trim())).filter(Boolean)
        const res = await window.mx.tools.netscan({ range: rangeInp.value.trim(), ports })
        U.clear(out)
        out.append(el('div', { class: 'hint', style: 'margin-bottom:8px', text: `${res.hosts.length} responding host(s) from ${res.scanned} address(es), ${res.probes} probes.` }))
        out.append(table([
          { label: 'Host', get: (r) => r.host },
          { label: 'Name', get: (r) => r.hostname || '', ui: true },
          { label: 'Open ports', get: (r) => r.ports.join(', ') },
          {
            label: '',
            get: (r) => r.ports.includes(22)
              ? el('button', { class: 'btn sm', text: 'SSH', onclick: () => { api.close(null); window.MX.launchAdhoc({ type: 'ssh', host: r.host, port: 22, name: r.hostname || r.host }) } })
              : ''
          }
        ], res.hosts, { empty: 'No host answered on the probed ports.' }))
      } catch (e) {
        U.clear(out)
        out.append(el('div', { class: 'err', text: e.message }))
      }
      runBtn.disabled = false
    }

    api = D.open({
      title: 'Network scanner',
      icon: 'i-search',
      width: 'wide',
      onClose: () => unsub(),
      body: (b) => {
        rangeInp = el('input', { type: 'text', value: guessRange(), placeholder: '192.168.1.0/24', spellcheck: 'false' })
        portsInp = el('input', { type: 'text', value: '22,80,443,3389,5900', spellcheck: 'false' })
        progress = el('span', { class: 'hint' })
        runBtn = el('button', { class: 'btn primary', text: 'Scan', onclick: run })
        out = el('div', { style: 'margin-top:12px' })
        b.append(el('div', { class: 'grid2' },
          el('label', { text: 'Range' }), rangeInp,
          el('label', { text: 'Ports' }), portsInp,
          el('label', {}), el('div', { class: 'row' }, runBtn, progress)
        ), out)
        b.append(el('div', { class: 'hint', style: 'margin-top:10px', text: 'TCP connect scan, IPv4, max 1024 addresses. For OS/service fingerprinting use nmap.' }))
        return rangeInp
      },
      footer: (f) => f.append(el('button', { class: 'btn primary', text: 'Close', onclick: () => api.close(null) }))
    })
  }

  function guessRange () {
    const ifs = window.MX.sysinfo?.interfaces || []
    for (const i of ifs) {
      for (const a of i.addresses) {
        const m = /^(\d+)\.(\d+)\.(\d+)\.\d+\/IPv4$/.exec(a)
        if (m && m[1] !== '127') return `${m[1]}.${m[2]}.${m[3]}.0/24`
      }
    }
    return '192.168.1.0/24'
  }

  // ------------------------------------------------------- netstat / ports --
  function netstat () {
    let api
    const load = async (b) => {
      U.clear(b)
      b.append(el('div', { class: 'hint', text: 'loading…' }))
      try {
        const rows = await window.mx.tools.netstat()
        U.clear(b)
        b.append(table([
          { label: 'Proto', get: (r) => r.proto },
          { label: 'Local', get: (r) => r.local },
          { label: 'Remote', get: (r) => r.remote },
          { label: 'State', get: (r) => r.state }
        ], rows))
      } catch (e) { U.clear(b); b.append(el('div', { class: 'err', text: e.message })) }
    }
    api = D.open({
      title: 'Network connections',
      icon: 'i-tunnel',
      width: 'wide',
      body: (b) => { load(b) },
      footer: (f, a) => refreshFooter(a, () => load(a.body))
    })
  }

  function ports () {
    let api
    const load = async (b) => {
      U.clear(b)
      try {
        const res = await window.mx.tools.ports()
        U.clear(b)
        if (res.error) b.append(el('div', { class: 'hint', text: res.error }))
        b.append(table([
          { label: 'Port', get: (r) => r.port ?? '' },
          { label: 'Process', get: (r) => r.command, ui: true },
          { label: 'PID', get: (r) => r.pid },
          { label: 'User', get: (r) => r.user },
          { label: 'Address', get: (r) => r.address }
        ], res.rows, { empty: 'No listening TCP sockets visible to this user.' }))
      } catch (e) { U.clear(b); b.append(el('div', { class: 'err', text: e.message })) }
    }
    api = D.open({
      title: 'Listening ports',
      icon: 'i-server',
      width: 'wide',
      body: (b) => { load(b) },
      footer: (f, a) => refreshFooter(a, () => load(a.body))
    })
  }

  function processes () {
    let api
    const load = async (b) => {
      U.clear(b)
      try {
        const rows = (await window.mx.tools.processes()).slice(0, 400)
        U.clear(b)
        b.append(table([
          { label: 'PID', get: (r) => r.pid },
          { label: '%CPU', get: (r) => r.cpu.toFixed(1) },
          { label: '%MEM', get: (r) => r.mem.toFixed(1) },
          { label: 'User', get: (r) => r.user },
          { label: 'Command', get: (r) => r.command }
        ], rows))
      } catch (e) { U.clear(b); b.append(el('div', { class: 'err', text: e.message })) }
    }
    api = D.open({
      title: 'Process list',
      icon: 'i-broadcast',
      width: 'wide',
      body: (b) => { load(b) },
      footer: (f, a) => refreshFooter(a, () => load(a.body))
    })
  }

  async function sysinfo () {
    let info
    try { info = await window.mx.tools.sysinfo() } catch (e) { return U.err(e) }
    window.MX.sysinfo = info
    const rows = [
      ['Hostname', info.hostname],
      ['macOS', info.swVers.replace(/\n/g, ' · ')],
      ['Kernel', info.platform],
      ['Architecture', info.arch],
      ['CPU', `${info.cpuModel} × ${info.cpus}`],
      ['Memory', `${U.bytes(info.totalMem)} total · ${U.bytes(info.freeMem)} free`],
      ['Uptime', U.duration(info.uptime)],
      ['Model', info.model?.machine_model || ''],
      ['Chip', info.model?.chip_type || info.model?.cpu_type || ''],
      ['Serial', info.model?.serial_number || '']
    ].filter((r) => r[1])
    const body = el('div', {},
      table([{ label: 'Item', get: (r) => r[0], ui: true }, { label: 'Value', get: (r) => r[1] }], rows),
      el('h2', { style: 'font-size:11px;color:var(--fg-faint);margin:14px 0 6px', text: 'NETWORK INTERFACES' }),
      table([{ label: 'Interface', get: (r) => r.name }, { label: 'Addresses', get: (r) => r.addresses.join(', ') }], info.interfaces)
    )
    D.info({ title: 'System information', width: 'wide', body })
  }

  // ------------------------------------------------------------- packages --
  function packages () {
    let api
    const load = async (b) => {
      U.clear(b)
      b.append(el('div', { class: 'hint', text: 'checking…' }))
      try {
        const res = await window.mx.tools.packages()
        U.clear(b)
        if (!res.brew) {
          b.append(el('div', { class: 'hint', style: 'margin-bottom:10px', html: 'Homebrew is not installed. Install it from <code>https://brew.sh</code> to manage these packages from here.' }))
        } else {
          b.append(el('div', { class: 'hint', style: 'margin-bottom:10px', text: `Homebrew: ${res.brewPath}` }))
        }
        b.append(table([
          { label: 'Tool', get: (r) => r.name, ui: true },
          { label: 'Purpose', get: (r) => r.why, ui: true },
          { label: 'Status', get: (r) => el('span', { class: r.installed ? 'ok' : '', text: r.installed ? 'installed' : '—' }) },
          {
            label: '',
            get: (r) => r.installed || !res.brew
              ? ''
              : el('button', {
                class: 'btn sm',
                text: 'Install',
                onclick: async (e) => {
                  e.target.disabled = true
                  e.target.textContent = 'installing…'
                  const out = await window.mx.tools.brew(r.cask ? ['install', '--cask', r.formula] : ['install', r.formula])
                  U.toast(out.ok ? `${r.name} installed` : `brew failed: ${(out.stderr || '').split('\n')[0]}`, out.ok ? 'ok' : 'err', 8000)
                  load(b)
                }
              })
          }
        ], res.packages))
        b.append(el('div', { class: 'hint', style: 'margin-top:10px', text: 'macOS already ships most POSIX tools. These are the few it does not, pulled from Homebrew rather than bundled as a private copy.' }))
      } catch (e) { U.clear(b); b.append(el('div', { class: 'err', text: e.message })) }
    }
    api = D.open({
      title: 'Packages',
      icon: 'i-package',
      width: 'wide',
      body: (b) => { load(b) },
      footer: (f, a) => refreshFooter(a, () => load(a.body))
    })
  }

  // --------------------------------------------------------------- keygen --
  function keygen () {
    let api, typeSel, bitsInp, fileInp, commentInp, passInp, out
    api = D.open({
      title: 'SSH key generator',
      icon: 'i-key',
      body: (b) => {
        typeSel = el('select', {}, ...[['ed25519', 'ed25519 (recommended)'], ['rsa', 'RSA'], ['ecdsa', 'ECDSA']]
          .map(([v, l]) => el('option', { value: v }, l)))
        bitsInp = el('input', { type: 'number', value: '4096', style: 'width:84px' })
        fileInp = el('input', { type: 'text', placeholder: '~/.ssh/id_ed25519_gonds', spellcheck: 'false' })
        commentInp = el('input', { type: 'text', placeholder: 'user@mac' })
        passInp = el('input', { type: 'password', placeholder: '(empty = no passphrase)' })
        out = el('div', { style: 'margin-top:12px' })
        b.append(el('div', { class: 'grid2' },
          el('label', { text: 'Type' }), typeSel,
          el('label', { text: 'Bits (RSA/ECDSA)' }), bitsInp,
          el('label', { text: 'File' }), fileInp,
          el('label', { text: 'Comment' }), commentInp,
          el('label', { text: 'Passphrase' }), passInp
        ), out)
        b.append(el('div', { class: 'hint', style: 'margin-top:10px', text: 'Runs /usr/bin/ssh-keygen. An existing file is never overwritten.' }))
        return typeSel
      },
      footer: (f) => f.append(
        el('button', { class: 'btn', text: 'Close', onclick: () => api.close(null) }),
        el('button', {
          class: 'btn primary',
          text: 'Generate',
          onclick: async (e) => {
            e.target.disabled = true
            try {
              const res = await window.mx.tools.keygen({
                type: typeSel.value,
                bits: Number(bitsInp.value),
                file: fileInp.value.trim() || undefined,
                comment: commentInp.value.trim() || undefined,
                passphrase: passInp.value
              })
              U.clear(out)
              out.append(
                el('div', { class: 'hint', style: 'margin-bottom:6px', text: res.fingerprint }),
                el('pre', { class: 'out', text: res.publicKeyText }),
                el('div', { class: 'row', style: 'margin-top:8px' },
                  el('button', { class: 'btn sm', text: 'Copy public key', onclick: () => { window.mx.clipboard.write(res.publicKeyText); U.toast('Copied', 'ok') } }),
                  el('button', { class: 'btn sm', text: 'Reveal in Finder', onclick: () => window.mx.files.reveal(res.privateKey) })
                )
              )
              U.toast(`Key written to ${res.privateKey}`, 'ok', 7000)
            } catch (err) { U.err(err) }
            e.target.disabled = false
          }
        })
      )
    })
  }

  // --------------------------------------------------- known hosts / pw ----
  function knownHosts () {
    let api
    const load = async (b) => {
      U.clear(b)
      const rows = await window.mx.tools.knownHosts()
      b.append(table([
        { label: 'Host', get: (r) => r.host },
        { label: 'Fingerprint', get: (r) => r.fingerprint },
        { label: 'Added', get: (r) => (r.addedAt || '').slice(0, 10) },
        {
          label: '',
          get: (r) => el('button', {
            class: 'btn sm danger',
            text: 'Forget',
            onclick: async () => {
              const [h, p] = r.host.split(':')
              await window.mx.tools.forgetHost(h, Number(p))
              load(b)
            }
          })
        }
      ], rows, { empty: 'No host keys stored yet.' }))
      b.append(el('div', { class: 'hint', style: 'margin-top:10px', text: 'Gonds keeps its own store at ~/Library/Application Support/Gonds/known_hosts.json.' }))
    }
    api = D.open({ title: 'Known host keys', icon: 'i-key', width: 'wide', body: (b) => { load(b) }, footer: (f, a) => refreshFooter(a, () => load(a.body)) })
  }

  function passwords () {
    let api
    const load = async (b) => {
      U.clear(b)
      const rows = await window.mx.secret.list()
      const withState = []
      for (const r of rows) {
        let stored = false
        try { stored = Boolean(await window.mx.secret.get(r.id)) } catch { stored = false }
        withState.push({ ...r, stored })
      }
      U.clear(b)
      b.append(table([
        { label: 'Session', get: (r) => r.name, ui: true },
        { label: 'Target', get: (r) => r.host ? `${r.username ? r.username + '@' : ''}${r.host}` : '' },
        { label: 'Keychain', get: (r) => el('span', { class: r.stored ? 'ok' : '', text: r.stored ? 'stored' : '—' }) },
        {
          label: '',
          get: (r) => el('div', { class: 'row' },
            el('button', {
              class: 'btn sm',
              text: r.stored ? 'Replace' : 'Set',
              onclick: async () => {
                const pw = await D.input({ title: `Password — ${r.name}`, label: 'Password', password: true })
                if (pw == null) return
                await window.mx.secret.set(r.id, pw)
                load(b)
              }
            }),
            r.stored
              ? el('button', {
                class: 'btn sm danger',
                text: 'Remove',
                onclick: async () => { await window.mx.secret.remove(r.id); load(b) }
              })
              : ''
          )
        }
      ], withState, { empty: 'No sessions yet.' }))
      b.append(el('div', { class: 'hint', style: 'margin-top:10px', text: 'Secrets live in the macOS login Keychain under service “Gonds” — not in any Gonds file. The system master password is your login password.' }))
    }
    api = D.open({ title: 'Saved passwords', icon: 'i-key', width: 'wide', body: (b) => { load(b) }, footer: (f, a) => refreshFooter(a, () => load(a.body)) })
  }

  // --------------------------------------------------------------- macros --
  function macros () {
    let api
    const load = async (b) => {
      U.clear(b)
      await window.MX.reloadSettings()
      const list = window.MX.settings.macros || []
      b.append(table([
        { label: 'Name', get: (m) => m.name, ui: true },
        { label: 'Lines', get: (m) => (m.lines || []).length },
        { label: 'Preview', get: (m) => (m.lines || []).join(' ⏎ ').slice(0, 60) },
        {
          label: '',
          get: (m) => el('div', { class: 'row' },
            el('button', { class: 'btn sm', text: 'Run', onclick: () => window.MX.runMacro(m) }),
            el('button', { class: 'btn sm', text: 'Edit', onclick: () => { api.close(null); macroEdit(m) } }),
            el('button', { class: 'btn sm danger', text: 'Del', onclick: async () => { await window.mx.macros.remove(m.id); load(b) } })
          )
        }
      ], list, { empty: 'No macros yet.' }))
    }
    api = D.open({
      title: 'Macros',
      icon: 'i-macro',
      width: 'wide',
      body: (b) => { load(b) },
      footer: (f, a) => f.append(
        el('div', { class: 'left' }, el('button', { class: 'btn', text: '+ New macro', onclick: () => { a.close(null); macroEdit() } })),
        el('button', { class: 'btn primary', text: 'Close', onclick: () => a.close(null) })
      )
    })
  }

  function macroEdit (macro) {
    const m = { name: '', lines: [], sendNewline: true, ...macro }
    let api, nameInp, area, nlChk
    api = D.open({
      title: macro ? `Edit macro — ${macro.name}` : 'New macro',
      icon: 'i-macro',
      body: (b) => {
        nameInp = el('input', { type: 'text', value: m.name, placeholder: 'Restart nginx' })
        area = el('textarea', { rows: '10', spellcheck: 'false' }, (m.lines || []).join('\n'))
        area.style.cssText = 'width:100%;font-family:var(--mono);font-size:11.5px'
        nlChk = el('input', { type: 'checkbox', checked: m.sendNewline !== false })
        b.append(el('div', { class: 'grid2' },
          el('label', { text: 'Name' }), nameInp,
          el('label', { text: 'Lines' }), area,
          el('label', { text: 'Send ⏎ per line' }), nlChk
        ))
        b.append(el('div', { class: 'hint', style: 'margin-top:8px', text: 'Each line is sent to the focused terminal in order. Nothing is executed locally.' }))
        return nameInp
      },
      footer: (f) => f.append(
        el('button', { class: 'btn', text: 'Cancel', onclick: () => api.close(null) }),
        el('button', {
          class: 'btn primary',
          text: 'Save',
          onclick: async () => {
            const name = nameInp.value.trim()
            if (!name) return U.toast('Name is required', 'warn')
            const lines = area.value.split('\n').filter((l) => l.length)
            await window.mx.macros.save({ id: m.id, name, lines, sendNewline: nlChk.checked })
            await window.MX.reloadSettings()
            window.Sidebar.paintMacros()
            api.close(true)
            U.toast('Macro saved', 'ok')
          }
        })
      )
    })
  }

  // -------------------------------------------------------------- tunnels --
  function tunnels (preferredTerm) {
    let api, out
    const sshTerms = () => {
      const list = []
      for (const tab of Tabs.list()) {
        for (const term of tab.terms) if (term.connId && term.alive) list.push({ tab, term })
      }
      return list
    }

    const load = async (b) => {
      U.clear(b)
      const avail = sshTerms()
      if (!avail.length) {
        b.append(el('div', { class: 'hint', text: 'No live SSH session. Open one first — tunnels run inside an SSH connection.' }))
        return
      }
      const sel = el('select', {}, ...avail.map(({ tab, term }, i) =>
        el('option', { value: String(i), selected: preferredTerm === term }, `${tab.title} (${term.spec.host})`)))
      const kind = el('select', {}, ...[['local', 'Local → remote (-L)'], ['remote', 'Remote → local (-R)'], ['dynamic', 'Dynamic SOCKS5 (-D)']]
        .map(([v, l]) => el('option', { value: v }, l)))
      const localPort = el('input', { type: 'number', value: '8080', style: 'width:92px' })
      const remoteHost = el('input', { type: 'text', value: '127.0.0.1', spellcheck: 'false' })
      const remotePort = el('input', { type: 'number', value: '80', style: 'width:92px' })
      const bind = el('input', { type: 'text', value: '127.0.0.1', spellcheck: 'false' })

      const rowRemote = el('div', { class: 'row' }, remoteHost, el('span', { class: 'hint', text: 'port' }), remotePort)
      const g = el('div', { class: 'grid2' },
        el('label', { text: 'Session' }), sel,
        el('label', { text: 'Kind' }), kind,
        el('label', { text: 'Bind address' }), bind,
        el('label', { text: 'Local port' }), localPort,
        el('label', { text: 'Remote' }), rowRemote
      )
      kind.addEventListener('change', () => {
        rowRemote.style.display = kind.value === 'dynamic' ? 'none' : ''
      })

      out = el('div', { style: 'margin-top:12px' })
      b.append(g, el('div', { class: 'row', style: 'margin-top:10px' },
        el('button', {
          class: 'btn primary',
          text: 'Start tunnel',
          onclick: async () => {
            const { term } = avail[Number(sel.value)]
            try {
              const t = await window.mx.tunnel.add(term.connId, {
                kind: kind.value,
                bindAddress: bind.value.trim() || '127.0.0.1',
                localPort: Number(localPort.value),
                remoteHost: remoteHost.value.trim(),
                remotePort: Number(remotePort.value)
              })
              U.toast(`Tunnel active: ${window.Sidebar.describeTunnel(t)}`, 'ok', 6000)
              window.Sidebar.paintTunnels()
              listActive(out, avail)
            } catch (e) { U.err(e) }
          }
        })
      ), out)
      listActive(out, avail)
    }

    const listActive = async (host, avail) => {
      U.clear(host)
      const rows = []
      for (const { tab, term } of avail) {
        for (const t of await window.mx.tunnel.list(term.connId)) rows.push({ tab, term, t })
      }
      host.append(el('h2', { style: 'font-size:11px;color:var(--fg-faint);margin:6px 0', text: 'ACTIVE TUNNELS' }))
      host.append(table([
        { label: 'Session', get: (r) => r.tab.title, ui: true },
        { label: 'Forward', get: (r) => window.Sidebar.describeTunnel(r.t), ui: true },
        {
          label: '',
          get: (r) => el('button', {
            class: 'btn sm danger',
            text: 'Stop',
            onclick: async () => {
              await window.mx.tunnel.remove(r.term.connId, r.t.id)
              window.Sidebar.paintTunnels()
              listActive(host, avail)
            }
          })
        }
      ], rows, { empty: 'None.' }))
    }

    api = D.open({
      title: 'SSH tunnels',
      icon: 'i-tunnel',
      width: 'wide',
      body: (b) => { load(b) },
      footer: (f, a) => f.append(el('button', { class: 'btn primary', text: 'Close', onclick: () => a.close(null) }))
    })
  }

  // ------------------------------------------------------------------ x11 --
  async function x11 () {
    const st = await window.mx.x11.status()
    const body = el('div', {},
      el('div', { class: 'grid2' },
        el('label', { text: 'XQuartz' }), el('span', { text: st.installed ? st.path : 'not installed' }),
        el('label', { text: 'DISPLAY' }), el('code', { text: st.display || '(unset)' }),
        el('label', { text: 'State' }), el('span', { class: st.running ? 'ok' : '', text: st.running ? 'running' : 'not running' })
      ),
      el('div', { class: 'hint', style: 'margin-top:12px', text: st.installed
        ? 'Enable “Forward X11” on an SSH session to run remote graphical apps through XQuartz. Gonds does not embed an X server — XQuartz is the supported one on macOS.'
        : 'Install with: brew install --cask xquartz. XQuartz is the supported X server on macOS; Gonds does not ship its own.' }),
      el('div', { class: 'row', style: 'margin-top:12px' },
        st.installed
          ? el('button', { class: 'btn primary', text: 'Start XQuartz', onclick: async () => { const r = await window.mx.x11.start(); U.toast(r.started ? 'XQuartz launched' : r.hint, r.started ? 'ok' : 'warn') } })
          : el('button', { class: 'btn', text: 'Copy install command', onclick: () => { window.mx.clipboard.write('brew install --cask xquartz'); U.toast('Copied', 'ok') } })
      )
    )
    D.info({ title: 'X11 server', body })
  }

  // ---------------------------------------------------------------- about --
  async function about () {
    const paths = await window.mx.app.paths()
    const body = el('div', {},
      el('div', { style: 'font-size:15px;font-weight:600;margin-bottom:2px', text: `Gonds ${window.MX.version}` }),
      el('div', { class: 'hint', text: 'All-in-one terminal, SSH client and SFTP browser for macOS.' }),
      el('div', { class: 'hint', style: 'margin-bottom:12px;font-style:italic' },
        'From ', el('b', { text: 'gondrong' }), ' — Indonesian for long-haired.'),
      table([{ label: 'Item', get: (r) => r[0], ui: true }, { label: 'Value', get: (r) => r[1] }], [
        ['Terminal engine', 'xterm.js 5.5'],
        ['SSH / SFTP', 'ssh2 (pure JS)'],
        ['Local pty', 'node-pty'],
        ['Credentials', 'macOS Keychain (/usr/bin/security)'],
        ['Config', paths.userData],
        ['RDP', 'delegated to the installed macOS RDP client'],
        ['VNC', 'delegated to Screen Sharing (vnc://)'],
        ['X11', 'delegated to XQuartz']
      ]),
      el('div', {
        class: 'hint',
        style: 'margin-top:12px;line-height:1.7',
        html: 'Open source under the MIT licence. Terminal rendering by xterm.js, SSH and SFTP by ssh2, ' +
              'local pseudo-terminals by node-pty — each under its own licence.'
      })
    )
    D.info({ title: 'About Gonds', width: 'wide', body })
  }

  // --------------------------------------------------------- hotkey editor --

  /** Turn a keydown into an Electron accelerator, or null if it is modifier-only. */
  function toAccelerator (e) {
    const mods = []
    if (e.metaKey) mods.push('Cmd')
    if (e.ctrlKey) mods.push('Ctrl')
    if (e.altKey) mods.push('Alt')
    if (e.shiftKey) mods.push('Shift')

    const named = {
      ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
      Escape: 'Esc', Enter: 'Return', Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab',
      '+': 'Plus', PageUp: 'PageUp', PageDown: 'PageDown', Home: 'Home', End: 'End'
    }
    let key = named[e.key]
    if (!key) {
      if (/^F\d{1,2}$/.test(e.key)) key = e.key
      else if (e.key.length === 1) key = e.key.toUpperCase()
    }
    if (!key) return null // a bare Shift/Cmd press is not a shortcut yet

    // Electron needs a modifier for ordinary characters, otherwise the key is
    // swallowed globally and never reaches the terminal.
    if (!mods.length && !/^F\d{1,2}$/.test(key)) return null
    return [...mods, key].join('+')
  }

  const prettyAccel = (a) => (a
    ? a.replace(/Cmd/g, '⌘').replace(/Shift/g, '⇧').replace(/Alt/g, '⌥')
      .replace(/Ctrl/g, '⌃').replace(/Plus/g, '+').replace(/\+/g, '')
    : '—')

  function hotkeyEditor () {
    let api, state, defaults, labels, tableHost, warn

    const render = () => {
      U.clear(tableHost)
      const dupes = new Map()
      for (const [id, acc] of Object.entries(state)) {
        if (!acc) continue
        if (!dupes.has(acc)) dupes.set(acc, [])
        dupes.get(acc).push(id)
      }
      const clashing = new Set()
      for (const [, ids] of dupes) if (ids.length > 1) ids.forEach((i) => clashing.add(i))

      const rows = Object.keys(labels).filter((id) => id in state || id in defaults)
      tableHost.append(table([
        { label: 'Action', get: (id) => labels[id] || id, ui: true },
        {
          label: 'Shortcut',
          get: (id) => {
            const span = el('span', { text: prettyAccel(state[id]) })
            if (clashing.has(id)) span.style.color = 'var(--red)'
            return span
          }
        },
        {
          label: '',
          get: (id) => el('div', { class: 'row' },
            el('button', {
              class: 'btn sm',
              text: 'Record',
              onclick: (ev) => record(id, ev.target)
            }),
            el('button', {
              class: 'btn sm',
              text: 'Clear',
              title: 'Unbind this action',
              onclick: () => { state[id] = ''; render() }
            }),
            state[id] !== defaults[id]
              ? el('button', { class: 'btn sm', text: 'Reset', onclick: () => { state[id] = defaults[id]; render() } })
              : ''
          )
        }
      ], rows))

      warn.textContent = clashing.size
        ? 'Two actions share a shortcut (shown in red). The last one wins — macOS will not warn you.'
        : ''
    }

    /** Capture the next keystroke into `id`. */
    function record (id, btn) {
      btn.textContent = 'Press keys…'
      btn.classList.add('primary')
      const onKey = (e) => {
        e.preventDefault()
        e.stopPropagation()
        if (e.key === 'Escape') return stop()
        const acc = toAccelerator(e)
        if (!acc) return // keep listening while only modifiers are held
        state[id] = acc
        stop()
        render()
      }
      const stop = () => {
        window.removeEventListener('keydown', onKey, true)
        btn.textContent = 'Record'
        btn.classList.remove('primary')
      }
      window.addEventListener('keydown', onKey, true)
    }

    api = D.open({
      title: 'Keyboard shortcuts',
      icon: 'i-settings',
      width: 'wide',
      body: (b) => {
        tableHost = el('div')
        warn = el('div', { class: 'err', style: 'margin-top:10px;min-height:14px' })
        b.append(
          el('div', { class: 'hint', style: 'margin-bottom:10px' },
            'These drive the macOS menu bar. Click Record, then press the combination. ' +
            'Ordinary characters need at least one modifier; function keys do not. Esc cancels recording.'),
          tableHost, warn)
        window.mx.settings.hotkeys().then((res) => {
          state = { ...res.current }
          defaults = res.defaults
          labels = res.labels
          render()
        }).catch(U.err)
      },
      footer: (f) => f.append(
        el('div', { class: 'left' }, el('button', {
          class: 'btn',
          text: 'Restore defaults',
          onclick: () => { state = { ...defaults }; render() }
        })),
        el('button', { class: 'btn', text: 'Cancel', onclick: () => api.close(null) }),
        el('button', {
          class: 'btn primary',
          text: 'Apply',
          onclick: async () => {
            try {
              await window.mx.settings.setHotkeys(state)
              await window.MX.reloadSettings()
              api.close(true)
              U.toast('Shortcuts applied', 'ok')
            } catch (e) { U.err(e) }
          }
        })
      )
    })
  }

  const hotkeys = hotkeyEditor

  return {
    settings, netscan, netstat, ports, processes, sysinfo, packages, keygen,
    knownHosts, passwords, macros, macroEdit, tunnels, x11, about, hotkeys,
    hotkeyEditor, toAccelerator, table
  }
})()

window.ToolsUI = ToolsUI
