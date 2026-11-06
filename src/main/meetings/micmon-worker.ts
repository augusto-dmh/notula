// SPDX-License-Identifier: Apache-2.0
// The notula-micmon utility process entry, built to out/main/micmon.js. It owns one
// long-lived OS child process
// that reports which apps use the microphone. No network; it never sees audio.
//
// - Windows: one PowerShell child (micmon-script.ts) waits on a change notification for the
//   per-user consent store, with a 60 s safety rescan (every 5 s when the notification is
//   unavailable), and prints a JSON line when the set of in-use entries changes.
// - macOS: `log stream` on Control Center's sensor-indicator messages, `mic:` entries,
//   debounced by 2 s.
//
// Main maps the raw ids to apps (apps.ts). If the child dies, this process exits and
// main restarts it with its backoff.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { micmonWindowsScript } from './micmon-script'

/** main → worker. `stop` ends the OS child first, then this process. */
export type MicmonStart = { type: 'start'; platform: NodeJS.Platform } | { type: 'stop' }

/** worker → main. */
export type MicmonEvent =
  | { type: 'ready' }
  /** The raw in-use ids, on every change. */
  | { type: 'raw'; ids: string[] }
  /** macOS: a sensor-indicator line arrived (the availability probe). */
  | { type: 'line' }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; event: string; data?: Record<string, string | number | boolean> }

const MAC_DEBOUNCE_MS = 2_000
const MAX_LINE = 64 * 1024

// Literal OS data: the Control Center sensor-indicator predicate.
const MAC_PREFIX = 'Active activity attributions changed to '
const MAC_PREDICATE = `subsystem == "com.apple.controlcenter" AND category == "sensor-indicators" AND eventMessage BEGINSWITH "${MAC_PREFIX}"`

const port = process.parentPort
let child: ChildProcessWithoutNullStreams | null = null

function send(e: MicmonEvent): void {
  port.postMessage(e)
}

function fail(event: string, data?: Record<string, string | number | boolean>): never {
  send({ type: 'log', level: 'error', event, ...(data ? { data } : {}) })
  try {
    child?.kill()
  } catch {
    // Already gone.
  }
  process.exit(1)
}

function lines(c: ChildProcessWithoutNullStreams, onLine: (line: string) => void): void {
  const rl = createInterface({ input: c.stdout })
  rl.on('line', (l) => {
    if (l.length <= MAX_LINE) onLine(l)
  })
  c.stderr.on('data', () => undefined)
  c.on('error', (err) => fail('micmon:child-error', { message: err.message }))
  c.on('exit', (code, signal) => fail('micmon:child-exited', { code: code ?? -1, signal: signal ?? '' }))
}

function startWindows(): void {
  const script = micmonWindowsScript({ ownerPid: process.pid })
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  // No `-ExecutionPolicy Bypass`: the policy does not apply to -EncodedCommand, and the
  // pair is a common endpoint-security signature.
  const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true
  })
  child = c
  lines(c, (l) => {
    let msg: { t?: unknown; ids?: unknown; event?: unknown }
    try {
      msg = JSON.parse(l) as { t?: unknown; ids?: unknown; event?: unknown }
    } catch {
      return
    }
    if (msg.t === 'ready') send({ type: 'ready' })
    else if (msg.t === 'log' && msg.event === 'micmon:notify-unavailable') send({ type: 'log', level: 'warn', event: msg.event })
    else if (msg.t === 'apps' && Array.isArray(msg.ids)) {
      send({ type: 'raw', ids: msg.ids.filter((x): x is string => typeof x === 'string').slice(0, 256) })
    }
  })
}

/** The `mic:` bundle ids in one sensor-indicator message, whatever its list syntax. */
function micEntries(message: string): string[] {
  const rest = message.slice(MAC_PREFIX.length)
  try {
    const parsed = JSON.parse(rest) as unknown
    if (Array.isArray(parsed)) {
      return parsed
        .filter((x): x is string => typeof x === 'string' && x.startsWith('mic:'))
        .map((x) => x.slice(4))
    }
  } catch {
    // Not JSON: fall back to scanning for mic:<id> tokens.
  }
  return [...rest.matchAll(/mic:([A-Za-z0-9._-]+)/g)].map((m) => m[1] as string)
}

function startMac(): void {
  const c = spawn('/usr/bin/log', ['stream', '--type', 'log', '--level', 'default', '--style', 'ndjson', '--predicate', MAC_PREDICATE])
  child = c
  let timer: ReturnType<typeof setTimeout> | null = null
  let latest: string[] = []
  send({ type: 'ready' })
  lines(c, (l) => {
    let msg: { eventMessage?: unknown }
    try {
      msg = JSON.parse(l) as { eventMessage?: unknown }
    } catch {
      return
    }
    if (typeof msg.eventMessage !== 'string' || !msg.eventMessage.startsWith(MAC_PREFIX)) return
    send({ type: 'line' })
    latest = [...new Set(micEntries(msg.eventMessage))]
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      send({ type: 'raw', ids: latest })
    }, MAC_DEBOUNCE_MS)
  })
}

port.on('message', (e) => {
  const msg = e.data as MicmonStart
  if (msg?.type === 'stop') {
    child?.removeAllListeners('exit')
    try {
      child?.kill()
    } catch {
      // Already gone.
    }
    process.exit(0)
  }
  if (msg?.type !== 'start' || child) return
  if (msg.platform === 'win32') startWindows()
  else if (msg.platform === 'darwin') startMac()
  else fail('micmon:unsupported-platform', { platform: msg.platform })
})
