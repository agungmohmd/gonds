'use strict'
// Preferences, colour schemes, macros and hotkeys — one JSON file, atomic writes.
const fs = require('node:fs')
const path = require('node:path')

// Palette keys use PuTTY's names, so schemes can be pasted in from the large
// pool of PuTTY/xterm themes that already exist.
const SCHEMES = {
  Console: {
    ForegroundColour: '#bbbbbb', BackgroundColour: '#000000', CursorColour: '#bbbbbb',
    Black: '#0c0c0c', Red: '#c50f1f', Green: '#13a10e', Yellow: '#c19c00',
    Blue: '#0037da', Magenta: '#881798', Cyan: '#3a96dd', White: '#cccccc',
    BoldBlack: '#767676', BoldRed: '#e74856', BoldGreen: '#16c60c', BoldYellow: '#f9f1a5',
    BoldBlue: '#3b78ff', BoldMagenta: '#b4009e', BoldCyan: '#61d6d6', BoldWhite: '#f2f2f2'
  },
  'Gonds Dark': {
    ForegroundColour: '#d4d4d4', BackgroundColour: '#1b1b1b', CursorColour: '#ffcc00',
    Black: '#2e3436', Red: '#cc0000', Green: '#4e9a06', Yellow: '#c4a000',
    Blue: '#3465a4', Magenta: '#75507b', Cyan: '#06989a', White: '#d3d7cf',
    BoldBlack: '#555753', BoldRed: '#ef2929', BoldGreen: '#8ae234', BoldYellow: '#fce94f',
    BoldBlue: '#729fcf', BoldMagenta: '#ad7fa8', BoldCyan: '#34e2e2', BoldWhite: '#eeeeec'
  },
  Solarized: {
    ForegroundColour: '#839496', BackgroundColour: '#002b36', CursorColour: '#93a1a1',
    Black: '#073642', Red: '#dc322f', Green: '#859900', Yellow: '#b58900',
    Blue: '#268bd2', Magenta: '#d33682', Cyan: '#2aa198', White: '#eee8d5',
    BoldBlack: '#002b36', BoldRed: '#cb4b16', BoldGreen: '#586e75', BoldYellow: '#657b83',
    BoldBlue: '#839496', BoldMagenta: '#6c71c4', BoldCyan: '#93a1a1', BoldWhite: '#fdf6e3'
  },
  'Solarized Light': {
    ForegroundColour: '#657b83', BackgroundColour: '#fdf6e3', CursorColour: '#586e75',
    Black: '#073642', Red: '#dc322f', Green: '#859900', Yellow: '#b58900',
    Blue: '#268bd2', Magenta: '#d33682', Cyan: '#2aa198', White: '#eee8d5',
    BoldBlack: '#002b36', BoldRed: '#cb4b16', BoldGreen: '#586e75', BoldYellow: '#657b83',
    BoldBlue: '#839496', BoldMagenta: '#6c71c4', BoldCyan: '#93a1a1', BoldWhite: '#fdf6e3'
  },
  Dracula: {
    ForegroundColour: '#f8f8f2', BackgroundColour: '#282a36', CursorColour: '#f8f8f2',
    Black: '#21222c', Red: '#ff5555', Green: '#50fa7b', Yellow: '#f1fa8c',
    Blue: '#bd93f9', Magenta: '#ff79c6', Cyan: '#8be9fd', White: '#f8f8f2',
    BoldBlack: '#6272a4', BoldRed: '#ff6e6e', BoldGreen: '#69ff94', BoldYellow: '#ffffa5',
    BoldBlue: '#d6acff', BoldMagenta: '#ff92df', BoldCyan: '#a4ffff', BoldWhite: '#ffffff'
  },
  'Gruvbox Dark': {
    ForegroundColour: '#ebdbb2', BackgroundColour: '#282828', CursorColour: '#ebdbb2',
    Black: '#282828', Red: '#cc241d', Green: '#98971a', Yellow: '#d79921',
    Blue: '#458588', Magenta: '#b16286', Cyan: '#689d6a', White: '#a89984',
    BoldBlack: '#928374', BoldRed: '#fb4934', BoldGreen: '#b8bb26', BoldYellow: '#fabd2f',
    BoldBlue: '#83a598', BoldMagenta: '#d3869b', BoldCyan: '#8ec07c', BoldWhite: '#ebdbb2'
  },
  'One Dark': {
    ForegroundColour: '#abb2bf', BackgroundColour: '#282c34', CursorColour: '#528bff',
    Black: '#3f4451', Red: '#e05561', Green: '#8cc265', Yellow: '#d18f52',
    Blue: '#4aa5f0', Magenta: '#c162de', Cyan: '#42b3c2', White: '#e6e6e6',
    BoldBlack: '#4f5666', BoldRed: '#ff616e', BoldGreen: '#a5e075', BoldYellow: '#f0a45d',
    BoldBlue: '#4dc4ff', BoldMagenta: '#de73ff', BoldCyan: '#4cd1e0', BoldWhite: '#ffffff'
  },
  Nord: {
    ForegroundColour: '#d8dee9', BackgroundColour: '#2e3440', CursorColour: '#d8dee9',
    Black: '#3b4252', Red: '#bf616a', Green: '#a3be8c', Yellow: '#ebcb8b',
    Blue: '#81a1c1', Magenta: '#b48ead', Cyan: '#88c0d0', White: '#e5e9f0',
    BoldBlack: '#4c566a', BoldRed: '#bf616a', BoldGreen: '#a3be8c', BoldYellow: '#ebcb8b',
    BoldBlue: '#81a1c1', BoldMagenta: '#b48ead', BoldCyan: '#8fbcbb', BoldWhite: '#eceff4'
  },
  'Light (Classic)': {
    ForegroundColour: '#1f1f1f', BackgroundColour: '#ffffff', CursorColour: '#1f1f1f',
    Black: '#000000', Red: '#c01c28', Green: '#26a269', Yellow: '#a2734c',
    Blue: '#12488b', Magenta: '#a347ba', Cyan: '#2aa1b3', White: '#d0cfcc',
    BoldBlack: '#5e5c64', BoldRed: '#f66151', BoldGreen: '#33d17a', BoldYellow: '#e9ad0c',
    BoldBlue: '#2a7bde', BoldMagenta: '#c061cb', BoldCyan: '#33c7de', BoldWhite: '#ffffff'
  }
}

// One editable map, consumed by the macOS menu bar. An empty string unbinds
// an action; a missing key falls back to the default below.
const DEFAULT_HOTKEYS = {
  'new-session': 'Cmd+Shift+N',
  'quick-connect': 'Cmd+K',
  'new-shell': 'Cmd+T',
  'duplicate-tab': 'Cmd+Shift+T',
  'close-tab': 'Cmd+W',
  'next-tab': 'Ctrl+Tab',
  'prev-tab': 'Ctrl+Shift+Tab',
  'split-right': 'Cmd+D',
  'split-down': 'Cmd+Shift+D',
  'toggle-sftp': 'Cmd+B',
  'toggle-sidebar': 'Cmd+Alt+B',
  'find-in-terminal': 'Cmd+F',
  'broadcast': 'Cmd+Shift+M',
  'clear-terminal': 'Cmd+L',
  'zoom-in': 'Cmd+Plus',
  'zoom-out': 'Cmd+-',
  'zoom-reset': 'Cmd+0',
  paste: 'Cmd+V',
  copy: 'Cmd+C',
  'select-all': 'Cmd+A',
  settings: 'Cmd+,'
}

// Shown in the editor so each row explains itself.
const HOTKEY_LABELS = {
  'new-session': 'New session…',
  'quick-connect': 'Quick connect…',
  'new-shell': 'New local shell',
  'duplicate-tab': 'Duplicate tab',
  'close-tab': 'Close tab',
  'next-tab': 'Next tab',
  'prev-tab': 'Previous tab',
  'split-right': 'Split right',
  'split-down': 'Split down',
  'toggle-sftp': 'Toggle SFTP panel',
  'toggle-sidebar': 'Toggle sidebar',
  'find-in-terminal': 'Find in terminal…',
  broadcast: 'Broadcast',
  'clear-terminal': 'Clear terminal',
  'zoom-in': 'Zoom in',
  'zoom-out': 'Zoom out',
  'zoom-reset': 'Actual size',
  paste: 'Paste',
  copy: 'Copy',
  'select-all': 'Select all',
  settings: 'Settings…'
}

function defaults () {
  return {
    version: 1,
    terminal: {
      fontFamily: 'Menlo, "SF Mono", Monaco, monospace',
      fontSize: 13,
      lineHeight: 1.15,
      letterSpacing: 0,
      cursorStyle: 'block',
      cursorBlink: true,
      scrollback: 10000,
      scheme: 'Gonds Dark',
      copyOnSelect: true,
      rightClick: 'paste',
      pasteConfirmNewlines: true,
      wordSeparators: ' ()[]{}\'",;:|`'
    },
    ui: {
      theme: 'dark',
      sidebarWidth: 240,
      sidebarVisible: true,
      sftpPanelWidth: 300,
      sftpAutoOpen: true,
      confirmCloseTab: true,
      showStatusBar: true,
      restoreTabs: true,
      windowBounds: null,
      maximised: false,
      openTabs: []
    },
    ssh: {
      keepalive: true,
      keepaliveInterval: 30,
      compression: false,
      useAgent: true,
      agentForward: false,
      x11Forward: false,
      connectTimeout: 20,
      defaultUser: process.env.USER || ''
    },
    transfers: { followTerminalCwd: true, overwritePolicy: 'ask' },
    hotkeys: { ...DEFAULT_HOTKEYS },
    macros: [],
    schemes: {}
  }
}

let file = null
let state = null

function init (userDataDir) {
  file = path.join(userDataDir, 'settings.json')
  try {
    state = deepMerge(defaults(), JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    state = defaults()
    persist()
  }
  return state
}

function deepMerge (base, patch) {
  if (patch === null || patch === undefined) return base
  if (Array.isArray(patch) || typeof patch !== 'object') return patch
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object')
      ? deepMerge(base[k], v)
      : v
  }
  return out
}

function persist () {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, file)
}

function get () { return state }

function patch (p) {
  state = deepMerge(state, p)
  persist()
  return state
}

function reset () {
  state = defaults()
  persist()
  return state
}

/** All schemes: built-ins plus user-defined (user wins on name collision). */
function schemes () {
  return { ...SCHEMES, ...(state?.schemes || {}) }
}

/** Translate a scheme to an xterm.js ITheme. */
function toXtermTheme (name) {
  const s = schemes()[name] || SCHEMES['Gonds Dark']
  return {
    foreground: s.ForegroundColour,
    background: s.BackgroundColour,
    cursor: s.CursorColour,
    cursorAccent: s.BackgroundColour,
    selectionBackground: '#4f6d9a80',
    black: s.Black, red: s.Red, green: s.Green, yellow: s.Yellow,
    blue: s.Blue, magenta: s.Magenta, cyan: s.Cyan, white: s.White,
    brightBlack: s.BoldBlack, brightRed: s.BoldRed, brightGreen: s.BoldGreen,
    brightYellow: s.BoldYellow, brightBlue: s.BoldBlue, brightMagenta: s.BoldMagenta,
    brightCyan: s.BoldCyan, brightWhite: s.BoldWhite
  }
}

// -------------------------------------------------------------- macros ----

function saveMacro (macro) {
  state.macros = state.macros || []
  const id = macro.id || `m-${Date.now().toString(36)}`
  const idx = state.macros.findIndex((m) => m.id === id)
  const rec = { ...macro, id }
  if (idx >= 0) state.macros[idx] = rec
  else state.macros.push(rec)
  persist()
  return rec
}

function deleteMacro (id) {
  const before = (state.macros || []).length
  state.macros = (state.macros || []).filter((m) => m.id !== id)
  persist()
  return state.macros.length !== before
}

module.exports = {
  init, get, patch, reset, persist, schemes, toXtermTheme,
  saveMacro, deleteMacro, SCHEMES, DEFAULT_HOTKEYS, HOTKEY_LABELS, defaults, deepMerge
}
