# Where to start

Real gaps in Gonds, each one scoped small enough to finish in a sitting or two.
Every entry names the files it touches and what "done" looks like, so you can
start without reading the whole codebase.

Shout in an issue before you start so two people don't write the same patch.
Nothing's reserved — if something's been quiet for a week, just take it.

Fair warning: I merge things when I have time, which is irregularly. Pick
something because you want it to exist, not because you're waiting on me.

Difficulty is about *how much of the app you need to understand*, not how much
code you write.

---

## Good first issues

### 1 · Sort the SFTP list by column
`src/renderer/js/sftp.js`

The file list is always ordered directories-first-then-name. There is no header
row at all, so there is nothing to click.

**Done when** the panel has a header row (Name / Size / Modified), clicking a
heading sorts by it, clicking again reverses, and the arrow shows which is
active. Directories should stay grouped first regardless.

### 2 · Filter box in the SFTP panel
`src/renderer/js/sftp.js`

Listing a directory with 400 files means scrolling. The session tree already
has a filter box (`#session-filter` in `sidebar.js`) — copy the shape of it.

**Done when** typing narrows the visible rows, Esc clears it, and the footer
count reflects what is shown.

### 3 · Keyboard navigation in the session tree
`src/renderer/js/sidebar.js`

The tree is `tabindex="0"` but has no key handling. Mouse only.

**Done when** ↑/↓ move the selection, → and ← expand and collapse folders, ⏎
opens the selected session, and the selected row scrolls into view.

### 4 · Remember each session's last SFTP directory
`src/renderer/js/sftp.js`, `src/main/sessions.js`

Reconnecting always lands in the remote home directory, even if you spend every
session in `/var/log`.

**Done when** the panel reopens where you left it, stored on the session node,
with a sane fallback when the path is gone.

### 5 · Transfer speed and ETA
`src/main/files.js`, `src/renderer/js/sftp.js`

Transfer rows show a progress bar and nothing else. `files.js` already emits
`bytes` and `total` per update — the rate just needs deriving from the gaps
between them.

**Done when** each running row reads something like `4.2 MB/s · 12s left`, and
a stalled transfer does not display a nonsense estimate.

### 6 · Warn before quitting mid-transfer
`src/main/main.js` (`before-quit`), `src/main/files.js`

⌘Q during a 2 GB upload kills it silently.

**Done when** quitting with transfers in flight asks first, and cancelling the
dialog leaves them running. `files.listTransfers()` already reports state.

### 7 · Light theme pass
`src/renderer/css/app.css`

There is exactly one `:root[data-theme="light"]` block, setting variables.
Everything was designed and checked in dark; several components almost
certainly read badly in light.

**Done when** you have walked every dialog and panel in light mode and fixed
the contrast problems. Screenshots in the PR, please.

---

## Medium

### 8 · Session logging to file
`src/main/terminals.js`, `src/main/settings.js`, `src/renderer/js/dialogs.js`

Not implemented at all. Ops work wants a transcript.

**Done when** a session can be configured to append its output to a file, the
path supports a timestamp placeholder, and logging survives a reconnect.
Decide and document whether escape sequences are stripped.

### 9 · Custom colour scheme editor
`src/renderer/js/toolsui.js` (`appearancePane`), `src/main/settings.js`

`settings.schemes` already merges user-defined schemes over the built-ins, and
`schemes()` returns the union — but nothing ever writes to it. The plumbing is
there; the UI is missing.

**Done when** you can duplicate a built-in scheme, edit all 18 colours, name
it, and pick it anywhere a scheme is chosen. Deleting a user scheme falls back
cleanly.

### 10 · Drag from the remote panel into Finder
`src/main/main.js`, `src/main/preload.js`, `src/renderer/js/sftp.js`

Finder → Gonds works. The reverse does not: macOS needs a real local file
before a drag can start, so the file has to be downloaded to a temp directory
first and handed to `webContents.startDrag`.

Note the method already called `startDrag` in `sftp.js` is our internal
HTML5 handler — different thing, pick another name.

**Done when** dragging one or more remote files to Finder copies them, with
some progress indication while the temp copy is made.

### 11 · Restore a split tab as a split
`src/renderer/js/tabs.js` (`serialise`, `restore`)

`serialise()` records one spec per tab, so a tab you split in two comes back as
one terminal.

**Done when** the saved layout captures the split tree and its gutter positions
and `restore()` rebuilds it. Keep secrets out of the saved layout — there is a
test asserting that.

### 12 · Remote-to-remote copy
`src/main/files.js`, `src/renderer/js/sftp.js:350`

Dragging between two remote panels is refused outright today.

**Done when** files stream from one SSH connection to the other without
landing on disk, honouring the existing cancel and overwrite machinery.

### 13 · Macro recording
`src/renderer/js/terminal.js`, `src/renderer/js/toolsui.js` (`macroEdit`)

Macros are authored by hand. Recording is not implemented.

**Done when** you can arm recording, type in a terminal, stop, and get an
editable macro. Think about what to do with passwords typed during a recording
— and write down what you decided.

---

## Larger

### 14 · Detach a tab into its own window
`src/renderer/js/tabs.js`, `src/main/main.js`

Needs a second `BrowserWindow` and a way to move a live terminal between
windows without dropping the connection. Architectural — discuss in an issue
before writing code.

### 15 · Auto-update
`electron-builder.config.js`, new main-process module

Worth little until releases are signed and notarised, since an unsigned update
hits the same Gatekeeper wall as a fresh install. Read `docs/SESSION-STATE.md`
→ *Packaging caveats* first.

### 16 · Intel / universal build
`electron-builder.config.js`

Currently `arch: ['arm64']`. Adding `'x64'` is one line; the work is verifying
the native modules (`node-pty`) actually rebuild and run.

---

## Tests — the easiest useful PR

Each of these is a gap in `test/smoke-scenario.js` or `test/sshfixture.js`, and
needs no app changes. Read `docs/SESSION-STATE.md` for what is already covered.

### 17 · Cover `-R` and `-D` port forwards
Only `-L` is exercised. The fixture handles `direct-tcpip`; remote forwards
need `forwardIn` support adding to `test/sshfixture.js`.

### 18 · Cover "apply to all" on the overwrite prompt
Implemented (`batch.overwriteAll` in `src/main/files.js`) but only the
single-file path is tested. Needs a multi-file clash.

### 19 · Cover telnet, mosh and serial
Three session types that have never been run by anything but a human. Serial
needs a virtual tty; telnet can point at a local listener.

---

## Proposed — discuss before building

### 20 · Optional AI assistant (BYOK)
**Status: a proposal, not a decision. Open an issue and argue with it first.**

The idea: let people point Gonds at any OpenAI-compatible endpoint — OpenAI,
OpenRouter, Azure, or a local Ollama / llama.cpp server — and get help with
what is on screen. Explain this error. What flag does this need. Why is this
unit failing.

Bring your own key. Off by default. Pausable without deleting the key.

This is the kind of feature that is easy to build and easy to get badly wrong,
because it sits inside an app that is logged into production servers. The
constraints below are the feature; the HTTP call is the trivial part.

**Never execute anything.** A suggestion goes into the input line for the
human to read and press return. It does not run, and there is no "auto-apply"
setting to add later. Terminal output is untrusted input — a server can print
text that reads as an instruction to a model, so any path from model output to
a live shell is a remote code execution bug with extra steps. This one is not
negotiable.

**Nothing leaves the machine without the user asking.** Terminal scrollback
contains passwords, tokens, private keys and customer data. So:

- No background or automatic requests. Ever.
- The user selects what to send, and sees exactly what will be sent before it
  goes — a literal preview of the payload, not a description of it.
- Redact obvious secrets in that preview (key blocks, `Authorization:` headers,
  anything matching the password prompt we just drew) and let the user edit it.
- A visible, persistent indicator whenever the assistant is enabled. Someone
  demoing Gonds on a customer's machine must be able to tell at a glance.

**The key goes in the Keychain**, via `src/main/keychain.js`, like every other
credential. Not `settings.json`. The saved tab layout and settings must stay
free of it — there is already a test asserting no secrets are serialised.

**The request happens in the main process.** The renderer runs under a CSP with
`connect-src 'none'` (see `src/renderer/index.html`) and that stays as it is.
Add an IPC handler in `src/main/`, expose it through `preload.js`, and keep the
renderer unable to reach the network on its own.

**Local models are a first-class target, not an afterthought.** Pointing at
`http://localhost:11434/v1` means nothing leaves the machine, which for this
audience may be the only acceptable configuration. Do not assume a cloud
endpoint anywhere in the design.

**Watch the interaction with Broadcast.** A suggested command with broadcast
armed would land in every open terminal at once. Decide what happens there and
write it down.

Suggested shape for a first PR: settings pane (endpoint, key, model, enable
and pause), the main-process client, and one entry point — select text in a
terminal, right-click, "Explain this". Nothing else. Get the consent and
redaction flow reviewed before building anything on top of it.
