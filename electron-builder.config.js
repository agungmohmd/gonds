'use strict'
// Build configuration. Lives in JS rather than package.json so signing and
// notarisation can switch on what the environment actually has, instead of
// needing the file edited before every release.
//
//   npm run dist                      ad-hoc signed, Gatekeeper will warn
//   GONDS_SIGN_IDENTITY="Developer ID Application: Name (TEAMID)" \
//   APPLE_ID=… APPLE_APP_SPECIFIC_PASSWORD=… APPLE_TEAM_ID=… \
//     npm run dist                    signed + notarised + stapled
//
// The notarisation credentials are an app-specific password from
// appleid.apple.com, not your Apple ID password.

const identity = process.env.GONDS_SIGN_IDENTITY || null
const canNotarise = Boolean(
  identity && process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID
)

if (identity && !canNotarise) {
  console.warn('  • signing identity set but notarisation credentials are missing — ' +
    'the build will be signed and NOT notarised, which Gatekeeper still blocks.')
}

module.exports = {
  appId: 'com.agungmohmd.gonds',
  productName: 'Gonds',
  files: ['src/**/*', 'assets/**/*', 'node_modules/**/*', 'package.json'],
  extraResources: ['docs/**'],
  afterPack: 'scripts/afterpack.js',
  mac: {
    category: 'public.app-category.developer-tools',
    target: [{ target: 'dmg', arch: ['arm64'] }],
    icon: 'assets/icon.icns',
    darkModeSupport: true,
    // Hardened Runtime is only meaningful alongside a real identity; forcing it
    // on an ad-hoc build buys nothing and can break the JIT.
    hardenedRuntime: Boolean(identity),
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    identity,
    notarize: canNotarise,
    extendInfo: {
      // macOS 15+ asks before an app may reach the LAN. Without this string the
      // prompt appears blank, and SSH to a 192.168.x.x host fails with
      // EHOSTUNREACH until the user grants it.
      NSLocalNetworkUsageDescription:
        'Gonds connects to servers on your local network over SSH, SFTP and other terminal protocols.'
    }
  },
  dmg: {
    contents: [
      { x: 140, y: 190, type: 'file' },
      { x: 400, y: 190, type: 'link', path: '/Applications' }
    ]
  }
}
