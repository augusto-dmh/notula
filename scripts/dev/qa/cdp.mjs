// SPDX-License-Identifier: Apache-2.0
// Dev-only QA driver: a tiny Chrome DevTools Protocol client for a built Notula started by
// `app.mjs` (renderer targets on --remote-debugging-port, main process on --inspect).
// Node 25 has a global WebSocket, so this has no dependency.
//
//   node scripts/dev/qa/cdp.mjs targets
//   node scripts/dev/qa/cdp.mjs eval "<expr>" [--target <url part>]    renderer (awaits promises, prints JSON)
//   node scripts/dev/qa/cdp.mjs main "<expr>"                          main process (inspector)
//   node scripts/dev/qa/cdp.mjs shot <file.png> [--target <url part>]
//   node scripts/dev/qa/cdp.mjs type "<text>" [--target …]             Input.insertText-free typing, key by key
//   node scripts/dev/qa/cdp.mjs key <Enter|Ctrl+Alt+T|…> [--target …]
//   node scripts/dev/qa/cdp.mjs click "<css selector>" [--target …]    a real mouse click at the element's centre
//   node scripts/dev/qa/cdp.mjs clicktext "<button text>" ["<within selector>"]  waits up to 8 s
//   --chrome <url part> instead of --target drives a page of the throwaway Chrome (app.mjs chrome).
//
// The ports come from the state file `app.mjs` writes (%TEMP%\notula-qa\state.json).

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export const QA_ROOT = join(process.env.TEMP ?? tmpdir(), 'notula-qa')
export const STATE_FILE = join(QA_ROOT, 'state.json')

export function readState() {
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
}

export async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  return res.json()
}

export class Cdp {
  static async open(wsUrl) {
    const c = new Cdp()
    c.ws = new WebSocket(wsUrl)
    c.next = 1
    c.pending = new Map()
    c.listeners = []
    await new Promise((resolve, reject) => {
      c.ws.onopen = resolve
      c.ws.onerror = (e) => reject(new Error(`ws error ${e.message ?? ''}`))
    })
    c.ws.onmessage = (m) => {
      const msg = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString())
      if (msg.id && c.pending.has(msg.id)) {
        const { resolve, reject } = c.pending.get(msg.id)
        c.pending.delete(msg.id)
        if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`))
        else resolve(msg.result)
      } else if (msg.method) {
        for (const l of c.listeners) l(msg)
      }
    }
    return c
  }

  send(method, params = {}) {
    const id = this.next++
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`timeout: ${method}`))
        }
      }, 120_000).unref()
    })
  }

  async evaluate(expression, { awaitPromise = true, commandLine = false } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      includeCommandLineAPI: commandLine,
      userGesture: true
    })
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new Error(`${d.exception?.description ?? d.text}`)
    }
    return r.result.value
  }

  close() {
    try {
      this.ws.close()
    } catch {}
  }
}

/** The renderer page whose URL contains `part` (default: the main window). */
export async function rendererTarget(part) {
  const st = readState()
  const all = (await listTargets(st.rdpPort)).filter((t) => t.type === 'page')
  // Secondary windows load `index.html#/<route>` too; the main window is every other page.
  const secondary = /index\.html#\/(notification|media-worker|nub|bubble|dictation|screen|quick|dock|toast|region|guide|corner)/
  const pick = part ? all.find((t) => t.url.includes(part)) : all.find((t) => t.url.includes('index.html') && !secondary.test(t.url))
  if (!pick) throw new Error(`no target${part ? ` matching ${part}` : ''}: ${all.map((t) => t.url).join(' | ')}`)
  return pick
}

export async function renderer(part) {
  const t = await rendererTarget(part)
  return Cdp.open(t.webSocketDebuggerUrl)
}

/** A page of the throwaway Chrome (`app.mjs chrome`, port 9335) whose URL contains `part`. */
export async function chromePage(part = 'youtube.com') {
  const all = (await listTargets(9335)).filter((t) => t.type === 'page')
  const t = all.find((x) => x.url.includes(part))
  if (!t) throw new Error(`no Chrome page matching ${part}: ${all.map((x) => x.url).join(' | ')}`)
  return Cdp.open(t.webSocketDebuggerUrl)
}

export async function mainProcess() {
  const st = readState()
  const [t] = await listTargets(st.inspectPort)
  const c = await Cdp.open(t.webSocketDebuggerUrl)
  await c.send('Runtime.enable')
  return c
}

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  End: { key: 'End', code: 'End', keyCode: 35 }
}

/** `Ctrl+Alt+T`, `Enter`, `a`. */
export async function pressKey(c, combo) {
  const parts = combo.split('+')
  const name = parts.pop()
  let modifiers = 0
  if (parts.includes('Alt')) modifiers |= 1
  if (parts.includes('Ctrl')) modifiers |= 2
  if (parts.includes('Meta')) modifiers |= 4
  if (parts.includes('Shift')) modifiers |= 8
  const k = KEYS[name] ?? {
    key: name.length === 1 ? (parts.includes('Shift') ? name.toUpperCase() : name.toLowerCase()) : name,
    code: name.length === 1 ? `Key${name.toUpperCase()}` : name,
    keyCode: name.length === 1 ? name.toUpperCase().charCodeAt(0) : 0,
    text: modifiers & 3 ? undefined : name
  }
  const base = { modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode }
  await c.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, text: k.text, unmodifiedText: k.text })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

export async function typeText(c, text) {
  for (const ch of text) {
    if (ch === '\n') {
      await pressKey(c, 'Enter')
      continue
    }
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
  }
}

export async function clickSelector(c, selector) {
  const box = await c.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  if (!box) throw new Error(`no element ${selector}`)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await c.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  }
}

/** Clicks the first button or link whose trimmed text is `text` (or starts with it), waiting up to 8 s. */
export async function clickText(c, text, within = 'body') {
  const end = Date.now() + 8_000
  for (;;) {
    const ok = await c.evaluate(`(() => {
      const root = document.querySelector(${JSON.stringify(within)})
      const els = root ? [...root.querySelectorAll('button, a, [role=button], [role=menuitem], [role=tab]')] : []
      const t = ${JSON.stringify(text)}
      const el = els.find((e) => e.textContent.trim() === t) ?? els.find((e) => e.textContent.trim().startsWith(t)) ?? els.find((e) => e.getAttribute('aria-label') === t)
      if (!el) return false
      document.querySelectorAll('[data-qa-click]').forEach((x) => x.removeAttribute('data-qa-click'))
      el.setAttribute('data-qa-click', '1')
      return true
    })()`)
    if (ok) return clickSelector(c, '[data-qa-click]')
    if (Date.now() > end) throw new Error(`no button "${text}" in ${within}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

export async function screenshot(c, file) {
  const r = await c.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(file, Buffer.from(r.data, 'base64'))
}

function argOf(args, name) {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}

async function cli() {
  const args = process.argv.slice(2)
  const target = argOf(args, '--target')
  const chromePart = argOf(args, '--chrome')
  const [cmd, ...rest] = args
  const print = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2))
  if (cmd === 'targets') {
    const st = readState()
    print((await listTargets(st.rdpPort)).map((t) => `${t.type} ${t.url}`))
    return
  }
  if (cmd === 'main') {
    const c = await mainProcess()
    try {
      print(await c.evaluate(rest.join(' '), { commandLine: true }))
    } finally {
      c.close()
    }
    return
  }
  const c = chromePart ? await chromePage(chromePart) : await renderer(target)
  try {
    if (cmd === 'eval') print(await c.evaluate(rest.join(' ')))
    else if (cmd === 'shot') {
      await screenshot(c, rest[0])
      print(rest[0])
    } else if (cmd === 'type') await typeText(c, rest.join(' '))
    else if (cmd === 'key') for (const k of rest) await pressKey(c, k)
    else if (cmd === 'click') await clickSelector(c, rest.join(' '))
    else if (cmd === 'clicktext') await clickText(c, rest[0], rest[1])
    else throw new Error(`unknown command ${cmd}`)
  } finally {
    c.close()
  }
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('cdp.mjs')) {
  cli().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
