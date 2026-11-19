'use strict'
/* global window, document */

const U = (() => {
  // --- DOM -----------------------------------------------------------------
  function el (tag, attrs, ...kids) {
    const n = document.createElement(tag)
    // el(tag, child, …) is legal: anything that is not a plain attributes
    // object counts as the first child. Guarding here rather than at each call
    // site means a forgotten `{}` can neither throw on null nor silently
    // swallow a node.
    if (attrs != null && (attrs instanceof Node || Array.isArray(attrs) || typeof attrs !== 'object')) {
      kids.unshift(attrs)
      attrs = null
    }
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue
      if (k === 'class') n.className = v
      else if (k === 'text') n.textContent = v
      else if (k === 'html') n.innerHTML = v
      else if (k === 'dataset') Object.assign(n.dataset, v)
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v)
      else if (v === true) n.setAttribute(k, '')
      else n.setAttribute(k, v)
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue
      n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)))
    }
    return n
  }

  /** <svg><use href="#id"></svg> — the sprite in index.html. */
  function icon (id, cls) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    if (cls) svg.setAttribute('class', cls)
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
    use.setAttribute('href', `#${id}`)
    svg.append(use)
    return svg
  }

  const $ = (sel, root = document) => root.querySelector(sel)
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

  function clear (node) { while (node.firstChild) node.removeChild(node.firstChild) }

  // --- encoding ------------------------------------------------------------
  const enc = new TextEncoder()
  const dec = new TextDecoder('utf-8', { fatal: false })

  function strToB64 (s) {
    const bytes = enc.encode(s)
    let out = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    }
    return btoa(out)
  }

  function b64ToBytes (b64) {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes
  }

  // --- formatting ----------------------------------------------------------
  function bytes (n) {
    if (n === null || n === undefined) return ''
    const u = ['B', 'K', 'M', 'G', 'T']
    let i = 0
    let v = Number(n)
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
    return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)}${u[i]}`
  }

  function date (ms) {
    if (!ms) return ''
    const d = new Date(ms)
    const now = new Date()
    const sameYear = d.getFullYear() === now.getFullYear()
    const p = (x) => String(x).padStart(2, '0')
    return sameYear
      ? `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
      : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  function duration (s) {
    const d = Math.floor(s / 86400)
    const h = Math.floor((s % 86400) / 3600)
    const m = Math.floor((s % 3600) / 60)
    return [d && `${d}d`, (d || h) && `${h}h`, `${m}m`].filter(Boolean).join(' ')
  }

  function modeOctal (mode) { return (mode & 0o7777).toString(8).padStart(4, '0') }

  function escapeHtml (s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  }

  // --- toasts --------------------------------------------------------------
  function toast (message, level = 'info', ms = 4200) {
    const host = $('#toasts')
    const node = el('div', { class: `toast ${level}`, text: String(message) })
    host.append(node)
    const kill = () => node.remove()
    node.addEventListener('click', kill)
    if (ms) setTimeout(kill, ms)
    return node
  }

  const err = (e) => toast(e && e.message ? e.message : String(e), 'err', 7000)

  // --- context menu --------------------------------------------------------
  let openMenu = null

  function closeMenu () {
    if (openMenu) { openMenu.remove(); openMenu = null }
  }

  /**
   * items: [{ label, icon?, kbd?, disabled?, danger?, onClick }] | 'sep'
   */
  function menu (x, y, items) {
    closeMenu()
    const m = el('div', { class: 'ctxmenu' })
    for (const it of items) {
      if (it === 'sep' || it === '-') { m.append(el('div', { class: 'sep' })); continue }
      if (!it) continue
      const b = el('button', {
        disabled: it.disabled || false,
        onclick: (e) => {
          e.stopPropagation()
          if (it.disabled) return
          closeMenu()
          it.onClick?.()
        }
      })
      if (it.icon) b.append(icon(it.icon))
      b.append(el('span', { text: it.label }))
      if (it.kbd) b.append(el('span', { class: 'kbd', text: it.kbd }))
      if (it.danger) b.style.color = 'var(--red)'
      m.append(b)
    }
    document.body.append(m)
    const r = m.getBoundingClientRect()
    m.style.left = `${Math.min(x, innerWidth - r.width - 6)}px`
    m.style.top = `${Math.min(y, innerHeight - r.height - 6)}px`
    openMenu = m
    return m
  }

  document.addEventListener('mousedown', (e) => {
    if (openMenu && !openMenu.contains(e.target)) closeMenu()
  }, true)
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu() })

  // --- misc ----------------------------------------------------------------
  function debounce (fn, ms = 120) {
    let t = null
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) }
  }

  /** Drag a vertical/horizontal splitter. onMove(deltaPx) */
  function drag (handle, onMove, axis = 'x') {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const start = axis === 'x' ? e.clientX : e.clientY
      const move = (ev) => onMove((axis === 'x' ? ev.clientX : ev.clientY) - start, ev)
      const up = () => {
        document.removeEventListener('mousemove', move)
        document.removeEventListener('mouseup', up)
        document.body.style.cursor = ''
      }
      document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
      document.addEventListener('mousemove', move)
      document.addEventListener('mouseup', up)
    })
  }

  function typeIcon (type) {
    return {
      folder: 'i-folder', ssh: 'i-ssh', sftp: 'i-sftp', telnet: 'i-telnet',
      rlogin: 'i-telnet', mosh: 'i-mosh', serial: 'i-serial', shell: 'i-shell',
      ftp: 'i-sftp', rdp: 'i-rdp', vnc: 'i-vnc', x11: 'i-x11', browser: 'i-browser'
    }[type] || 'i-ssh'
  }

  const TYPE_LABEL = {
    ssh: 'SSH', sftp: 'SFTP', telnet: 'Telnet', rlogin: 'Rlogin', mosh: 'Mosh',
    serial: 'Serial', shell: 'Shell', ftp: 'FTP', rdp: 'RDP', vnc: 'VNC',
    x11: 'X11', browser: 'Browser', folder: 'Folder'
  }

  return {
    el, icon, $, $$, clear, strToB64, b64ToBytes, bytes, date, duration,
    modeOctal, escapeHtml, toast, err, menu, closeMenu, debounce, drag,
    typeIcon, TYPE_LABEL, dec
  }
})()

window.U = U
