// SPDX-License-Identifier: Apache-2.0
// Dev-only harness for the shared guards: the egress layer, the IPC
// guard and the capture start gates, checked inside the real app. Unpackaged builds only, with
// NOTULA_DEV_EGRESS_HARNESS=1; it writes <userData>/egress-harness.json and quits.

import { randomUUID } from 'node:crypto'
import dns from 'node:dns'
import { writeFileSync } from 'node:fs'
import https from 'node:https'
import net from 'node:net'
import { join } from 'node:path'
import { app, ipcMain, net as electronNet, type BrowserWindow } from 'electron'
import type { CaptureStartGate, MainContext } from '../context'
import { log } from '../log'
import { syncIpcGuard } from '../ipc-guard'
import { setLocalOnlyCache } from '../privacy'
import { LOCAL_ONLY_SOCKET_CODE } from './egress'

interface Result {
  id: string
  ok: boolean
  detail: string
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Every step resolves within `ms`, so one stuck step never hangs the run. */
function within<T>(label: string, p: Promise<T>, ms = 15_000): Promise<T | string> {
  log('info', 'egress-harness:step', { label })
  return Promise.race([p, sleep(ms).then(() => `timeout:${label}`)])
}

/** A Node https GET with a counting `lookup`, so "no DNS query" is observable. */
function nodeHttps(host: string): Promise<{ code: string | null; status: number | null; lookups: number }> {
  return new Promise((resolve) => {
    let lookups = 0
    const req = https.request(
      {
        host,
        path: '/',
        method: 'GET',
        timeout: 8_000,
        lookup: (hostname, opts, cb) => {
          lookups++
          dns.lookup(hostname, opts, cb)
        }
      },
      (res) => {
        res.resume()
        resolve({ code: null, status: res.statusCode ?? null, lookups })
      }
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', (err: NodeJS.ErrnoException) => resolve({ code: err.code ?? err.message, status: null, lookups }))
    req.end()
  })
}

function tcp(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    log('info', 'egress-harness:tcp-connecting', { host, port })
    const s = net.connect({ host, port })
    log('info', 'egress-harness:tcp-connect-returned', { host, port })
    s.setTimeout(3_000, () => s.destroy(new Error('timeout')))
    s.on('connect', () => {
      s.destroy()
      resolve('connected')
    })
    s.on('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message))
  })
}

async function pipeConnect(): Promise<string> {
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\notula-harness-${randomUUID()}` : join(app.getPath('temp'), `notula-harness-${process.pid}.sock`)
  const server = net.createServer((c) => {
    c.on('error', () => undefined)
    c.end()
  })
  await new Promise<void>((r) => server.listen(path, () => r()))
  const out = await new Promise<string>((resolve) => {
    const s = net.connect({ path })
    s.on('connect', () => {
      s.destroy()
      resolve('connected')
    })
    s.on('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message))
  })
  server.close()
  return out
}

async function mainFetch(url: string): Promise<string> {
  try {
    const r = await electronNet.fetch(url)
    return `status:${r.status}`
  } catch (err) {
    return `error:${err instanceof Error ? err.message : String(err)}`
  }
}

function inRenderer(win: BrowserWindow, js: string): Promise<string> {
  return win.webContents.executeJavaScript(js, true).then(
    (v: unknown) => String(v),
    (err: unknown) => `exec-error:${String(err)}`
  )
}

/**
 * A renderer request the page's CSP allows (img-src lists gravatar), so only the egress layer can
 * stop it: \`fetch\` to another host is refused by the CSP (connect-src 'self') whatever the egress.
 */
const RENDERER_FETCH = `new Promise((r) => { const i = new Image(); i.onload = () => r('loaded'); i.onerror = () => r('error'); i.src = 'https://www.gravatar.com/avatar/00000000000000000000000000000000?d=identicon&s=8&n=' + Math.random() })`

export async function runEgressHarness(ctx: MainContext): Promise<void> {
  const results: Result[] = []
  const add = (id: string, ok: boolean, detail: string): void => {
    results.push({ id, ok, detail })
    log('info', 'egress-harness:check', { id, ok, detail })
  }
  const beat = setInterval(() => log('info', 'egress-harness:beat'), 2_000)
  try {
    // Wait for the main window's renderer.
    let win: BrowserWindow | null = null
    for (let i = 0; i < 120 && !win; i++) {
      const w = ctx.windows.main()
      if (w && !w.webContents.isLoading()) win = w
      else await sleep(250)
    }
    if (!win) throw new Error('no main window')
    await sleep(2_000)

    const status = await ctx.storage.status()
    add('storage.ready', status.state === 'ready', `${status.state} schema ${status.schemaVersion ?? '?'}`)
    try {
      const page = await ctx.storage.listNotes({ limit: 50 } as never)
      add('storage.list-notes', true, `${(page as { items?: unknown[] }).items?.length ?? '?'} notes`)
    } catch (err) {
      add('storage.list-notes', false, String(err))
    }

    const setLocalOnly = async (on: boolean): Promise<void> => {
      await ctx.settings.set('privacy.localOnly', on)
      setLocalOnlyCache(on)
      await sleep(300)
    }

    // ---------- local-only ON ----------
    await setLocalOnly(true)
    const a = await nodeHttps('api.anthropic.com')
    add('on.node-https-refused', a.code === LOCAL_ONLY_SOCKET_CODE && a.lookups === 0, JSON.stringify(a))
    const local = net.createServer((c) => {
      // The client hangs up at once; a reset here must not become an uncaught main-process error.
      c.on('error', () => undefined)
      c.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n')
    })
    await within('listen', new Promise<void>((r) => local.listen(0, '127.0.0.1', () => r())))
    const port = (local.address() as net.AddressInfo).port
    add('on.loopback-allowed', (await within("tcp('127.0.0.1', port)", tcp('127.0.0.1', port))) === 'connected', `127.0.0.1:${port}`)
    const ollama = await within("tcp('127.0.0.1', 11434)", tcp('127.0.0.1', 11434))
    add('on.loopback-11434-not-refused', ollama !== LOCAL_ONLY_SOCKET_CODE, ollama)
    add('on.pipe-allowed', (await within('pipeConnect()', pipeConnect())) === 'connected', 'named pipe / unix socket')
    const rf = await within('inRenderer(win, RENDERER_FETCH)', inRenderer(win, RENDERER_FETCH))
    add('on.renderer-request-cancelled', rf === 'error', rf)
    const mf = await within("mainFetch('https://example.com/')", mainFetch('https://example.com/'))
    add('on.main-net-fetch-cancelled', /ERR_BLOCKED_BY_CLIENT/.test(mf), mf)

    // ---------- local-only OFF ----------
    await setLocalOnly(false)
    await ctx.settings.set('people.gravatarEnabled', true)
    await sleep(300)
    const rf2 = await within('renderer image off', inRenderer(win, RENDERER_FETCH))
    add('off.renderer-request-goes-through', rf2 === 'loaded', String(rf2))
    await ctx.settings.set('people.gravatarEnabled', false)
    await sleep(300)
    const gv = await mainFetch('https://www.gravatar.com/avatar/00000000000000000000000000000000')
    add('off.gravatar-filter-cancels', /ERR_BLOCKED_BY_CLIENT/.test(gv), gv)
    const a2 = await nodeHttps('api.anthropic.com')
    add('off.node-https-goes-through', a2.status !== null, JSON.stringify(a2))
    add('off.loopback', (await within("tcp('127.0.0.1', port)", tcp('127.0.0.1', port))) === 'connected', `127.0.0.1:${port}`)
    add('off.pipe', (await within('pipeConnect()', pipeConnect())) === 'connected', 'named pipe / unix socket')
    const mf2 = await within("mainFetch('https://example.com/')", mainFetch('https://example.com/'))
    add('off.main-net-fetch-goes-through', mf2.startsWith('status:'), mf2)
    local.close()

    // ---------- IPC guard ----------
    const realLock = ctx.deviceLock
    let forced = true
    ctx.deviceLock = { ...realLock, isLocked: () => forced }
    syncIpcGuard()
    const notes = await inRenderer(win, `window.notula.notes.list({ limit: 1 }).then(() => 'resolved', (e) => 'rejected:' + e.message)`)
    add('lock.notes-list-locked', /locked: Notula is locked/.test(notes), notes)
    const info = await inRenderer(win, `window.notula.app.info().then((v) => 'resolved:' + v.name, (e) => 'rejected:' + e.message)`)
    add('lock.app-info-resolves', info.startsWith('resolved'), info)
    const cap = await inRenderer(win, `window.notula.capture.getStatus().then(() => 'resolved', (e) => 'rejected:' + e.message)`)
    add('lock.capture-status-resolves', cap === 'resolved', cap)
    const themeBefore = await ctx.settings.get('ui.theme')
    const nextTheme = themeBefore === 'light' ? 'dark' : 'light'
    await inRenderer(win, `(window.notula.prefs.set({ 'ui.theme': '${nextTheme}' }), 'sent')`)
    await sleep(500)
    add('lock.send-dropped', (await ctx.settings.get('ui.theme')) === themeBefore, `theme stays ${themeBefore}`)
    forced = false
    syncIpcGuard()
    const notes2 = await inRenderer(win, `window.notula.notes.list({ limit: 1 }).then(() => 'resolved', (e) => 'rejected:' + e.message)`)
    add('lock.unlocked-notes-list', !/locked:/.test(notes2), notes2)
    ctx.deviceLock = realLock

    // ---------- capture start gates ----------
    await inRenderer(win, `(window.__stops = [], window.notula.capture.onStopRequested((p) => window.__stops.push(p.reason)), 'ok')`)
    const n1 = await ctx.storage.createNote({ origin: 'new_note_button', title: 'Gate hold', created_via: 'Windows' } as never)
    const n2 = await ctx.storage.createNote({ origin: 'new_note_button', title: 'Gate block', created_via: 'Windows' } as never)
    const desired = (noteId: string): unknown => ({
      capture: 'on',
      noteId,
      requestedAt: new Date().toISOString(),
      language: 'en',
      keywords: [],
      asr: 'deepgram'
    })
    const fakeEvent = { sender: win.webContents }
    // Local-only on, so the cloud ASR session makes no call while the gate test captures.
    await setLocalOnly(true)
    const hold: CaptureStartGate = { id: 'consent', beforeStart: async () => ({ result: 'hold' }) }
    const unHold = ctx.capture.registerStartGate(hold)
    ipcMain.emit('capture:set-desired-state', fakeEvent, desired(n1.id))
    await sleep(500)
    const held = ctx.capture.heldStart()
    add('gate.hold', held?.noteId === n1.id && held.gateId === 'consent' && !ctx.capture.isCapturing(), JSON.stringify({ held, capturing: ctx.capture.isCapturing() }))
    unHold()
    ctx.capture.releaseHeldStart(n1.id)
    await sleep(1_000)
    add('gate.release-starts', ctx.capture.isCapturing() && ctx.capture.currentNoteId() === n1.id, `capturing ${ctx.capture.isCapturing()} note ${ctx.capture.currentNoteId()}`)
    await ctx.capture.stop('toggle_off')
    await sleep(500)
    const block: CaptureStartGate = { id: 'transcription-rules', beforeStart: async () => ({ result: 'block', reason: 'recording_rule' }) }
    const unBlock = ctx.capture.registerStartGate(block)
    await inRenderer(win, `(window.__stops = [], 'ok')`)
    ipcMain.emit('capture:set-desired-state', fakeEvent, desired(n2.id))
    await sleep(800)
    const stops = await inRenderer(win, `JSON.stringify(window.__stops)`)
    add('gate.block-pushes-row-32', stops.includes('recording_rule') && !ctx.capture.isCapturing(), stops)
    unBlock()
    await setLocalOnly(false)
  } catch (err) {
    add('harness.error', false, err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err))
  }
  clearInterval(beat)
  const failed = results.filter((r) => !r.ok).length
  writeFileSync(join(app.getPath('userData'), 'egress-harness.json'), JSON.stringify({ failed, total: results.length, results }, null, 2))
  log('info', 'egress-harness:done', { failed, total: results.length })
  setTimeout(() => app.quit(), 500)
}
