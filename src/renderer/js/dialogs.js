'use strict'
/* global window, document, U */

const D = (() => {
  const { el, icon, $, clear } = U

  // ---------------------------------------------------------- modal shell --
  /**
   * open({ title, icon, width, body, footer, onClose }) -> { close, root, body }
   * `body` receives the body element and may return a focus target.
   */
  function open (opts) {
    const bodyEl = el('div', { class: 'body' })
    const footEl = el('footer')
    const dlg = el('div', { class: `dialog ${opts.width || ''}` })
    const overlay = el('div', { class: 'overlay' }, dlg)

    const close = (value) => {
      document.removeEventListener('keydown', onKey, true)
      overlay.remove()
      opts.onClose?.(value)
    }

    const header = el('header', {},
      opts.icon ? icon(opts.icon) : null,
      el('h3', { text: opts.title || '' }),
      el('button', { class: 'x', title: 'Close', onclick: () => close(null) }, icon('i-close'))
    )
    dlg.append(header, bodyEl, footEl)

    const api = { close, root: dlg, body: bodyEl, footer: footEl }
    const focusTarget = opts.body?.(bodyEl, api)
    if (opts.footer) opts.footer(footEl, api)
    else footEl.append(el('button', { class: 'btn primary', text: 'Close', onclick: () => close(null) }))

    const onKey = (e) => {
      if (!overlay.isConnected) return
      if (e.key === 'Escape') { e.stopPropagation(); close(null) }
      if (e.key === 'Enter' && opts.enterSubmits && !(e.target.tagName === 'TEXTAREA')) {
        e.stopPropagation()
        opts.enterSubmits(api)
      }
    }
    document.addEventListener('keydown', onKey, true)

    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay && opts.dismissable !== false) close(null) })
    $('#modal-root').append(overlay)
    ;(focusTarget || dlg.querySelector('input, select, textarea, button.primary'))?.focus?.()
    return api
  }

  /** Simple single-field ask. Resolves to the string or null. */
  function input ({ title, label, value = '', placeholder, password, hint, okLabel = 'OK' }) {
    return new Promise((resolve) => {
      let field
      const api = open({
        title,
        width: 'narrow',
        dismissable: true,
        body: (b) => {
          field = el('input', { type: password ? 'password' : 'text', value, placeholder: placeholder || '', spellcheck: 'false' })
          field.style.width = '100%'
          b.append(el('div', { class: 'grid2' },
            el('label', { text: label || '' }), field
          ))
          if (hint) b.append(el('div', { class: 'hint', text: hint, style: 'margin-top:8px' }))
          return field
        },
        footer: (f) => {
          f.append(
            el('button', { class: 'btn', text: 'Cancel', onclick: () => api.close(null) }),
            el('button', { class: 'btn primary', text: okLabel, onclick: () => api.close(field.value) })
          )
        },
        enterSubmits: () => api.close(field.value),
        onClose: (v) => resolve(v)
      })
    })
  }

  function confirm ({ title, message, detail, okLabel = 'OK', danger }) {
    return new Promise((resolve) => {
      const api = open({
        title: title || 'Confirm',
        width: 'narrow',
        body: (b) => {
          b.append(el('div', { text: message, style: 'font-size:12.5px;margin-bottom:6px' }))
          if (detail) b.append(el('div', { class: 'hint', text: detail }))
        },
        footer: (f) => f.append(
          el('button', { class: 'btn', text: 'Cancel', onclick: () => api.close(false) }),
          el('button', { class: `btn ${danger ? 'danger' : 'primary'}`, text: okLabel, onclick: () => api.close(true) })
        ),
        enterSubmits: () => api.close(true),
        onClose: (v) => resolve(Boolean(v))
      })
    })
  }

  function info ({ title, body, width }) {
    return open({ title, width, body: (b) => { b.append(body) } })
  }

  // ------------------------------------------------------- session editor --
  const TYPES = [
    ['ssh', 'SSH', 'Shell + SFTP over one connection'],
    ['sftp', 'SFTP', 'File browser only'],
    ['telnet', 'Telnet', 'Plain-text terminal'],
    ['rlogin', 'Rlogin', 'Legacy remote login'],
    ['mosh', 'Mosh', 'Roaming SSH (needs brew mosh)'],
    ['serial', 'Serial', 'USB / tty device'],
    ['shell', 'Shell', 'Local macOS shell'],
    ['rdp', 'RDP', 'Opens the macOS RDP client'],
    ['vnc', 'VNC', 'Opens Screen Sharing'],
    ['ftp', 'FTP', 'Opens in Finder (read-only)'],
    ['x11', 'X11', 'XQuartz display'],
    ['browser', 'Browser', 'Opens the default browser']
  ]

  const DEFAULT_PORT = { ssh: 22, sftp: 22, telnet: 23, rlogin: 513, mosh: 22, ftp: 21, rdp: 3389, vnc: 5900, x11: 6000, browser: 443 }

  /**
   * Session create/edit. Resolves to the saved node, or null.
   * `node` may be a partial (e.g. { type: 'ssh' }).
   */
  function sessionEdit (node, parentId) {
    const s = { type: 'ssh', port: 22, ...node }
    return new Promise((resolve) => {
      let api
      const f = {} // field refs
      let activeTab = 'basic'

      const render = (b) => {
        clear(b)
        const strip = el('div', { class: 'tabstrip' })
        for (const [id, label] of [['basic', 'Basic'], ['advanced', 'Advanced'], ['terminal', 'Terminal'], ['bookmark', 'Bookmark']]) {
          strip.append(el('button', {
            class: activeTab === id ? 'active' : '',
            text: label,
            onclick: () => { collect(); activeTab = id; render(b) }
          }))
        }
        b.append(strip)
        if (activeTab === 'basic') b.append(basicPane())
        else if (activeTab === 'advanced') b.append(advancedPane())
        else if (activeTab === 'terminal') b.append(terminalPane())
        else b.append(bookmarkPane())
      }

      const needsHost = () => !['shell', 'serial'].includes(s.type)

      const basicPane = () => {
        const wrap = el('div')
        const typeSel = el('select', {
          onchange: () => {
            s.type = typeSel.value
            if (!node.id || !node.port) s.port = DEFAULT_PORT[s.type] || ''
            collect(true)
            render(api.body)
          }
        }, ...TYPES.map(([v, l]) => el('option', { value: v, selected: s.type === v }, l)))
        f.type = typeSel

        const desc = TYPES.find((t) => t[0] === s.type)?.[2] || ''
        const g = el('div', { class: 'grid2' })
        g.append(el('label', { text: 'Type' }), el('div', { class: 'row' }, typeSel, el('span', { class: 'hint', text: desc })))

        f.name = el('input', { type: 'text', value: s.name || '', placeholder: 'auto from host' })
        g.append(el('label', { text: 'Name' }), f.name)

        if (needsHost()) {
          f.host = el('input', { type: 'text', value: s.host || '', placeholder: 'host or IP', spellcheck: 'false' })
          f.port = el('input', { type: 'number', value: s.port || DEFAULT_PORT[s.type] || '', min: '1', max: '65535', style: 'width:84px' })
          g.append(el('label', { text: 'Host' }), el('div', { class: 'row' }, f.host, el('span', { class: 'hint', text: 'port' }), f.port))
        }

        if (['ssh', 'sftp', 'mosh', 'rlogin', 'rdp', 'vnc', 'ftp'].includes(s.type)) {
          f.username = el('input', { type: 'text', value: s.username || '', placeholder: 'login', spellcheck: 'false' })
          g.append(el('label', { text: 'Username' }), f.username)
        }

        if (s.type === 'ssh' || s.type === 'sftp') {
          f.privateKey = el('input', { type: 'text', value: s.privateKey || '', placeholder: '~/.ssh/id_ed25519 (optional)', spellcheck: 'false' })
          const pick = el('button', {
            class: 'btn sm',
            text: 'Browse…',
            onclick: async () => {
              const p = await window.mx.tools.pickKey()
              if (p) f.privateKey.value = p
            }
          })
          g.append(el('label', { text: 'Private key' }), el('div', { class: 'row' }, f.privateKey, pick))

          f.savedPassword = el('input', { type: 'checkbox', checked: Boolean(s.savedPassword) })
          const setPw = el('button', {
            class: 'btn sm',
            text: 'Set password…',
            onclick: async () => {
              const id = s.id || 'pending'
              const pw = await input({ title: 'Store password', label: 'Password', password: true, hint: 'Saved in the macOS Keychain under service “Gonds”.' })
              if (pw == null) return
              if (!s.id) { s._pendingPassword = pw; f.savedPassword.checked = true; U.toast('Password will be saved with the session.', 'ok'); return }
              try {
                await window.mx.secret.set(id, pw)
                f.savedPassword.checked = true
                U.toast('Password stored in Keychain', 'ok')
              } catch (e) { U.err(e) }
            }
          })
          g.append(el('label', { text: 'Saved password' }), el('div', { class: 'row' }, f.savedPassword, setPw))

          f.useAgent = el('input', { type: 'checkbox', checked: s.useAgent !== false })
          g.append(el('label', { text: 'Use ssh-agent' }), el('div', { class: 'row' }, f.useAgent,
            el('span', { class: 'hint', text: 'uses $SSH_AUTH_SOCK' })))
        }

        if (s.type === 'serial') {
          f.device = el('select', {}, el('option', { value: s.device || '' }, s.device || 'scanning…'))
          window.mx.tools.serialDevices().then((devs) => {
            clear(f.device)
            if (!devs.length) f.device.append(el('option', { value: '' }, 'no serial devices found'))
            for (const d of devs) f.device.append(el('option', { value: d, selected: s.device === d }, d))
          }).catch(() => {})
          f.baud = el('select', {}, ...[300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]
            .map((b) => el('option', { value: b, selected: Number(s.baud || 9600) === b }, String(b))))
          g.append(el('label', { text: 'Device' }), f.device)
          g.append(el('label', { text: 'Baud rate' }), f.baud)
        }

        if (s.type === 'shell') {
          f.command = el('input', { type: 'text', value: s.command || '', placeholder: 'default login shell', spellcheck: 'false' })
          f.cwd = el('input', { type: 'text', value: s.cwd || '', placeholder: '~', spellcheck: 'false' })
          g.append(el('label', { text: 'Command' }), f.command)
          g.append(el('label', { text: 'Start folder' }), f.cwd)
        }

        if (s.type === 'rdp') {
          f.domain = el('input', { type: 'text', value: s.domain || '', placeholder: 'optional Windows domain' })
          f.fullscreen = el('input', { type: 'checkbox', checked: Boolean(s.fullscreen) })
          g.append(el('label', { text: 'Domain' }), f.domain)
          g.append(el('label', { text: 'Full screen' }), f.fullscreen)
        }

        if (s.type === 'browser') {
          f.url = el('input', { type: 'text', value: s.url || '', placeholder: 'https://…' })
          g.append(el('label', { text: 'URL' }), f.url)
        }

        wrap.append(g)

        if (['rdp', 'vnc', 'ftp', 'browser', 'x11'].includes(s.type)) {
          wrap.append(el('div', {
            class: 'hint',
            style: 'margin-top:12px;padding:8px;border-left:2px solid var(--accent);background:var(--bg-3)',
            text: delegationNote(s.type)
          }))
        }
        return wrap
      }

      const advancedPane = () => {
        const g = el('div', { class: 'grid2' })
        if (s.type === 'ssh' || s.type === 'sftp') {
          f.jumpHosts = el('input', { type: 'text', value: (s.jumpHosts || []).join(', '), placeholder: 'user@bastion:22, user@inner', spellcheck: 'false' })
          g.append(el('label', { text: 'Jump hosts' }), f.jumpHosts)
          g.append(el('label', {}), el('div', { class: 'hint', text: 'Comma-separated chain, applied left to right (like ssh -J).' }))

          f.compression = el('input', { type: 'checkbox', checked: Boolean(s.compression) })
          f.keepalive = el('input', { type: 'checkbox', checked: s.keepalive !== false })
          f.agentForward = el('input', { type: 'checkbox', checked: Boolean(s.agentForward) })
          f.x11Forward = el('input', { type: 'checkbox', checked: Boolean(s.x11Forward) })
          g.append(el('label', { text: 'Options' }), el('div', { class: 'checks' },
            el('label', {}, f.compression, 'Compression'),
            el('label', {}, f.keepalive, 'Keepalive'),
            el('label', {}, f.agentForward, 'Forward agent'),
            el('label', {}, f.x11Forward, 'Forward X11')
          ))

          f.connectTimeout = el('input', { type: 'number', value: s.connectTimeout || 20, min: '3', max: '300', style: 'width:76px' })
          g.append(el('label', { text: 'Connect timeout' }), el('div', { class: 'row' }, f.connectTimeout, el('span', { class: 'hint', text: 'seconds' })))

          f.initCommands = el('textarea', { rows: '4', placeholder: 'cd /var/log\ntail -f syslog', spellcheck: 'false' }, s.initCommands || '')
          f.initCommands.style.width = '100%'
          g.append(el('label', { text: 'On connect' }), f.initCommands)

          f.envText = el('textarea', { rows: '3', placeholder: 'LANG=en_US.UTF-8\nTZ=Asia/Jakarta', spellcheck: 'false' },
            Object.entries(s.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'))
          f.envText.style.width = '100%'
          g.append(el('label', { text: 'Environment' }), f.envText)
        } else {
          g.append(el('div', { class: 'wide2 hint', text: 'No advanced options for this session type.' }))
        }
        return g
      }

      const terminalPane = () => {
        const g = el('div', { class: 'grid2' })
        f.scheme = el('select', {}, el('option', { value: '' }, '(use global setting)'))
        window.mx.settings.get().then(({ schemes }) => {
          for (const name of Object.keys(schemes)) {
            f.scheme.append(el('option', { value: name, selected: s.scheme === name }, name))
          }
        }).catch(() => {})
        g.append(el('label', { text: 'Colour scheme' }), f.scheme)

        f.fontSize = el('input', { type: 'number', value: s.fontSize || '', placeholder: 'global', min: '7', max: '36', style: 'width:76px' })
        g.append(el('label', { text: 'Font size' }), f.fontSize)

        f.termType = el('input', { type: 'text', value: s.term || '', placeholder: 'xterm-256color' })
        g.append(el('label', { text: 'TERM' }), f.termType)

        f.openSftp = el('input', { type: 'checkbox', checked: s.openSftp !== false })
        g.append(el('label', { text: 'SFTP panel' }), el('div', { class: 'row' }, f.openSftp, el('span', { class: 'hint', text: 'open on connect (SSH only)' })))
        return g
      }

      const bookmarkPane = () => {
        const g = el('div', { class: 'grid2' })
        f.description = el('textarea', { rows: '3', spellcheck: 'false' }, s.description || '')
        f.description.style.width = '100%'
        g.append(el('label', { text: 'Description' }), f.description)
        f.tags = el('input', { type: 'text', value: (s.tags || []).join(', '), placeholder: 'prod, db' })
        g.append(el('label', { text: 'Tags' }), f.tags)
        if (s.importedFrom) {
          g.append(el('label', { text: 'Imported' }), el('div', { class: 'hint', text: `${s.importedFrom}${s.importedCode ? ` (type #${s.importedCode})` : ''}` }))
        }
        return g
      }

      const collect = (skipRequired) => {
        if (f.type) s.type = f.type.value
        if (f.name) s.name = f.name.value.trim()
        if (f.host) s.host = f.host.value.trim()
        if (f.port) s.port = Number(f.port.value) || DEFAULT_PORT[s.type]
        if (f.username) s.username = f.username.value.trim()
        if (f.privateKey) s.privateKey = f.privateKey.value.trim()
        if (f.savedPassword) s.savedPassword = f.savedPassword.checked
        if (f.useAgent) s.useAgent = f.useAgent.checked
        if (f.device) s.device = f.device.value
        if (f.baud) s.baud = Number(f.baud.value)
        if (f.command) s.command = f.command.value.trim()
        if (f.cwd) s.cwd = f.cwd.value.trim()
        if (f.domain) s.domain = f.domain.value.trim()
        if (f.fullscreen) s.fullscreen = f.fullscreen.checked
        if (f.url) s.url = f.url.value.trim()
        if (f.jumpHosts) s.jumpHosts = f.jumpHosts.value.split(',').map((x) => x.trim()).filter(Boolean)
        if (f.compression) s.compression = f.compression.checked
        if (f.keepalive) s.keepalive = f.keepalive.checked
        if (f.agentForward) s.agentForward = f.agentForward.checked
        if (f.x11Forward) s.x11Forward = f.x11Forward.checked
        if (f.connectTimeout) s.connectTimeout = Number(f.connectTimeout.value) || 20
        if (f.initCommands) s.initCommands = f.initCommands.value
        if (f.envText) {
          const env = {}
          for (const line of f.envText.value.split('\n')) {
            const i = line.indexOf('=')
            if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim()
          }
          s.env = Object.keys(env).length ? env : undefined
        }
        if (f.scheme) s.scheme = f.scheme.value || undefined
        if (f.fontSize) s.fontSize = Number(f.fontSize.value) || undefined
        if (f.termType) s.term = f.termType.value.trim() || undefined
        if (f.openSftp) s.openSftp = f.openSftp.checked
        if (f.description) s.description = f.description.value.trim()
        if (f.tags) s.tags = f.tags.value.split(',').map((x) => x.trim()).filter(Boolean)
        return skipRequired ? null : validate()
      }

      const validate = () => {
        if (!['shell', 'serial'].includes(s.type) && !s.host) return 'Host is required.'
        if (s.type === 'serial' && !s.device) return 'Pick a serial device.'
        if (s.type === 'browser' && !s.url && !s.host) return 'URL is required.'
        return null
      }

      const submit = async () => {
        const problem = collect()
        if (problem) return U.toast(problem, 'warn')
        if (!s.name) s.name = s.host || U.TYPE_LABEL[s.type] || 'session'
        s.type = s.type || 'ssh'
        try {
          const pendingPw = s._pendingPassword
          delete s._pendingPassword
          const saved = await window.mx.sessions.save(s, parentId)
          if (pendingPw) await window.mx.secret.set(saved.id, pendingPw)
          api.close(saved)
        } catch (e) { U.err(e) }
      }

      api = open({
        title: node.id ? `Edit session — ${node.name}` : 'New session',
        icon: 'i-session',
        body: render,
        footer: (ft) => ft.append(
          el('button', { class: 'btn', text: 'Cancel', onclick: () => api.close(null) }),
          el('button', { class: 'btn primary', text: node.id ? 'Save' : 'Create', onclick: submit })
        ),
        enterSubmits: submit,
        onClose: (v) => resolve(v || null)
      })
    })
  }

  function delegationNote (type) {
    return {
      rdp: 'Gonds does not implement RDP. It hands the session to the installed macOS RDP client (Windows App / Microsoft Remote Desktop) via an rdp:// URL.',
      vnc: 'Gonds does not implement RFB. It opens the session in the built-in Screen Sharing client via a vnc:// URL.',
      ftp: 'Finder mounts FTP read-only. For read/write transfers use an SFTP session instead.',
      browser: 'Opens in your default browser — Gonds does not embed a web engine for remote pages.',
      x11: 'X11 display sessions run on XQuartz. For graphical apps over SSH, enable “Forward X11” on an SSH session instead.'
    }[type] || ''
  }

  // ------------------------------------------------------- quick connect ---

  /** `user@host:port` -> an ad-hoc session spec, or null. */
  function parseTarget (raw, type = 'ssh') {
    const text = String(raw || '').trim()
    if (!text) return null
    const m = /^(?:([^@\s]+)@)?([^:\s]+)(?::(\d+))?$/.exec(text)
    if (!m) return null
    return {
      type,
      username: m[1] || undefined,
      host: m[2],
      port: m[3] ? Number(m[3]) : DEFAULT_PORT[type],
      name: text,
      ephemeral: true
    }
  }

  function quickConnect () {
    return new Promise((resolve) => {
      let field, typeSel
      const api = open({
        title: 'Quick connect',
        icon: 'i-server',
        width: 'narrow',
        body: (b) => {
          typeSel = el('select', {}, ...['ssh', 'sftp', 'telnet', 'mosh', 'rdp', 'vnc']
            .map((t) => el('option', { value: t }, U.TYPE_LABEL[t])))
          field = el('input', { type: 'text', placeholder: 'user@host:port', spellcheck: 'false' })
          field.style.width = '100%'
          b.append(el('div', { class: 'grid2' },
            el('label', { text: 'Protocol' }), typeSel,
            el('label', { text: 'Target' }), field
          ))
          b.append(el('div', { class: 'hint', style: 'margin-top:8px', text: 'Not saved to the session tree. Right-click the tab to save it.' }))
          return field
        },
        footer: (ftr) => ftr.append(
          el('button', { class: 'btn', text: 'Cancel', onclick: () => api.close(null) }),
          el('button', { class: 'btn primary', text: 'Connect', onclick: () => api.close(parse()) })
        ),
        enterSubmits: () => api.close(parse()),
        onClose: (v) => resolve(v)
      })

      const parse = () => {
        const spec = parseTarget(field.value, typeSel.value)
        if (!spec && field.value.trim()) U.toast('Expected user@host:port', 'warn')
        return spec
      }
    })
  }

  // ------------------------------------------------------ auth/host-key ----
  function askPassword (p) {
    const target = `${p.username || ''}@${p.host}:${p.port || 22}`
    return input({
      title: 'SSH authentication',
      label: 'Password',
      password: true,
      // The server rejected the last one — say so rather than showing an
      // identical dialog and letting the user wonder what happened.
      hint: p.retry ? `Authentication failed. ${target} — attempt ${p.attempt} of 3.` : target
    })
  }

  function askPassphrase (p) {
    return input({
      title: 'Key passphrase',
      label: 'Passphrase',
      password: true,
      hint: p.keyPath
    })
  }

  function askKeyboardInteractive (p) {
    return new Promise((resolve) => {
      const fields = []
      const api = open({
        title: p.name || 'Keyboard-interactive authentication',
        width: 'narrow',
        dismissable: false,
        body: (b) => {
          if (p.instructions) b.append(el('div', { class: 'hint', style: 'margin-bottom:10px', text: p.instructions }))
          const g = el('div', { class: 'grid2' })
          for (const pr of p.prompts || []) {
            const inp = el('input', { type: pr.echo ? 'text' : 'password' })
            inp.style.width = '100%'
            fields.push(inp)
            g.append(el('label', { text: pr.prompt }), inp)
          }
          b.append(g)
          return fields[0]
        },
        footer: (ftr) => ftr.append(
          el('button', { class: 'btn', text: 'Cancel', onclick: () => api.close(null) }),
          el('button', { class: 'btn primary', text: 'Submit', onclick: () => api.close(fields.map((x) => x.value)) })
        ),
        enterSubmits: () => api.close(fields.map((x) => x.value)),
        onClose: (v) => resolve(v)
      })
    })
  }

  /** Resolves 'accept-always' | 'accept-once' | 'reject'. */
  function askHostKey (p) {
    return new Promise((resolve) => {
      const api = open({
        title: p.changed ? '⚠︎ Host key CHANGED' : 'Unknown host key',
        icon: 'i-key',
        dismissable: false,
        body: (b) => {
          if (p.changed) {
            b.append(el('div', {
              class: 'err',
              style: 'margin-bottom:10px;line-height:1.6',
              text: 'The host key for this server does not match the one stored previously. This can mean the server was rebuilt — or that the connection is being intercepted. Do not continue unless you know why it changed.'
            }))
          }
          const g = el('div', { class: 'grid2' })
          g.append(el('label', { text: 'Server' }), el('code', { text: `${p.host}:${p.port}` }))
          g.append(el('label', { text: 'Fingerprint' }), el('code', { text: p.fingerprint }))
          if (p.previousFingerprint) g.append(el('label', { text: 'Previously' }), el('code', { text: p.previousFingerprint }))
          b.append(g)
          b.append(el('div', { class: 'hint', style: 'margin-top:10px', text: 'Verify this fingerprint out of band — e.g. `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server.' }))
        },
        footer: (ftr) => ftr.append(
          el('button', { class: 'btn danger', text: 'Reject', onclick: () => api.close('reject') }),
          el('button', { class: 'btn', text: 'Accept once', onclick: () => api.close('accept-once') }),
          el('button', { class: `btn ${p.changed ? '' : 'primary'}`, text: 'Accept and remember', onclick: () => api.close('accept-always') })
        ),
        onClose: (v) => resolve(v || 'reject')
      })
    })
  }

  // ---------------------------------------------------- transfer conflict --
  /**
   * A file already exists at the destination.
   * Resolves { action: 'overwrite'|'skip'|'rename'|'cancel', applyToAll }.
   */
  function askOverwrite (info) {
    const fmtBytes = (n) => (n == null ? '—' : U.bytes(n))
    const fmtWhen = (ms) => (ms ? U.date(ms) : '—')
    return new Promise((resolve) => {
      let applyAll
      const answer = (action) => api.close({ action, applyToAll: applyAll.checked })
      const api = open({
        title: 'File already exists',
        icon: 'i-file',
        dismissable: false,
        body: (b) => {
          b.append(el('div', { style: 'margin-bottom:10px;font-size:12.5px' },
            `“${info.name}” already exists at the destination.`))
          const g = el('div', { class: 'grid2' })
          g.append(el('label', { text: 'Destination' }), el('code', { text: info.path }))
          g.append(el('label', { text: 'Existing' }),
            el('span', { text: `${fmtBytes(info.existingSize)} · ${fmtWhen(info.existingMtime)}` }))
          g.append(el('label', { text: info.direction === 'upload' ? 'Uploading' : 'Downloading' }),
            el('span', { text: fmtBytes(info.incomingSize) }))
          b.append(g)
          applyAll = el('input', { type: 'checkbox' })
          b.append(el('label', { style: 'display:flex;gap:6px;align-items:center;margin-top:12px;font-size:11.5px' },
            applyAll, 'Apply to every remaining file in this transfer'))
          return applyAll
        },
        footer: (f) => f.append(
          el('div', { class: 'left' },
            el('button', { class: 'btn danger', text: 'Cancel transfer', onclick: () => answer('cancel') })),
          el('button', { class: 'btn', text: 'Skip', onclick: () => answer('skip') }),
          el('button', { class: 'btn', text: 'Keep both', onclick: () => answer('rename') }),
          el('button', { class: 'btn primary', text: 'Overwrite', onclick: () => answer('overwrite') })
        ),
        // Dismissing without choosing must not destroy data.
        onClose: (v) => resolve(v || { action: 'cancel', applyToAll: false })
      })
    })
  }

  return {
    open, input, confirm, info, sessionEdit, quickConnect,
    askPassword, askPassphrase, askKeyboardInteractive, askHostKey, askOverwrite,
    parseTarget,
    TYPES, DEFAULT_PORT, delegationNote
  }
})()

window.D = D
