'use strict'
// Tiny Electron app whose only job is to render icon.html and write a 1024px
// PNG with a transparent surround.
// trade-off: Chromium is already a dependency — no image library needed.
//
// Rendering is offscreen on purpose. An on-screen window is clamped to the
// display, so on a 1470x956 laptop a 1024px tile came out 1024x833 — and the
// squashed result went into the .icns unnoticed.
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow } = require('electron')

const out = process.env.ICON_OUT || path.join(__dirname, 'icon-1024.png')
const SIZE = 1024

setTimeout(() => { console.error('icon render timed out'); app.exit(1) }, 30000)

app.disableHardwareAcceleration() // offscreen capture is more reliable on the CPU path

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, deviceScaleFactor: 1 }
  })

  await win.loadFile(path.join(__dirname, 'icon.html'))

  // Wait for the artwork itself; a fixed delay would silently render a blank
  // tile the day the image gets bigger.
  const loaded = await win.webContents.executeJavaScript(`
    (async () => {
      const img = document.querySelector('img')
      if (!img) return 'no <img> in icon.html'
      if (!img.complete) await new Promise((r) => { img.onload = r; img.onerror = r })
      return img.naturalWidth > 0 ? 'ok' : 'image failed to load: ' + img.getAttribute('src')
    })()`)
  if (loaded !== 'ok') { console.error(loaded); return app.exit(1) }

  await new Promise((r) => setTimeout(r, 400))
  let shot = await win.webContents.capturePage()
  let { width, height } = shot.getSize()

  if (width !== height) {
    console.error(`render is not square (${width}x${height}) — refusing to write a distorted icon`)
    return app.exit(1)
  }
  if (width !== SIZE) shot = shot.resize({ width: SIZE, height: SIZE, quality: 'best' })

  const png = shot.toPNG()
  fs.writeFileSync(out, png)
  console.log(`wrote ${out} (${SIZE}x${SIZE}, ${png.length} bytes)`)
  app.exit(0)
})
