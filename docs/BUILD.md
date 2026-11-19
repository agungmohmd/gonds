# Building the DMG

```bash
npm install
npm run dist
```

Out comes `dist/Gonds-<version>-arm64.dmg`, around 100 MB. That's it.

Takes a couple of minutes the first time because electron-builder downloads
the Electron runtime, then under a minute after that.

## What you need

- macOS 11+ on Apple silicon
- Node 20+
- Nothing else. No Xcode, no Developer account, no certificates.

## What `npm run dist` actually does

1. Rebuilds the native modules (`node-pty`) against Electron's ABI
2. Packs `src/`, `assets/`, `node_modules/` into `app.asar`
3. Copies `docs/` alongside as `extraResources` — the Help menu opens them,
   and `shell.openPath` can't read inside an asar
4. Runs `scripts/afterpack.js`, which ad-hoc signs the bundle as
   `com.agungmohmd.gonds`
5. Builds the DMG with the `Applications` symlink

Config lives in [`electron-builder.config.js`](../electron-builder.config.js),
not `package.json`, so signing can follow the environment instead of needing
the file edited before a release.

## Check what came out

```bash
# right identity, not the generic Electron stub
codesign -dv dist/mac-arm64/Gonds.app        # Identifier=com.agungmohmd.gonds

# arm64, and nothing accidentally universal
lipo -archs dist/mac-arm64/Gonds.app/Contents/MacOS/Gonds

# the DMG mounts and has what it should
hdiutil attach -nobrowse -readonly dist/Gonds-*.dmg
ls "/Volumes/Gonds 1.0.0-arm64"               # Gonds.app + Applications
hdiutil detach "/Volumes/Gonds 1.0.0-arm64"
```

And the one that actually matters — drive the packaged app, not the source:

```bash
GONDS_BIN="$PWD/dist/mac-arm64/Gonds.app/Contents/MacOS/Gonds" npm run smoke
```

94 checks against the real bundle. Catches things source-mode runs don't, like
a file that never made it into the asar.

## Signing and notarisation

Default builds are **ad-hoc signed**. Gatekeeper still blocks them — see
[SECURITY.md](../SECURITY.md) for why that's fine and what it does buy.

With a paid Apple Developer account, the same command signs and notarises.
Environment only, no config change:

```bash
GONDS_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
APPLE_ID=you@example.com \
APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx \
APPLE_TEAM_ID=TEAMID \
  npm run dist
```

That password is an app-specific one from appleid.apple.com, not your Apple ID
password. Set `GONDS_SIGN_IDENTITY` without the other three and the build warns
you: signed-but-not-notarised is still blocked, so it's not worth the wait.

Hardened Runtime only switches on when there's a real identity. Forcing it on
an ad-hoc build gains nothing and can break Electron's JIT.

## Other architectures

`arch: ['arm64']` in the config. Add `'x64'` for Intel, or swap both for
`'universal'` — then verify `node-pty` actually rebuilt and runs, because that
is the part that breaks.

## The icon

`assets/icon.icns` is committed, so you don't need to build it. Only after
changing `assets/logo.png`:

```bash
bash scripts/makeicon.sh
```

Renders the artwork offscreen with Electron, resizes with `sips`, packs with
`iconutil`. It refuses to continue if the render isn't a square 1024 px —
a squashed source produced a distorted `.icns` once and nothing complained.

## When it goes wrong

**`Electron failed to install correctly`, or the app won't launch after
`npm install`.** npm 11 blocks install scripts, which leaves a truncated
`node_modules/electron/dist`. The zip is usually already in the cache:

```bash
rm -rf node_modules/electron/dist && mkdir -p node_modules/electron/dist
ditto -x -k ~/Library/Caches/electron/*/electron-v*-darwin-arm64.zip \
  node_modules/electron/dist
printf 'Electron.app/Contents/MacOS/Electron' > node_modules/electron/path.txt
node_modules/.bin/electron --version
```

**`skipped macOS code signing — identity explicitly is set to null`.** Not an
error. That's the ad-hoc path; `scripts/afterpack.js` already signed it.

**`cannot find valid "Developer ID Application" identity`.** You set
`GONDS_SIGN_IDENTITY` to something not in your keychain. Check with
`security find-identity -v -p codesigning`.

**Stale output.** `rm -rf dist` and build again. electron-builder reuses what's
there and will happily ship yesterday's `app.asar`.

**An old copy running.** `pkill -f "Gonds.app/Contents/MacOS"` before testing,
or you'll be looking at the previous build and wondering why your change
vanished.

## Releasing

```bash
npm test && npm run smoke        # 31 + 94 checks
rm -rf dist && npm run dist
GONDS_BIN="$PWD/dist/mac-arm64/Gonds.app/Contents/MacOS/Gonds" npm run smoke
```

Then attach the `.dmg` to a GitHub release. Put the quarantine command in the
release notes — people will hit it, and some will see *"Gonds is damaged"*
rather than the milder unidentified-developer wording:

```
xattr -dr com.apple.quarantine /Applications/Gonds.app
```

Bump `version` in `package.json` first; the DMG filename comes from it.
