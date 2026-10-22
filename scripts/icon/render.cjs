// SPDX-License-Identifier: Apache-2.0
// Renders resources/icon/icon.svg to the app icon files:
//   icon-256.png, icon-512.png and icon.ico (16–256 px, PNG entries).
// With --tasks, renders each resources/icon/task-*.svg to resources/task-*.ico instead
// (16–48 px, PNG entries): the Windows jump list icons.
// Electron main script, offscreen only (no window is ever shown):
//   npx electron scripts/icon/render.cjs <icon.svg> <out dir> <scratch userData dir>
//   npx electron scripts/icon/render.cjs --tasks <svg dir> <out dir> <scratch userData dir>
// The scratch userData keeps Electron's default profile folder out of %APPDATA%.

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const tasks = process.argv.includes('--tasks')
const [svgPath, outDir, userData] = process.argv.slice(-3).map((p) => path.resolve(p))
app.setPath('userData', userData)
app.disableHardwareAcceleration()

const PNG_SIZES = [256, 512]
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const TASK_ICO_SIZES = [16, 20, 24, 32, 40, 48]
const CANVAS = 512

async function render(win, svg, size) {
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  const html = `<!doctype html><html><body style="margin:0;background:transparent"><img src="${src}" width="${size}" height="${size}" style="display:block"></body></html>`
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`)
  await new Promise((r) => setTimeout(r, 250))
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
  const { width, height } = img.getSize()
  return width === size && height === size ? img : img.resize({ width: size, height: size, quality: 'best' })
}

function ico(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + dir.length
  entries.forEach(({ size, png }, i) => {
    const o = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, o)
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1)
    dir.writeUInt8(0, o + 2)
    dir.writeUInt8(0, o + 3)
    dir.writeUInt16LE(1, o + 4)
    dir.writeUInt16LE(32, o + 6)
    dir.writeUInt32LE(png.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += png.length
  })
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: CANVAS,
      height: CANVAS,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      useContentSize: true,
      webPreferences: { offscreen: true }
    })
    fs.mkdirSync(outDir, { recursive: true })
    if (tasks) {
      // svgPath is the folder: task-<name>.svg → <out dir>/task-<name>.ico
      for (const file of fs.readdirSync(svgPath).filter((f) => /^task-.+.svg$/.test(f))) {
        const svg = fs.readFileSync(path.join(svgPath, file), 'utf8')
        const entries = []
        for (const size of TASK_ICO_SIZES) entries.push({ size, png: (await render(win, svg, size)).toPNG() })
        const name = file.replace(/.svg$/, '.ico')
        fs.writeFileSync(path.join(outDir, name), ico(entries))
        console.log(`${name} (${TASK_ICO_SIZES.join(', ')})`)
      }
      win.destroy()
      app.exit(0)
      return
    }
    const svg = fs.readFileSync(svgPath, 'utf8')
    for (const size of PNG_SIZES) {
      const img = await render(win, svg, size)
      fs.writeFileSync(path.join(outDir, `icon-${size}.png`), img.toPNG())
      console.log(`icon-${size}.png`)
    }
    const entries = []
    for (const size of ICO_SIZES) entries.push({ size, png: (await render(win, svg, size)).toPNG() })
    fs.writeFileSync(path.join(outDir, 'icon.ico'), ico(entries))
    console.log(`icon.ico (${ICO_SIZES.join(', ')})`)
    win.destroy()
    app.exit(0)
  } catch (err) {
    console.error(err)
    app.exit(1)
  }
})
