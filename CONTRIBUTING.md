# Contributing

This is a side project. I built it because I wanted it, and I'm sharing it in
case someone else does too. There's no roadmap, no release schedule, and no
promise your PR gets merged this month — or at all.

With that out of the way: help is very welcome, and
[`docs/TASKS.md`](docs/TASKS.md) has a pile of real work with file pointers
and a definition of done, so you don't have to guess where anything lives.

## Running it

```bash
git clone https://github.com/agungmohmd/gonds.git
cd gonds
npm install
npm start
```

Node 20+, macOS 11+. That's the whole setup. No bundler, no watch process —
`npm start` runs the files you just edited.

If `npm install` leaves you with an Electron that won't launch, check *Things
that bit* in [`docs/SESSION-STATE.md`](docs/SESSION-STATE.md). npm 11 blocks
install scripts and the fix is three commands.

## Before you push

```bash
npm test       # 31 unit checks, fast, run them constantly
npm run smoke  # 94 end-to-end checks, run before pushing
```

`npm run smoke` spins up a real SSH and SFTP server in-process, launches the
app against a throwaway profile, and drives the actual UI — password prompts,
transfers, tunnels, splits. It uses its own `--user-data-dir`, so it won't
touch your sessions. Failing steps print what they saw.

`npm run smoke:remote` also hits a public SSH test server. Needs network. Skip
it unless you touched the SSH layer.

**New behaviour needs a check.** Not a suite. One assertion that fails if the
thing breaks:

- Pure logic — parsers, paths, formatting → `test/selfcheck.js`
- Anything with UI, a connection, or a file → `test/smoke-scenario.js`

Real bugs have shipped here because the tests politely walked around them. A
test that can't fail is worse than no test; it just makes you feel good.

Building a DMG is `npm run dist`. If that goes sideways, or you want to know
what it actually does, see [`docs/BUILD.md`](docs/BUILD.md).

## Where everything is

```
src/main/      Electron main process
  main.js        window, macOS menu, every IPC handler, prompt round-trips
  ssh.js         ssh2: auth, shells, SFTP, port forwards, jump hosts
  terminals.js   one { write, resize, kill } handle for ptys and SSH channels
  files.js       local fs + SFTP, transfers, conflicts, cancellation
  sessions.js    the session tree, importers, exporters
  settings.js    preferences, colour schemes, macros, hotkeys
  tools.js       netscan, ports, sysinfo, keygen, protocol hand-offs
  keychain.js    /usr/bin/security wrapper
  preload.js     everything the renderer is allowed to touch

src/renderer/  UI. Plain classic scripts, loaded in order by index.html
  util.js        DOM helper, formatting, toasts, context menus
  dialogs.js     modal shell + every dialog
  terminal.js    xterm.js wrapper
  sftp.js        the file panel
  tabs.js        tabs, splits, home page
  sidebar.js     session tree and the side panes
  toolsui.js     settings and the tool windows
  app.js         wiring: menu actions, state, startup
```

## House style

**No bundler, no framework, no build step.** The renderer is classic scripts
sharing globals (`U`, `D`, `Tabs`, `MX`). On purpose — the whole thing stays
debuggable with nothing but DevTools. Want to add a build pipeline? Open an
issue first and be ready to argue for it.

**No new dependencies for things a few lines can do.** Seven runtime packages
and I'd like to keep it that way. Credentials go through `/usr/bin/security`
instead of a native Keychain module; serial goes through `screen` instead of a
native serial binding. Both so there's nothing to recompile every time
Electron moves.

**Icons are inline SVG** in the sprite at the top of `index.html`, hand-drawn
for this project. Add yours there in the same 16×16 line style. No icon fonts,
no icon sets.

**Comments say why, not what.** If a line looks weird, write down what breaks
without it. Deliberate shortcuts are tagged `trade-off:` with the ceiling and
the way out.

**Secrets never hit disk.** Keychain only. The saved tab layout strips them and
a test enforces it. If you add a code path that handles a credential, make sure
it can't get serialised.

## Stuff I'll say no to

**Code or assets lifted from another app.** Don't copy code, icons, fonts,
themes or data tables out of someone else's product — including by pulling
them out of a shipped binary. Reimplementing a feature you've seen elsewhere is
completely fine. Copying how they wrote it is not, and it'd put the whole
project at risk.

**Reimplementing protocols macOS already handles.** RDP, VNC and X11 get handed
to the system client on purpose. Reasons are in the README.

**Giant refactors that appear out of nowhere.** Not because they're unwelcome,
but because I'm not going to pretend I reviewed 2,000 lines properly. Open an
issue, we'll figure out the shape, then write it.

## Found a security bug?

Not here, and not in a public issue — see [SECURITY.md](SECURITY.md).

## Found a normal bug?

Tell me your macOS version, whether you built it or installed the DMG, and what
the app said. `⌥⌘I` opens DevTools and the console usually names the file and
line. For connection problems the exact wording matters: `EHOSTUNREACH`,
`All configured authentication methods failed` and `authentication cancelled`
mean three completely different things.

No template, no form. Just tell me what happened.

## Licence

Contributions land under the [MIT licence](LICENSE). The name and the app icon
are excluded — see the note at the bottom of that file.
