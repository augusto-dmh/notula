// SPDX-License-Identifier: Apache-2.0
// The notula-uia utility process entry, built to out/main/uia.js: one Windows
// PowerShell 5.1 UI Automation reader per meeting app for speaker attribution (a script, so
// there is no native addon to build or sign). No network, no audio, no storage.
//
// - Start: `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File
//   <resources>/uia/attribution.ps1 -App <app> -IntervalMs <ms> -SelectorsJson <b64>
//   -SelfName <b64> -OwnerPid <this pid>`, hidden. The script exits by itself when this
//   process is gone (Windows does not end children with their parent).
// - Lines: each stdout line is parsed as JSON and forwarded as `{ app, record }`; a line
//   that is not JSON is logged and skipped.
// - Restarts: on a spawn error or an exit while the reader is wanted, a restart
//   after 1 s; at most 5, the count reset once the last launch is 30 s old; then `failed`.
// - Unavailable: PowerShell missing, blocked by policy, or in Constrained Language
//   Mode (the script prints `{"event":"uia-unavailable",…}` and exits): no restarts.
// - Stop: close stdin, kill 1 s later if still running.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { ATTRIBUTION_LIMITS, type AttributionApp } from '@shared/types/transcript'
import type { MainToUia, UiaReaderArgs, UiaReaderState, UiaToMain } from './protocol'

const port = process.parentPort
const MAX_LINE = 256 * 1024
const STDERR_KEEP = 4_000
const UNAVAILABLE_EXIT = 3

function send(m: UiaToMain): void {
  port.postMessage(m)
}

function log(level: 'debug' | 'info' | 'warn' | 'error', event: string, data?: Record<string, unknown>): void {
  send({ type: 'log', level, event, ...(data ? { data } : {}) })
}

interface Reader {
  app: AttributionApp
  args: UiaReaderArgs
  wanted: boolean
  child: ChildProcessWithoutNullStreams | null
  restarts: number
  lastLaunchAt: number
  restartTimer: NodeJS.Timeout | null
  killTimer: NodeJS.Timeout | null
  unavailable: string | null
  stderr: string
}

const readers = new Map<AttributionApp, Reader>()

function state(r: Reader, s: UiaReaderState, detail: string | null): void {
  send({ type: 'state', app: r.app, state: s, detail, pid: r.child?.pid ?? null })
}

/** PowerShell's own refusal to run the file (execution policy set by Group Policy, AppLocker). */
function blockedByPolicy(stderr: string): boolean {
  return /UnauthorizedAccess|PSSecurityException|execution polic|ExecutionPolicy/i.test(stderr)
}

function launch(r: Reader): void {
  if (!r.wanted || r.child) return
  r.lastLaunchAt = Date.now()
  r.stderr = ''
  r.unavailable = null
  const argv = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    r.args.scriptPath,
    '-App',
    r.app,
    '-IntervalMs',
    String(r.args.intervalMs),
    '-SelectorsJson',
    r.args.selectorsB64 || '-',
    '-SelfName',
    r.args.selfNameB64 || '-',
    '-OwnerPid',
    String(process.pid)
  ]
  let child: ChildProcessWithoutNullStreams
  try {
    child = spawn('powershell.exe', argv, { windowsHide: true })
  } catch (err) {
    onGone(r, null, err instanceof Error ? err.message : String(err))
    return
  }
  r.child = child
  child.once('spawn', () => {
    log('info', 'uia:reader-started', { app: r.app, pid: child.pid ?? 0, restarts: r.restarts })
    state(r, 'running', null)
  })
  const rl = createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    if (!line.trim()) return
    if (line.length > MAX_LINE) {
      log('warn', 'uia:line-too-long', { app: r.app, bytes: line.length })
      return
    }
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      log('warn', 'uia:bad-json', { app: r.app, line: line.slice(0, 120) })
      return
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) return
    const rec = record as Record<string, unknown>
    if (rec['event'] === 'uia-unavailable') {
      r.unavailable = typeof rec['reason'] === 'string' ? rec['reason'] : 'unavailable'
    }
    send({ type: 'record', app: r.app, record: rec })
  })
  child.stderr.on('data', (b: Buffer) => {
    r.stderr = (r.stderr + b.toString('utf8')).slice(-STDERR_KEEP)
  })
  child.stdin.on('error', () => undefined)
  child.on('error', (err) => {
    // ENOENT: no powershell.exe on this machine.
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
    if (missing) r.unavailable = 'powershell-missing'
    onGone(r, child, err.message)
  })
  child.on('exit', (code) => onGone(r, child, `exited (${code ?? -1})`, code))
}

function onGone(r: Reader, child: ChildProcessWithoutNullStreams | null, why: string, code?: number | null): void {
  if (child && r.child !== child) return
  if (r.child === null && child !== null) return
  r.child = null
  if (r.killTimer) clearTimeout(r.killTimer)
  r.killTimer = null
  if (!r.wanted) {
    state(r, 'stopped', null)
    return
  }
  if (!r.unavailable && code !== UNAVAILABLE_EXIT && blockedByPolicy(r.stderr)) r.unavailable = 'blocked-by-policy'
  if (r.unavailable || code === UNAVAILABLE_EXIT) {
    const reason = r.unavailable ?? 'unavailable'
    log('warn', 'uia:reader-unavailable', { app: r.app, reason })
    r.wanted = false
    state(r, 'unavailable', reason)
    return
  }
  // The count resets when the last launch is at least 30 s old.
  if (Date.now() - r.lastLaunchAt >= ATTRIBUTION_LIMITS.restartResetMs) r.restarts = 0
  if (r.restarts >= ATTRIBUTION_LIMITS.maxRestarts) {
    log('warn', 'uia:reader-giving-up', { app: r.app, why, restarts: r.restarts, stderr: r.stderr.slice(-300) })
    r.wanted = false
    state(r, 'failed', why)
    return
  }
  r.restarts++
  log('warn', 'uia:reader-restarting', { app: r.app, why, restart: r.restarts, stderr: r.stderr.slice(-300) })
  state(r, 'restarting', why)
  r.restartTimer = setTimeout(() => {
    r.restartTimer = null
    launch(r)
  }, ATTRIBUTION_LIMITS.restartDelayMs)
}

function stop(r: Reader): void {
  r.wanted = false
  if (r.restartTimer) clearTimeout(r.restartTimer)
  r.restartTimer = null
  const child = r.child
  if (!child) {
    state(r, 'stopped', null)
    return
  }
  // Close stdin (the script exits on end of input), then kill after the grace period.
  try {
    child.stdin.end()
  } catch {
    // Already closed.
  }
  r.killTimer = setTimeout(() => {
    try {
      child.kill()
    } catch {
      // Already gone.
    }
  }, ATTRIBUTION_LIMITS.killGraceMs)
}

port.on('message', (e) => {
  const m = e.data as MainToUia | null
  if (!m || typeof m !== 'object') return
  if (m.type === 'start') {
    let r = readers.get(m.app)
    if (!r) {
      r = {
        app: m.app,
        args: m.args,
        wanted: false,
        child: null,
        restarts: 0,
        lastLaunchAt: 0,
        restartTimer: null,
        killTimer: null,
        unavailable: null,
        stderr: ''
      }
      readers.set(m.app, r)
    }
    r.args = m.args
    if (r.wanted && r.child) return
    r.wanted = true
    r.restarts = 0
    if (!r.restartTimer) launch(r)
    return
  }
  if (m.type === 'stop') {
    const r = readers.get(m.app)
    if (r) stop(r)
  }
})
