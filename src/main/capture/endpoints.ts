// SPDX-License-Identifier: Apache-2.0
// Windows: which capture endpoint each process records from. While Notula captures, main
// runs `resources/audio/endpoints.ps1` (a PowerShell Add-Type helper over the Core Audio API,
// like the other OS helpers: no native addon to build or sign) and gets one JSON line
// per change: the active capture endpoints and the processes with an Active audio session
// on each. Observe only; the helper never opens a stream. Other platforms report nothing,
// so Auto stays the system default there.
//
// Restarts: at most 3 per capture, 2 s apart. A helper that says it is unavailable (exit 3:
// Constrained Language Mode, a compile failure) is not started again in this app run.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { log } from '../log'
import { resourcePath } from '../lifecycle/resources'

export interface EndpointSession {
  pid: number
  /** The process's exe and up to four ancestors', lower-case. */
  exes: string[]
}

export interface CaptureEndpoint {
  id: string
  /** The endpoint's friendly name, which Chromium uses as the audioinput label. */
  name: string
  sessions: EndpointSession[]
}

const POLL_MS = 1_000
const MAX_RESTARTS = 3
const RESTART_DELAY_MS = 2_000
const UNAVAILABLE_EXIT = 3
const MAX_LINE = 256 * 1024
const MAX_ENDPOINTS = 64
const MAX_SESSIONS = 64

function parseList(raw: unknown): CaptureEndpoint[] | null {
  if (!Array.isArray(raw)) return null
  const out: CaptureEndpoint[] = []
  for (const e of raw.slice(0, MAX_ENDPOINTS)) {
    if (!e || typeof e !== 'object') continue
    const { id, name, sessions } = e as Record<string, unknown>
    if (typeof id !== 'string' || typeof name !== 'string' || !Array.isArray(sessions)) continue
    const parsed: EndpointSession[] = []
    for (const s of sessions.slice(0, MAX_SESSIONS)) {
      if (!s || typeof s !== 'object') continue
      const { pid, exes } = s as Record<string, unknown>
      if (typeof pid !== 'number' || !Number.isInteger(pid) || !Array.isArray(exes)) continue
      parsed.push({ pid, exes: exes.filter((x): x is string => typeof x === 'string').slice(0, 5) })
    }
    out.push({ id: id.slice(0, 200), name: name.slice(0, 200), sessions: parsed })
  }
  return out
}

export class EndpointMonitor {
  private child: ChildProcessWithoutNullStreams | null = null
  private wanted = false
  private restarts = 0
  private unavailable = false
  private restartTimer: ReturnType<typeof setTimeout> | null = null

  /** `null` = nothing known (not running, or the helper is gone). */
  constructor(private readonly onReport: (list: CaptureEndpoint[] | null) => void) {}

  start(): void {
    if (process.platform !== 'win32' || this.unavailable) return
    this.wanted = true
    this.restarts = 0
    this.launch()
  }

  stop(): void {
    this.wanted = false
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    const child = this.child
    this.child = null
    if (!child) return
    // Observe only and stateless: nothing to flush, so it ends at once.
    try {
      child.kill()
    } catch {
      // Already gone.
    }
  }

  private launch(): void {
    if (!this.wanted || this.child) return
    const argv = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      resourcePath('audio/endpoints.ps1'),
      '-IntervalMs',
      String(POLL_MS),
      '-OwnerPid',
      String(process.pid)
    ]
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn('powershell.exe', argv, { windowsHide: true })
    } catch (err) {
      log('warn', 'input:endpoints-spawn-failed', { err })
      return
    }
    this.child = child
    let reason: string | null = null
    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      if (this.child !== child || line.length > MAX_LINE) return
      let msg: { t?: unknown; list?: unknown; reason?: unknown }
      try {
        msg = JSON.parse(line) as typeof msg
      } catch {
        return
      }
      if (msg.t === 'ready') log('info', 'input:endpoints-started', { pid: child.pid ?? 0, restarts: this.restarts })
      else if (msg.t === 'unavailable') reason = typeof msg.reason === 'string' ? msg.reason.slice(0, 200) : 'unavailable'
      else if (msg.t === 'endpoints') {
        const list = parseList(msg.list)
        if (list) this.onReport(list)
      }
    })
    child.stderr.on('data', () => undefined)
    child.stdin.on('error', () => undefined)
    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') reason = 'powershell-missing'
      this.gone(child, err.message, reason)
    })
    child.on('exit', (code) => this.gone(child, `exited (${code ?? -1})`, code === UNAVAILABLE_EXIT ? (reason ?? 'unavailable') : reason))
  }

  private gone(child: ChildProcessWithoutNullStreams, why: string, unavailable: string | null): void {
    if (this.child !== child) return
    this.child = null
    this.onReport(null)
    if (!this.wanted) return
    if (unavailable) {
      log('warn', 'input:endpoints-unavailable', { reason: unavailable })
      this.unavailable = true
      return
    }
    if (this.restarts >= MAX_RESTARTS) {
      log('warn', 'input:endpoints-giving-up', { why, restarts: this.restarts })
      return
    }
    this.restarts++
    log('warn', 'input:endpoints-restarting', { why, restart: this.restarts })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.launch()
    }, RESTART_DELAY_MS)
  }
}
