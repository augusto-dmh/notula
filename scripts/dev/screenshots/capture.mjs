// SPDX-License-Identifier: Apache-2.0
// Dev-only: the README screenshots, made reproducibly from demo data. Needs a built Notula
// (`npm run build`) and ffmpeg on PATH (image optimisation and the animated loop).
//
//   node scripts/dev/screenshots/capture.mjs [--out <dir>] [--keep]
//
// It starts Notula on a throwaway profile under %TEMP%\notula-shots (deleted at the end unless
// --keep), on the secondary display (NOTULA_DEV_DISPLAY), and drives it over the Chrome DevTools
// Protocol (scripts/dev/qa/cdp.mjs). Every main-window shot is the same 1440×900 viewport at a
// device scale of 1.5. Window captures only: no OS input, no desktop grabs.
//
// Content is demo data only:
// - the built-in demo meeting (resources/demo), which ends on the example summary;
// - fixtures/notula-export: made-up meetings imported through Notula's Markdown import
//   (NOTULA_DEV_IMPORT_DIR answers the folder picker). Their dates move so the newest is yesterday;
// - a canned answer from a mock OpenAI-compatible server on 127.0.0.1, set up as the local AI
//   model, for the chat shot. No API key and no cloud call;
// - the privacy shot turns on "Nothing leaves this machine" with a local speech model that reads as
//   installed: zero-filled placeholder files of the manifest's sizes (the app checks sizes only).
//
// Output (docs/images by default): hero-light.png, hero-dark.png, live-meeting.png, library.png,
// search.png, ask.png, privacy.png, floating-dictation.png and live.webp.

import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, openSync, closeSync, ftruncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Cdp, listTargets, pressKey } from '../qa/cdp.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const FIXTURES = join(import.meta.dirname, 'fixtures', 'notula-export')
/** The fixtures' newest day; it lands on yesterday. */
const FIXTURE_ANCHOR = '2026-10-23'
const RDP_PORT = 9353
const INSPECT_PORT = 9354
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1.5, mobile: false }
/** Above this a PNG is quantised to a 256-colour palette. */
const PNG_BUDGET = 600 * 1024

const args = process.argv.slice(2)
const OUT = resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : join(ROOT, 'docs', 'images'))
const KEEP = args.includes('--keep')
const WORK = join(process.env.TEMP ?? tmpdir(), 'notula-shots', new Date().toISOString().replace(/[:.]/g, '-'))
const PROFILE = join(WORK, 'profile')
const RAW = join(WORK, 'raw')
const FRAMES = join(WORK, 'frames')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[shots ${new Date().toISOString().slice(11, 19)}]`, ...a)

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch {}
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(250)
  }
}

// ---------- fixtures ----------

/** A copy of the fixtures with every ISO time moved by whole days, so the newest is yesterday. */
function stageFixtures() {
  const dir = join(WORK, 'import', 'notula-export')
  cpSync(FIXTURES, dir, { recursive: true })
  const today = new Date()
  const yesterday = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  const shift = yesterday - Date.parse(`${FIXTURE_ANCHOR}T00:00:00.000Z`)
  for (const name of readdirSync(join(dir, 'notes'))) {
    const p = join(dir, 'notes', name)
    const text = readFileSync(p, 'utf8').replace(/"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)"/g, (_, iso) => `"${new Date(Date.parse(iso) + shift).toISOString()}"`)
    writeFileSync(p, text)
  }
  return dir
}

/** Zero-filled files with the sizes src/main/asr/manifest.ts lists for the smallest speech model. */
function placeholderSpeechModel() {
  const id = 'parakeet-tdt-110m-en-int8'
  const manifest = readFileSync(join(ROOT, 'src', 'main', 'asr', 'manifest.ts'), 'utf8')
  const entry = manifest.slice(manifest.indexOf(`'${id}': {`), manifest.indexOf('totalBytes', manifest.indexOf(`'${id}': {`)))
  const members = [...entry.matchAll(/path: '([^']+)',\s*bytes: ([\d_]+)/g)].map((m) => ({ path: m[1], bytes: Number(m[2].replace(/_/g, '')) }))
  if (!members.length) throw new Error(`no members for ${id} in manifest.ts`)
  const dir = join(PROFILE, 'models', 'asr', id)
  mkdirSync(dir, { recursive: true })
  for (const m of members) {
    const fd = openSync(join(dir, m.path), 'w')
    ftruncateSync(fd, m.bytes)
    closeSync(fd)
  }
}

// ---------- the mock local AI model ----------

const TITLE = 'Launch decisions'

/** The canned answer, citing the meeting the prompt names (its summary, then transcript passage 1). */
function answerFor(system) {
  const id = /The meeting's id, for tools and citations: ([0-9a-f-]{36})/.exec(system)?.[1]
  const note = id ? ` [${id}]` : ''
  const passage = id && system.includes(`[${id}-1]`) ? ` [${id}-1]` : note
  return [
    `The launch is set for **Tuesday, March 3**.${note}`,
    '',
    `- **Beta:** 200 users get it through TestFlight a week before launch; the sign-up form is already live.${passage}`,
    `- **Budget:** $12,000 for launch week, mostly social ads. The paid influencer campaign waits until after the first month.${passage}`,
    `- **Blocker:** the payment screen fails on older Android phones and must be fixed first. Ana owns it and will share an update by Friday.${note}`,
    '',
    `Still open: whether Portugal and Brazil launch on the same day, to be decided next week.${note}`
  ].join('\n')
}

function startMockLlm() {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      if (req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'local-demo', object: 'model' }] }))
      }
      let j = {}
      try {
        j = JSON.parse(body || '{}')
      } catch {}
      const system = (j.messages ?? []).filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
      const text = /name chat threads/i.test(system) ? TITLE : answerFor(system)
      if (!j.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ id: 'mock', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }))
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const parts = text.match(/[\s\S]{1,16}/g) ?? []
      let i = 0
      const tick = setInterval(() => {
        if (i < parts.length) {
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: parts[i++] } }] })}\n\n`)
          return
        }
        clearInterval(tick)
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
        res.end('data: [DONE]\n\n')
      }, 20)
    })
  })
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)))
}

// ---------- the app ----------

let child = null

function launch(importDir) {
  mkdirSync(PROFILE, { recursive: true })
  const env = { ...process.env, NOTULA_USER_DATA_DIR: PROFILE, NOTULA_DEV_DISPLAY: 'secondary', NOTULA_DEV_IMPORT_DIR: importDir }
  delete env.ELECTRON_RUN_AS_NODE
  const out = openSync(join(WORK, 'app.log'), 'a')
  child = spawn(ELECTRON, [ROOT, `--remote-debugging-port=${RDP_PORT}`, `--inspect=${INSPECT_PORT}`], { cwd: ROOT, env, stdio: ['ignore', out, out] })
  child.on('exit', () => (child = null))
}

async function pages() {
  return (await listTargets(RDP_PORT)).filter((t) => t.type === 'page')
}

async function mainProcess() {
  const [t] = await listTargets(INSPECT_PORT)
  const c = await Cdp.open(t.webSocketDebuggerUrl)
  await c.send('Runtime.enable')
  return c
}

async function quit() {
  if (!child) return
  const pid = child.pid
  try {
    const m = await mainProcess()
    await m.evaluate(`process.mainModule.require('electron').app.quit()`, { commandLine: true }).catch(() => undefined)
    m.close()
  } catch {}
  await waitFor(() => child === null, 20_000, 'quit').catch(() => {
    try {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' })
    } catch {}
  })
}

/** Puts the main window on its display's top-left corner, a little larger than the viewport. */
async function placeMainWindow(m) {
  await m.evaluate(
    `(() => {
      const { BrowserWindow, screen } = process.mainModule.require('electron')
      const w = BrowserWindow.getAllWindows().find((x) => !/#\\/(demo|dictation|notification|nub|bubble|quick|dock|toast|corner)/.test(x.webContents.getURL()))
      const wa = screen.getDisplayMatching(w.getBounds()).workArea
      w.setBounds({ x: wa.x, y: wa.y, width: Math.min(wa.width, 1480), height: Math.min(wa.height, 960) })
    })()`,
    { commandLine: true }
  )
}

// ---------- renderer helpers ----------

class Page {
  constructor(c) {
    this.c = c
  }
  eval(expr) {
    return this.c.evaluate(expr)
  }
  async viewport() {
    await this.c.send('Emulation.setDeviceMetricsOverride', VIEWPORT)
  }
  /** Clicks the first button whose text or aria-label is `text`, if there is one. */
  async clickText(text, { within = 'body', wait = 0 } = {}) {
    const end = Date.now() + wait
    for (;;) {
      const box = await this.eval(`(() => {
        const t = ${JSON.stringify(text)}
        const els = [...(document.querySelector(${JSON.stringify(within)})?.querySelectorAll('button, a, [role=button], [role=tab], [role=menuitem]') ?? [])]
        const el = els.find((e) => e.getAttribute('aria-label') === t) ?? els.find((e) => e.textContent.trim() === t) ?? els.find((e) => e.textContent.trim().startsWith(t))
        if (!el) return null
        el.scrollIntoView({ block: 'nearest' })
        const r = el.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      })()`)
      if (box) {
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
          await this.c.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
        }
        await this.c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
        return true
      }
      if (Date.now() >= end) return false
      await sleep(250)
    }
  }
  async mustClick(text, opts = {}) {
    if (await this.clickText(text, { wait: 10_000, ...opts })) return
    const seen = await this.eval(`[...document.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || b.textContent.trim()).join(' | ')`)
    throw new Error(`no button "${text}" at ${await this.eval('location.hash')}: ${seen}`)
  }
  async focus(selector) {
    const box = await this.eval(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r && { x: r.x + 24, y: r.y + 12 } })()`)
    if (!box) throw new Error(`no ${selector}`)
    for (const type of ['mousePressed', 'mouseReleased']) await this.c.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  }
  /** Types like a person: one key at a time. */
  async type(text, delayMs = 45) {
    for (const ch of text) {
      if (ch === '\n') await pressKey(this.c, 'Enter')
      else {
        await this.c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch })
        await this.c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
      }
      await sleep(delayMs)
    }
  }
  async go(hash) {
    await this.eval(`location.hash = ${JSON.stringify(hash)}`)
    await sleep(1200)
  }
  /** No focus ring, caret or hover: the page at rest. */
  async settle() {
    await this.eval(`document.activeElement?.blur?.(); window.getSelection()?.removeAllRanges()`)
    await this.c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
    await sleep(500)
  }
  async png(file) {
    const r = await this.c.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(file, Buffer.from(r.data, 'base64'))
  }
  close() {
    this.c.close()
  }
}

async function openPage(targetId) {
  const t = (await pages()).find((p) => p.id === targetId)
  if (!t) throw new Error(`no target ${targetId}`)
  return new Page(await Cdp.open(t.webSocketDebuggerUrl))
}

const shots = []

async function shot(page, name) {
  mkdirSync(RAW, { recursive: true })
  const raw = join(RAW, `${name}.png`)
  await page.png(raw)
  shots.push(name)
  log('captured', name)
}

// ---------- the steps ----------

async function setPrefs(page, patch) {
  await page.eval(`window.notula.prefs.set(${JSON.stringify(patch)})`)
  await sleep(600)
}

async function importFixtures(page) {
  const res = await page.eval(`(async () => {
    const n = window.notula.notesImport
    const picked = await n.chooseFolder()
    if (!picked.handle) throw new Error('no folder')
    const { previewId } = await n.scan({ handle: picked.handle, preset: 'notula-export' })
    let preview = null
    for (let i = 0; i < 120 && !preview; i++) {
      preview = await n.getPreview({ previewId })
      if (!preview) await new Promise((r) => setTimeout(r, 250))
    }
    const rows = preview.rows.filter((r) => r.status === 'new')
    const { batchId } = await n.start({ previewId, itemIds: rows.map((r) => r.itemId), options: { ...preview.options, folderMode: 'mirror' } })
    for (let i = 0; i < 240; i++) {
      const b = (await n.listBatches()).find((x) => x.id === batchId)
      if (b && b.state !== 'queued' && b.state !== 'running') return { state: b.state, counts: b.counts, rows: rows.length }
      await new Promise((r) => setTimeout(r, 250))
    }
    return { state: 'timeout' }
  })()`)
  log('import', JSON.stringify(res))
  if (res.state !== 'complete') throw new Error(`import ${res.state}`)
}

async function demoState(page) {
  return page.eval('window.notula.demo.getState()')
}

async function showTranscript(page) {
  if (await page.eval(`!document.querySelector('button[aria-label="Hide transcript"]')`)) await page.mustClick('Show transcript')
}

/** The live meeting: three typed notes, the animated loop's frames, and live-meeting.png. */
async function demoMeeting(page, m) {
  await page.go('#/')
  await page.mustClick('Try a demo meeting')
  await waitFor(async () => (await page.eval('location.hash')).startsWith('#/meeting/'), 15_000, 'the demo note')
  await sleep(1500)
  await placeMainWindow(m)
  await page.viewport()
  await sleep(800)
  await page.clickText('Dismiss tip')
  await showTranscript(page)
  await page.focus('.ProseMirror')
  const at = async (ms) => waitFor(async () => (await demoState(page)).elapsedMs >= ms, 60_000, `demo ${ms} ms`)

  // The loop: 12 s around the launch-date lines, with two notes typed while it records.
  mkdirSync(FRAMES, { recursive: true })
  await at(13_500)
  let recording = true
  const frames = (async () => {
    let n = 0
    const t0 = Date.now()
    while (recording) {
      const r = await page.c.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 })
      writeFileSync(join(FRAMES, `f${String(n++).padStart(4, '0')}.jpg`), Buffer.from(r.data, 'base64'))
      const next = t0 + n * 125
      if (next > Date.now()) await sleep(next - Date.now())
    }
    return { n, ms: Date.now() - t0 }
  })()
  await at(15_000)
  await page.type('- Launch Tue, Mar 3')
  await at(21_500)
  await page.type('\nBeta: 200 users on TestFlight')
  await at(25_500)
  recording = false
  const loop = await frames
  log('frames', JSON.stringify(loop))
  await at(31_000)
  await page.type('\nBudget $12k, mostly social ads')
  await at(46_500)
  await page.settle()
  await shot(page, 'live-meeting')
  return loop
}

async function finishDemo(page, m) {
  await waitFor(async () => {
    const s = await demoState(page)
    return !s.playing && s.elapsedMs >= s.durationMs
  }, 150_000, 'the demo to end')
  await waitFor(async () => page.eval(`[...document.querySelectorAll('button,[role=tab]')].some((b) => b.textContent.trim() === 'Enhanced notes')`), 30_000, 'the summary')
  await sleep(1000)
  await page.mustClick('Close video')
  await sleep(1500)
  await placeMainWindow(m)
  await page.viewport()
}

async function hero(page) {
  await page.clickText('Hide sidebar')
  await page.clickText('Enhanced notes')
  await showTranscript(page)
  await sleep(600)
  await page.settle()
  await shot(page, 'hero-light')
  await page.eval(`window.notula.prefs.set({ 'ui.theme': 'dark' })`)
  await sleep(1200)
  await page.settle()
  await shot(page, 'hero-dark')
  await page.eval(`window.notula.prefs.set({ 'ui.theme': 'light' })`)
  await sleep(1000)
}

async function ask(page, port) {
  await setPrefs(page, { 'llm.provider': 'local', 'llm.local.baseUrl': `http://127.0.0.1:${port}/v1`, 'llm.local.model': 'local-demo' })
  await page.clickText('Hide transcript')
  await page.mustClick('Ask about this meeting')
  await sleep(800)
  await page.focus('.chat-composer__field')
  await page.type('What did we decide about the launch?', 15)
  await pressKey(page.c, 'Enter')
  await waitFor(async () => page.eval(`document.body.innerText.includes('Still open: whether Portugal')`), 30_000, 'the answer')
  await sleep(1500)
  await page.settle()
  await shot(page, 'ask')
  await page.clickText('Close chat')
}

async function library(page) {
  await page.go('#/')
  await page.clickText('Show sidebar')
  await page.clickText('Got it')
  await sleep(400)
  // Open the My notes section so the imported folders show.
  await page.eval(`(() => { const b = document.querySelector('[aria-label="Expand section"]'); if (b && b.getAttribute('aria-expanded') !== 'true') b.click() })()`)
  await sleep(600)
  await page.settle()
  await shot(page, 'library')
  // Search: the palette's note results.
  await page.mustClick('Search')
  await waitFor(() => page.eval(`!!document.querySelector('input[aria-label="Command palette"]')`), 5_000, 'the palette')
  await page.type('reporting', 40)
  await sleep(1500)
  await page.c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
  await shot(page, 'search')
  await pressKey(page.c, 'Escape')
}

async function privacy(page) {
  await setPrefs(page, { 'asr.provider': 'local' })
  const r = await page.eval(`window.notula.privacy.setLocalOnly({ enabled: true, confirmed: true })`)
  if (!r?.ok) throw new Error(`local-only: ${JSON.stringify(r)}`)
  await page.go('#/settings/preferences')
  await page.clickText('Show sidebar')
  await page.clickText('Got it')
  await sleep(600)
  await page.eval(`[...document.querySelectorAll('h2')].find((e) => /How your data is used/.test(e.textContent))?.scrollIntoView({ block: 'start' })`)
  await page.settle()
  await shot(page, 'privacy')
}

/** The dictation pill at rest, on a transparent background, cropped to the pill and its shadow. */
async function floating() {
  const t = (await pages()).find((p) => p.url.includes('#/dictation-pill'))
  if (!t) return log('skip floating-dictation: no pill window')
  const page = new Page(await Cdp.open(t.webSocketDebuggerUrl))
  await page.c.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
  await page.c.send('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: VIEWPORT.deviceScaleFactor, mobile: false })
  await sleep(500)
  // The largest element with a visible background is the pill.
  const clip = await page.eval(`(() => {
    let best = null
    for (const el of document.querySelectorAll('.dict-pill-root *')) {
      const bg = getComputedStyle(el).backgroundColor
      const r = el.getBoundingClientRect()
      if (!/rgba?\\(/.test(bg) || /, 0\\)$/.test(bg) || r.width * r.height === 0) continue
      if (!best || r.width * r.height > best.width * best.height) best = r
    }
    if (!best) return null
    const pad = 16
    const x = Math.max(0, best.x - pad), y = Math.max(0, best.y - pad)
    return { x, y, width: Math.min(innerWidth - x, best.width + 2 * pad), height: Math.min(innerHeight - y, best.height + 2 * pad), scale: 1 }
  })()`)
  mkdirSync(RAW, { recursive: true })
  const r = await page.c.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) })
  writeFileSync(join(RAW, 'floating-dictation.png'), Buffer.from(r.data, 'base64'))
  shots.push('floating-dictation')
  log('captured floating-dictation', clip ? 'cropped' : 'whole window')
  page.close()
}

// ---------- output ----------

function ffmpeg(a) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a], { stdio: 'inherit' })
}

function writeImages(loop) {
  mkdirSync(OUT, { recursive: true })
  for (const name of shots) {
    const raw = join(RAW, `${name}.png`)
    const out = join(OUT, `${name}.png`)
    if (statSync(raw).size <= PNG_BUDGET) cpSync(raw, out)
    else ffmpeg(['-i', raw, '-vf', 'split[a][b];[a]palettegen=max_colors=256:stats_mode=full:reserve_transparent=1[p];[b][p]paletteuse=dither=none', '-compression_level', '100', out])
    log(`${name}.png`, `${Math.round(statSync(out).size / 1024)} KB`)
  }
  if (loop?.n) {
    const fps = Math.max(1, Math.round((loop.n * 1000) / loop.ms))
    const out = join(OUT, 'live.webp')
    ffmpeg(['-framerate', String(fps), '-i', join(FRAMES, 'f%04d.jpg'), '-vf', 'scale=1200:-1:flags=lanczos', '-c:v', 'libwebp', '-lossless', '0', '-quality', '70', '-compression_level', '6', '-loop', '0', '-an', out])
    log('live.webp', `${Math.round(statSync(out).size / 1024)} KB`, `${fps} fps`)
  }
}

// ---------- run ----------

async function main() {
  mkdirSync(WORK, { recursive: true })
  log('work', WORK)
  const importDir = stageFixtures()
  placeholderSpeechModel()
  const llm = await startMockLlm()
  let loop = null
  try {
    launch(importDir)
    const first = await waitFor(async () => (await pages()).find((p) => /index\.html$/.test(p.url)), 45_000, 'the main window')
    const m = await waitFor(() => mainProcess(), 15_000, 'the main process')
    const page = await openPage(first.id)
    await waitFor(() => page.eval(`!!window.notula?.prefs`), 15_000, 'the bridge')
    const t = new Date().toISOString()
    await setPrefs(page, { 'onboarding.aiProvidersDoneAt': t, 'onboarding.calendarDoneAt': t, 'ui.theme': 'light' })
    await placeMainWindow(m)
    await page.viewport()
    // The demo first: Home offers it only while there are at most five notes.
    loop = await demoMeeting(page, m)
    await finishDemo(page, m)
    await hero(page)
    await ask(page, llm.address().port)
    // Privacy before the import, so the Your data card has no import history above it.
    await privacy(page)
    await importFixtures(page)
    await library(page)
    await floating()
    page.close()
    m.close()
  } finally {
    await quit()
    llm.close()
  }
  writeImages(loop)
  if (!KEEP) rmSync(WORK, { recursive: true, force: true })
  log('done', OUT)
}

main().catch(async (e) => {
  console.error(e)
  await quit()
  process.exit(1)
})
