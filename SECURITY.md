# Security

Gonds holds SSH credentials and opens shells on machines you probably care
about. So here's the honest version of what it does and doesn't do.

## Found something?

**Don't put it in a public issue if it's actually exploitable.** Use the
Security tab → *Report a vulnerability*. That stays between us.

> Note to self: turn that on in Settings → Advanced Security.

Tell me the version, your macOS version, and the shortest way to see the thing
happen. A failing test in `test/selfcheck.js` or `test/smoke-scenario.js` is
the best possible report, because then I don't have to think.

**No promises.** This is a side project. I'll read it. I'll probably say
thanks. Whether it gets fixed depends on how bad it is and whether I have a
free evening. If I go quiet, I'm not ignoring you, I'm just busy — poke me
again.

Supported versions: the latest one. There is no other one.

## What it actually does right

**Your passwords aren't in my files.** They go in the macOS Keychain under
service `Gonds`, via `/usr/bin/security`. Your login password is the master
password. The saved tab layout strips secrets before writing, and there's a
test that fails if that ever stops being true.

**Host keys get checked properly.** Gonds keeps its own store. Unknown key →
dialog with the SHA-256 fingerprint. *Changed* key → louder dialog. You can't
click past either by accident. The smoke suite compares the fingerprint Gonds
shows against `ssh-keygen` run separately, because otherwise I'd just be
trusting my own code.

**It doesn't talk to anything you didn't ask it to.** No telemetry, no update
check, no analytics, no ads, no dependency that sneaks any of that in. Sitting
idle it holds zero network sockets. Don't believe me — there's a command below.

**The UI can't reach the network even if it wanted to.** CSP is
`default-src 'none'; connect-src 'none'`, context isolation on, node
integration off. Everything goes through an explicit IPC surface in
`src/main/preload.js`.

**No shell string building.** `execFile` with argument arrays, never a shell,
with a hostname pattern guard on anything heading for a command line.

## What it doesn't do

**Your config sits on disk in plain JSON.** `sessions.json`, `settings.json`,
`known_hosts.json` in `~/Library/Application Support/Gonds/`. No passwords in
there, but hostnames, usernames and ports are — enough to draw a map of your
infrastructure. Turn on FileVault. Gonds isn't going to encrypt it for you.

**Anything already running as you.** Malware on your Mac can read the config
and ask the Keychain for secrets exactly the way Gonds does. Nothing I can do
about that from inside the app.

**A nasty server.** It can't run code in Gonds, but it decides what your
terminal prints and what filenames the SFTP panel shows. Terminal emulators
have a rich history of escape-sequence bugs. xterm.js is the wall; if the wall
has a hole, so do I.

**npm.** Seven runtime dependencies and `npm audit` is clean, but a
compromised upstream package still lands on your machine. Chromium fixes only
reach you when I bump Electron and cut a release, which happens when it
happens.

**Apple never looked at it.** Releases are ad-hoc signed and not notarised,
because notarisation costs $99/year and this is a hobby. "No spyware" means
*I* didn't put any in. It is not Apple's opinion.

**Nobody audited this.** I wrote the code and I also wrote the tests, which is
exactly as reassuring as it sounds.

## Trade-offs I made on purpose

**`sandbox: false`** on the renderer, because the preload needs Electron
modules and a sandboxed renderer can't load them. Context isolation and the CSP
are still on, so no direct Node or network access — but it's weaker than a real
sandbox, and I know it.

**Ad-hoc signing.** Doesn't get you past Gatekeeper. It's there so macOS gives
the app a stable identity and stops forgetting its privacy permissions every
rebuild. Check what you downloaded with
`codesign -dv /Applications/Gonds.app` — identifier should be
`com.agungmohmd.gonds`.

## Go check for yourself

Seriously, don't trust the section above. Takes a minute:

```bash
# any outbound HTTP in my code? should be nothing
grep -rn "fetch(\|XMLHttpRequest\|new WebSocket\|require('node:https\?')" src/

# the renderer's content security policy
grep -n "connect-src" src/renderer/index.html

# launch Gonds, leave it alone, then:
lsof -nP -a -p "$(pgrep -f 'Gonds.app/Contents/(MacOS|Frameworks)' | paste -sd, -)" -i
# nothing should come back until you open a session yourself

# what it's actually built on
npm ls --omit=dev --depth=0
npm audit --omit=dev

# nothing secret on disk
grep -riE '"password"|"passphrase"|PRIVATE KEY' ~/Library/Application\ Support/Gonds/
```

Or skip all that and build it yourself: `npm install && npm run dist`. Then the
only code you're trusting is the code you just read.
