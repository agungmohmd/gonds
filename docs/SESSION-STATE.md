# Gonds — build notes

Status as of 2026-11-06. Start at [`../README.md`](../README.md); this file
holds the things that bit during the build and would bite again.

## Verification

| Suite | Command | Result |
|---|---|---|
| Unit | `npm test` | 31 checks pass |
| End-to-end, local fixture | `npm run smoke` | 94 checks pass |
| End-to-end, real server | `npm run smoke:remote` | 14 checks pass |
| End-to-end, packaged `.app` | `GONDS_BIN=dist/mac-arm64/Gonds.app/Contents/MacOS/Gonds npm run smoke` | 94 checks pass |
| Package | `npm run dist` | `dist/Gonds-1.0.0-arm64.dmg`, 97 MB, unsigned |

`npm run smoke` boots a throwaway in-process SSH/SFTP server
(`test/sshfixture.js`), launches the app against an **isolated profile**
(`--user-data-dir` in a temp dir, with the fixture's host key pre-trusted), runs
`test/smoke-scenario.js` inside the real renderer, prints a pass/fail table and
leaves a screenshot. It never touches `~/Library/Application Support/Gonds`.

What `npm run smoke` proves: local pty spawn and byte round-trip; SSH password
auth through the host-key store; SSH shell round-trip; SFTP list, navigate,
read, **write, mkdir, rename, chmod, upload, download, delete**; a **`-L`
forward carrying a real `direct-tcpip` channel**; split-pane creation and
layout geometry; session create/delete in the tree; dialog open/close; netscan
against a live port; Broadcast toggling; the **interactive password prompt**;
every **iconless dialog**; data-table rendering; the **overwrite prompt** with
skip / keep-both / configured-policy; **cancelling a transfer mid-stream**;
accelerator capture and persistence for the **hotkey editor**; and **window
geometry and tab layout restoring** across a launch.

Two of those are corroborated from the server side by the driver, so the
renderer cannot fake them: the fixture records the `direct-tcpip` request, and
the uploaded file is looked for on the fixture's own filesystem.

### `npm run smoke:remote`

Opt-in, needs network. Targets **`test.rebex.net`** by default — a public SSH
and SFTP test server whose credentials Rebex publishes for this purpose. It is
read-only and the run never writes to it. Override with `REMOTE_HOST`,
`REMOTE_PORT`, `REMOTE_USER`, `REMOTE_PASS`. If the host is unreachable the run
skips with exit 0 (set `REMOTE_REQUIRED=1` to make that a failure).

It covers what a local ssh2 fixture structurally cannot:

- the **unknown-host-key dialog** on a first connection — that it appears at
  all, shows server and fingerprint, offers reject / once / remember, and that
  the fingerprint it displays **matches `ssh-keyscan` run independently**
- interop with a **different SSH implementation** (`RebexSSH_8.0.9742`)
- remembering and forgetting a host key
- SFTP listing, navigation and download from a real server, with the
  downloaded byte count checked against the size the server advertised

Still untested anywhere, and still worth a manual pass:

- public-key and `ssh-agent` auth, keyboard-interactive, jump-host chains
- drag-and-drop from Finder, remote in-place editing
- `-R` and `-D` forwards (only `-L` is exercised)
- "apply to all" on the overwrite prompt (the single-file path is covered)
- the native Save-output dialog (only the IPC behind it is asserted)
- restoring a tab that was split in two — restore reopens one terminal per tab
- serial via `screen`, telnet/`nc` fallback, mosh
- the RDP / VNC / FTP / XQuartz hand-offs

## Things that bit

**npm 11 blocks install scripts.** The `electron` postinstall never ran, leaving
a truncated 312 KB `node_modules/electron/dist` that failed with
`Library not loaded: @rpath/Electron Framework.framework`. The zip in
`~/Library/Caches/electron` was complete, so the repair is a manual extract:

```bash
rm -rf node_modules/electron/dist && mkdir -p node_modules/electron/dist
ditto -x -k ~/Library/Caches/electron/*/electron-v33.4.11-darwin-arm64.zip \
  node_modules/electron/dist
printf 'Electron.app/Contents/MacOS/Electron' > node_modules/electron/path.txt
node_modules/.bin/electron --version   # expect v33.4.11
```

`keytar` and `serialport` were dropped from the dependency list for the same
reason — `/usr/bin/security` and `screen` cover both without a native build.
`node-pty` still needs a rebuild; `postinstall` runs
`electron-builder install-app-deps` for that.

**`npm start &` from a tool shell kills the app** when the shell exits. Run the
binary directly or as a tracked background task.

**`.row` collided with the split container's class.** `.split.row` picked up the
generic `.row { align-items: center }` utility, so split cells sized to their
content instead of stretching — terminals rendered as a half-height band floating
in the middle of the pane. Split direction classes are now `sp-row` / `sp-col`.
The smoke scenario asserts `terminal fills its pane vertically` so it cannot
regress silently.

**`el(tag, attrs, …kids)` silently ate a child.** Several call sites passed a
node — or `null` — where the attributes object belongs. A node made
`Object.entries()` return `[]`, so the child vanished: every data table lost its
header row and first column. `null` made it *throw*, which killed every dialog
built without an icon — including the SSH password prompt, so password auth
appeared to fail as "authentication cancelled". `el()` now treats a non-plain
object as the first child, and the smoke run opens every iconless dialog and
asserts table geometry.

**A configured ssh-agent silenced the password prompt.** The old code stuffed
every credential into the connect config up front, and the password branch was
guarded by `else if (!connectCfg.privateKey && !connectCfg.agent)`. With
`useAgent` on and `SSH_AUTH_SOCK` set, `agent` was always truthy, so an account
the agent held no key for failed with ssh2's "All configured authentication
methods failed" and no way to type anything. Authentication now runs through
ssh2's `authHandler`, offering one method at a time like OpenSSH — none,
publickey, agent, password (up to three tries), keyboard-interactive — and
asking for a secret only when the server actually reaches that method. The
fixture advertises `['publickey', 'password']` so the regression is covered.

**ssh2's SFTP constants** are at `require('ssh2').utils.sftp`, not the package
root. Reading `OPEN_MODE` off the root gave `undefined`, the fixture's OPEN
handler threw, and the client reported the misleading `No response from server`.

**`shell.openPath` cannot read inside `app.asar`,** so `docs/` ships as
`extraResources` and `openDoc()` checks `process.resourcesPath` first.

**A hidden Electron window may never paint.** The icon generator parks its
window off-screen at `-3000,-3000` with `show: true` rather than using
`show: false`, and has a 30 s watchdog. A directory passed to Electron also
needs its own `package.json` with a `main` field, or Electron hangs on the
"Unable to find app" screen.

## Restoring state

`ui.windowBounds` / `ui.maximised` are written on move, resize and close
(400 ms debounce) and reapplied at launch — but only if the saved rectangle
still intersects a connected display, so an unplugged monitor cannot strand the
window off-screen.

`ui.openTabs` holds one entry per tab. Restore is **sequential on purpose**: a
parallel reopen of five SSH sessions would stack five password dialogs. Secrets
are stripped before the layout is written (`password`, `passphrase`, and the
live-connection fields); saved passwords stay in the Keychain, found again by
session id. Turn the whole thing off with Settings → Appearance → *Reopen tabs
on launch*.

A tab that was split into two terminals comes back as a single terminal.

## Regenerating the icon

Edit `scripts/icon/icon.html`, then `bash scripts/makeicon.sh`. It renders a
1024 px PNG with Electron and builds `assets/icon.icns` via `sips` + `iconutil`
— no image library involved.

## Deliberate simplifications

Marked in code with `trade-off:` comments. The significant ones:

- RDP / VNC / FTP / browser are delegated to the macOS client, not reimplemented.
- X11 means XQuartz; Gonds does not embed an X server. X11 *forwarding* works.
- Serial is `screen /dev/tty.X <baud>` in a pty.
- Credentials use `/usr/bin/security`, not a native Keychain binding.
- No bundler: UMD `<script>` tags and classic scripts.
- No bundled POSIX toolchain — macOS already is POSIX; the Packages dialog is
  a Homebrew front-end for the few tools it lacks.
- Directory transfers skip symlinks; remote-to-remote copy is unsupported.
- netscan is a TCP connect scan, IPv4, ≤1024 hosts.

## Packaging caveats

The `.dmg` is **ad-hoc signed and un-notarised**. Gatekeeper still blocks it on
another Mac; see the README for the three install routes. Notarisation needs a
paid Apple Developer account, which this project does not have — there is no
free substitute, and a self-signed certificate buys nothing over ad-hoc.

What the ad-hoc signature *does* buy is a stable code identity
(`com.agungmohmd.gonds` rather than the prebuilt stub's generic `Electron`).
macOS keys TCC permissions on that identity, so Local Network access and
friends survive a rebuild. `scripts/afterpack.js` applies it, and steps aside
entirely when `GONDS_SIGN_IDENTITY` is set.

Build config lives in `electron-builder.config.js` rather than `package.json`
so signing and notarisation follow the environment: set `GONDS_SIGN_IDENTITY`
plus `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` and the same
`npm run dist` signs, notarises and staples. Hardened Runtime is only switched
on alongside a real identity — forcing it on an ad-hoc build gains nothing and
can break Electron's JIT.

`NSLocalNetworkUsageDescription` is set via `mac.extendInfo`. Without it the
macOS 15+ local-network prompt appears with no explanation, and until it is
granted every LAN connection fails with `EHOSTUNREACH`.

Only `arm64` is built. Add `"x64"` back to `build.mac.target[0].arch` for an
Intel build; electron-builder will download that runtime on first use.
