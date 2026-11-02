// SPDX-License-Identifier: Apache-2.0
// The notula-media utility process entry, built to out/main/media.js: the passive provider's
// Windows PowerShell 5.1 media-session reader (a script with a C# shim compiled at start, so
// there is no native addon to build or sign). No network, no audio, no storage.
//
// - Start: `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File
//   <resources>/media/session.ps1 -Apps <ids> -OwnerPid <this pid>`, hidden. The script exits by
//   itself when this process is gone (Windows does not end children with their parent).
// - Lines: each stdout line is parsed as JSON and forwarded as a `record`; a line that is not
//   JSON is counted and skipped (never logged: it could carry a title).
// - Commands: `locate`, `apps`, `window-title`, `seek` and `lesson-read` are written to the
//   script's stdin as one tab-separated line each. A window read's nodes are parsed here
//   (`lesson-read.ts`), read again once if the first answer was sparse, and only the lesson fields
//   go on to main, within the 3 s budget.
// - Restarts: on a spawn error or an exit while the reader is wanted, a restart after 1 s,
//   doubling, at most 5; the count resets once the last launch is 30 s old; then `failed`.
// - Unavailable: PowerShell missing, blocked by policy, or the script's own `unavailable` (exit
//   3: Constrained Language Mode, no WinRT metadata, compile failure): no restarts.
// - Stop: close stdin, kill 1 s later if still running.
// - Logs carry states, counts and exit codes only; never stderr text, titles or URLs.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { SOURCES_LIMITS, type LessonRead, type LessonReadSite } from '@shared/types/sources'
import { nodesFromRecord, parseLessonRead } from './lesson-read'
import { MEDIA_READER_LIMITS, restartDelay, type MainToMedia, type MediaReaderArgs, type MediaReaderState, type MediaToMain } from './protocol'

/** By full path: a bare name is searched in the current directory before PATH. */
const POWERSHELL = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

const port = process.parentPort
const MAX_LINE = 256 * 1024
const STDERR_KEEP = 4_000
const UNAVAILABLE_EXIT = 3

function send(m: MediaToMain): void {
  port.postMessage(m)
}

function log(level: 'debug' | 'info' | 'warn' | 'error', event: string, data?: Record<string, unknown>): void {
  send({ type: 'log', level, event, ...(data ? { data } : {}) })
}

const r = {
  args: null as MediaReaderArgs | null,
  wanted: false,
  child: null as ChildProcessWithoutNullStreams | null,
  restarts: 0,
  lastLaunchAt: 0,
  restartTimer: null as NodeJS.Timeout | null,
  killTimer: null as NodeJS.Timeout | null,
  unavailable: null as string | null,
  stderr: '',
  badLines: 0,
  /** The running child was asked to stop; its exit isn't a crash. */
  stopping: false
}

function state(s: MediaReaderState, detail: string | null): void {
  send({ type: 'state', state: s, detail, pid: r.child?.pid ?? null })
}

/** PowerShell's own refusal to run the file (execution policy set by Group Policy, AppLocker). */
function blockedByPolicy(stderr: string): boolean {
  return /UnauthorizedAccess|PSSecurityException|execution polic|ExecutionPolicy/i.test(stderr)
}

function launch(): void {
  const args = r.args
  if (!r.wanted || r.child || !args) return
  r.lastLaunchAt = Date.now()
  r.stderr = ''
  r.unavailable = null
  r.badLines = 0
  const argv = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    args.scriptPath,
    '-Apps',
    args.apps.join(','),
    '-OwnerPid',
    String(process.pid)
  ]
  let child: ChildProcessWithoutNullStreams
  try {
    child = spawn(POWERSHELL, argv, { windowsHide: true })
  } catch (err) {
    onGone(null, err instanceof Error ? err.message : String(err))
    return
  }
  r.child = child
  state('starting', null)
  child.once('spawn', () => log('info', 'media:reader-started', { pid: child.pid ?? 0, restarts: r.restarts }))
  const rl = createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    if (!line.trim()) return
    if (line.length > MAX_LINE) {
      log('warn', 'media:line-too-long', { bytes: line.length })
      return
    }
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      r.badLines++
      if (r.badLines === 1 || r.badLines % 100 === 0) log('warn', 'media:bad-json', { count: r.badLines })
      return
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) return
    const rec = record as Record<string, unknown>
    if (rec['ev'] === 'unavailable') r.unavailable = typeof rec['reason'] === 'string' ? rec['reason'].slice(0, 60) : 'unavailable'
    if (rec['ev'] === 'ready') {
      log('info', 'media:reader-ready', { msCompile: rec['msCompile'], ms: rec['ms'] })
      state('running', null)
    }
    // A window read's raw nodes stay in this process.
    if (rec['ev'] === 'lesson-read') return onLessonNodes(rec)
    send({ type: 'record', record: rec })
  })
  child.stderr.on('data', (b: Buffer) => {
    r.stderr = (r.stderr + b.toString('utf8')).slice(-STDERR_KEEP)
  })
  child.stdin.on('error', () => undefined)
  child.on('error', (err) => {
    // ENOENT: no powershell.exe on this machine.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') r.unavailable = 'powershell-missing'
    onGone(child, 'spawn-error')
  })
  child.on('exit', (code) => onGone(child, `exited (${code ?? -1})`, code))
}

function onGone(child: ChildProcessWithoutNullStreams | null, why: string, code?: number | null): void {
  if (child && r.child !== child) return
  if (r.child === null && child !== null) return
  r.child = null
  for (const id of [...lessonReads.keys()]) finishLessonRead(id, null, 'no-reader')
  if (r.killTimer) clearTimeout(r.killTimer)
  r.killTimer = null
  const stopped = r.stopping
  r.stopping = false
  if (!r.wanted) {
    state('stopped', null)
    return
  }
  if (stopped) {
    // Started again while the previous reader was still stopping.
    launch()
    return
  }
  if (!r.unavailable && code !== UNAVAILABLE_EXIT && blockedByPolicy(r.stderr)) r.unavailable = 'blocked-by-policy'
  if (r.unavailable || code === UNAVAILABLE_EXIT) {
    const reason = r.unavailable ?? 'unavailable'
    log('warn', 'media:reader-unavailable', { reason })
    r.wanted = false
    state('unavailable', reason)
    return
  }
  if (Date.now() - r.lastLaunchAt >= MEDIA_READER_LIMITS.restartResetMs) r.restarts = 0
  if (r.restarts >= MEDIA_READER_LIMITS.maxRestarts) {
    log('warn', 'media:reader-giving-up', { why, restarts: r.restarts, stderrBytes: r.stderr.length })
    r.wanted = false
    state('failed', why)
    return
  }
  r.restarts++
  const delay = restartDelay(r.restarts)
  log('warn', 'media:reader-restarting', { why, restart: r.restarts, delayMs: delay, stderrBytes: r.stderr.length })
  state('restarting', why)
  r.restartTimer = setTimeout(() => {
    r.restartTimer = null
    launch()
  }, delay)
}

function stop(): void {
  r.wanted = false
  if (r.restartTimer) clearTimeout(r.restartTimer)
  r.restartTimer = null
  const child = r.child
  if (!child) {
    state('stopped', null)
    return
  }
  // Close stdin (the script exits on end of input), then kill after the grace period.
  r.stopping = true
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
  }, MEDIA_READER_LIMITS.killGraceMs)
}

/** One command line to the reader; false when it can't be written. */
function write(line: string): boolean {
  const child = r.child
  if (!child || !child.stdin.writable) return false
  try {
    child.stdin.write(`${line}\n`)
    return true
  } catch {
    return false
  }
}

const HWND = /^\d{1,20}$/
/** App ids as the reader prints them: no tabs, line breaks or other control characters. */
const APP_ID = /^[^\u0000-\u001f\u007f]{1,200}$/

function command(m: Extract<MainToMedia, { type: 'apps' | 'window-title' | 'seek' }>): void {
  let line: string | null = null
  let fail: Record<string, unknown> = {}
  if (m.type === 'apps') {
    line = `apps\t${m.id}`
    fail = { ev: 'apps', id: m.id, shortcuts: [], folders: [], error: true }
  } else if (m.type === 'window-title') {
    if (HWND.test(m.hwnd)) line = `window-title\t${m.id}\t${m.hwnd}`
    fail = { ev: 'window-title', id: m.id, title: null }
  } else {
    if (APP_ID.test(m.app) && Number.isFinite(m.ms) && m.ms >= 0) line = `seek\t${m.id}\t${m.app}\t${Math.round(m.ms)}`
    fail = { ev: 'seek', id: m.id, result: 'gone' }
  }
  if (!line || !write(line)) send({ type: 'record', record: fail })
}

// ---------- the window read ----------
// The reader returns the page's nodes; they are parsed here and only the lesson fields go on to
// main. Nothing of a read is logged: counts, timings and the outcome only.

interface LessonReadJob {
  hwnd: string
  site: LessonReadSite
  startedAt: number
  reads: number
  timer: NodeJS.Timeout | null
  budget: NodeJS.Timeout
}

const lessonReads = new Map<number, LessonReadJob>()

function finishLessonRead(id: number, read: LessonRead | null, reason: string | null): void {
  const job = lessonReads.get(id)
  if (!job) return
  lessonReads.delete(id)
  clearTimeout(job.budget)
  if (job.timer) clearTimeout(job.timer)
  send({ type: 'record', record: { ev: 'lesson-read', id, read, reason, reads: job.reads, ms: Date.now() - job.startedAt } })
}

function sendLessonRead(id: number): void {
  const job = lessonReads.get(id)
  if (!job) return
  job.timer = null
  const left = SOURCES_LIMITS.windowReadBudgetMs - (Date.now() - job.startedAt)
  if (left < 100) return finishLessonRead(id, null, 'over-budget')
  job.reads++
  if (!write(`lesson-read\t${id}\t${job.hwnd}\t${left}`)) finishLessonRead(id, null, 'no-reader')
}

function startLessonRead(m: Extract<MainToMedia, { type: 'lesson-read' }>): void {
  if (!HWND.test(m.hwnd) || lessonReads.has(m.id)) {
    send({ type: 'record', record: { ev: 'lesson-read', id: m.id, read: null, reason: 'invalid', reads: 0, ms: 0 } })
    return
  }
  const budget = setTimeout(() => finishLessonRead(m.id, null, 'over-budget'), SOURCES_LIMITS.windowReadBudgetMs)
  lessonReads.set(m.id, { hwnd: m.hwnd, site: m.site, startedAt: Date.now(), reads: 0, timer: null, budget })
  sendLessonRead(m.id)
}

/** The reader's answer: parse it, read again once if the page was still sparse, or finish. */
function onLessonNodes(rec: Record<string, unknown>): void {
  const id = typeof rec['id'] === 'number' ? rec['id'] : -1
  const job = lessonReads.get(id)
  if (!job) return
  const nodes = nodesFromRecord(rec['nodes'])
  const read = nodes ? parseLessonRead(job.site, nodes) : null
  if (read) return finishLessonRead(id, read, null)
  const reason = typeof rec['reason'] === 'string' ? rec['reason'].slice(0, 30) : 'sparse'
  // Chromium builds a page's tree once a client asks: the first read can come back sparse.
  const retryAt = job.startedAt + MEDIA_READER_LIMITS.lessonReadRetryMs
  if (job.reads === 1 && reason !== 'not-browser' && reason !== 'busy' && retryAt < job.startedAt + SOURCES_LIMITS.windowReadBudgetMs - 100) {
    job.timer = setTimeout(() => sendLessonRead(id), Math.max(0, retryAt - Date.now()))
    return
  }
  finishLessonRead(id, null, nodes ? 'sparse' : reason)
}

function locate(m: Extract<MainToMedia, { type: 'locate' }>): void {
  const child = r.child
  const reply = (): void => send({ type: 'record', record: { ev: 'locate', id: m.id, matches: [], windows: 0, ms: 0, error: true } })
  if (!child || !child.stdin.writable) {
    reply()
    return
  }
  const title = Buffer.from(m.title.slice(0, 2_000), 'utf8').toString('base64')
  try {
    child.stdin.write(`locate\t${m.id}\t${m.process}\t${title}\t${m.address ? '1' : '0'}\n`)
  } catch {
    reply()
  }
}

port.on('message', (e) => {
  const m = e.data as MainToMedia | null
  if (!m || typeof m !== 'object') return
  if (m.type === 'start') {
    r.args = m.args
    if (r.wanted && (r.child || r.restartTimer)) return
    r.wanted = true
    r.restarts = 0
    launch()
    return
  }
  if (m.type === 'stop') stop()
  else if (m.type === 'locate') locate(m)
  else if (m.type === 'lesson-read') startLessonRead(m)
  else if (m.type === 'apps' || m.type === 'window-title' || m.type === 'seek') command(m)
})
