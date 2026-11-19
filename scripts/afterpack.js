'use strict'
// Runs after electron-builder packs the .app, before it builds the DMG.
//
// With a real Developer ID in the environment, electron-builder does the
// signing itself and this hook stays out of the way. Without one it ad-hoc
// signs the bundle under the app's own identifier.
//
// Ad-hoc signing does NOT satisfy Gatekeeper — users still have to clear the
// quarantine flag. What it buys is a stable code identity, which is what macOS
// keys TCC permissions on: Local Network access, Screen Recording and friends
// survive a rebuild instead of being attached to the generic "Electron" stub
// identifier the prebuilt binary ships with.
const path = require('node:path')
const { execFileSync } = require('node:child_process')

module.exports = async function afterPack (context) {
  if (context.electronPlatformName !== 'darwin') return
  if (process.env.GONDS_SIGN_IDENTITY) return // electron-builder will sign properly

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)
  const identifier = context.packager.appInfo.id

  try {
    execFileSync('/usr/bin/codesign', [
      '--force',
      '--deep',
      '--sign', '-', // ad-hoc
      '--identifier', identifier,
      '--timestamp=none',
      appPath
    ], { stdio: 'pipe' })

    const out = execFileSync('/usr/bin/codesign', ['-dv', appPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    void out
    console.log(`  • ad-hoc signed       identifier=${identifier} (not Gatekeeper-valid)`)
  } catch (err) {
    // A failed ad-hoc signature is not worth failing the build over — the app
    // still runs, it just inherits the generic identity.
    console.warn(`  • ad-hoc signing failed: ${(err.stderr || err.message || '').toString().trim()}`)
  }
}
