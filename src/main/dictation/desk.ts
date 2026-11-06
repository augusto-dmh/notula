// SPDX-License-Identifier: Apache-2.0
// Main's side of the notula-desk helper (out/main/desk.js), and `ask(op)` with a timeout. A
// failed or missing helper degrades each caller (no context, the clipboard instead of a paste);
// it never throws.
// - Lifetime: the utility process is forked only while the key hook runs, a request is in flight
//   or the ops script runs (Windows: desk.ps1, started by the first request that needs it). The
//   script stops 10 minutes after its last request, never while one is in flight, a duck is
//   held or it hosts the full-screen watcher (../desk/idle.ts). A request's timeout starts once
//   the script is ready, so a cold start costs time, never the request.
// - Windows adds `duck` / `unduck` (other apps' audio sessions on every output device, for
//   "Lower other audio while dictating").
// - It also hosts the dictation bar's key hook: `startHook` / `sendHook` / `stopHook`, with its
//   events and its exit on `onHook`.
// - `watchFullscreen`: the dictation bar's full-screen source, a watcher in the key hook's
//   process while it is ready, else in the ops script (../desk/fullscreen.ts).
// - The paste watcher reads with `field` (Windows): a light read near the caret.

import { join } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import { foldFullscreen, fullscreenHost, parseFullscreen, type FullscreenHost, type FullscreenState } from '../desk/fullscreen'
import { idleDelay, OPS_STOPPED, opsStopped, requestEnded, requestStarted, shouldStopOps, type OpsState } from '../desk/idle'
import { resourcePath } from '../lifecycle/resources'
import { log } from '../log'

export interface DeskForeground {
  process: string
  title: string
  /** macOS only: the app's bundle id. */
  bundle: string | null
}

export interface DeskContext extends DeskForeground {
  result: 'captured' | 'empty' | 'secure_input' | 'unsupported' | 'error' | 'timeout'
  /** `multiline`: the Win32 edit style when the field has its own edit window, else null. */
  field: { name: string; type: string; password: boolean; editable: boolean; multiline: boolean | null } | null
  before: string
  after: string
  selection: string
}

/** The paste watcher's read: the foreground window and the text near the caret, or why not. */
export interface DeskField {
  result: 'read' | 'no-focus' | 'secure' | 'no-text' | 'wide-selection'
  pid: number
  /** The foreground window's handle. */
  window: string
  before: string
  selection: string
  after: string
  /** The helper's window cut the text before or after the caret. */
  cutBefore: boolean
  cutAfter: boolean
}

/** One app session the helper lowered: `key` is a hash, never the app; levels are 0–1. */
export interface DuckEntry {
  key: string
  saved: number
  set: number
}

export interface DuckResult {
  entries: DuckEntry[]
  devices: number
  /** Process names, for the debug log only. */
  processes: string[]
}

/** About 40 % of each app's level (still audible, out of the way), faded down over 150 ms and back up over 250 ms. */
const DUCK = { factor: 0.4, downMs: 150, upMs: 250 }

export function isDuckEntry(v: unknown): v is DuckEntry {
  const e = v as Partial<DuckEntry> | null
  return !!e && typeof e.key === 'string' && typeof e.saved === 'number' && typeof e.set === 'number'
}

type Reply = Record<string, unknown> & { ok: boolean; error?: string }

type DeskOp = 'foreground' | 'context' | 'field' | 'modifiers' | 'paste' | 'dblclick' | 'duck' | 'unduck' | 'unmute' | 'watch-foreground'

/** The longest wait for the ops script's ready line; a request's own timeout starts after it. */
const OPS_START_MS = 10_000
/** A watcher in the ops script that failed is tried again this much later, times the attempt. */
const WATCH_RETRY_MS = 5_000
const WATCH_RETRIES = 3

export class Desk {
  private proc: UtilityProcess | null = null
  private ready: Promise<boolean> | null = null
  private nextId = 1
  private readonly pending = new Map<number, (r: Reply | null) => void>()
  private hookOn = false
  /** The hook process said `ready`: it can host the full-screen watcher. */
  private hookReady = false
  private hookListener: ((m: Record<string, unknown>) => void) | null = null
  private ops: OpsState = OPS_STOPPED
  /** Windows: the ops script printed its ready line. */
  private opsUp = false
  private opsWaiters: Array<(ok: boolean) => void> = []
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private fsListener: ((at: { x: number; y: number } | null) => void) | null = null
  private fsHost: FullscreenHost = 'none'
  private fsState: FullscreenState | null = null
  private fsRetries = 0
  private fsRetryTimer: ReturnType<typeof setTimeout> | null = null
  private routing = false

  get supported(): boolean {
    return process.platform === 'win32' || process.platform === 'darwin'
  }

  /** Forks the utility process (once while it lives); false when it does not answer. */
  private utility(): Promise<boolean> {
    if (!this.supported) return Promise.resolve(false)
    if (this.ready) return this.ready
    const child = utilityProcess.fork(join(__dirname, 'desk.js'), [], { serviceName: 'notula-desk' })
    this.proc = child
    this.ready = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000)
      child.on('message', (m: Record<string, unknown>) => {
        if (m['type'] === 'ready') {
          clearTimeout(timer)
          resolve(true)
        } else this.onMessage(child, m)
      })
      child.on('exit', () => {
        clearTimeout(timer)
        resolve(false)
        this.reset(child)
      })
    })
    child.postMessage({ type: 'start', scriptPath: resourcePath('desk/desk.ps1') })
    return this.ready
  }

  private onMessage(child: UtilityProcess, m: Record<string, unknown>): void {
    if (m['type'] === 'log') {
      log((m['level'] as 'debug' | 'warn') ?? 'debug', String(m['event']), m['data'] as Record<string, unknown> | undefined)
      return
    }
    // A stopped utility's late lines.
    if (this.proc !== child) return
    switch (m['type']) {
      case 'reply':
        this.pending.get(Number(m['id']))?.(m as Reply)
        return
      case 'ops-ready':
        this.opsUp = true
        this.flushOps(true)
        return
      case 'ops-exit':
        this.onOpsExit()
        return
      case 'fullscreen':
        this.onFullscreen(m)
        return
      case 'hook':
        if (m['event'] === 'ready' && this.hookOn) {
          this.hookReady = true
          this.routeSoon()
        }
        this.hookListener?.(m)
        return
      case 'hook-exit':
        this.hookOn = false
        this.hookReady = false
        this.hookListener?.(m)
        this.routeSoon()
        this.release()
        return
    }
  }

  private flushOps(ok: boolean): void {
    const waiting = this.opsWaiters
    this.opsWaiters = []
    for (const w of waiting) w(ok)
  }

  /** The ops script exited on its own (a crash, or it failed to start). */
  private onOpsExit(): void {
    this.opsUp = false
    this.ops = opsStopped(this.ops)
    this.flushOps(false)
    // Requests it had taken get no reply now.
    for (const cb of [...this.pending.values()]) cb(null)
    if (this.fsHost === 'desk') this.fullscreenLost()
    this.settle()
  }

  private reset(child: UtilityProcess): void {
    if (this.proc !== child) return
    this.proc = null
    this.ready = null
    if (this.hookOn) {
      this.hookOn = false
      this.hookListener?.({ type: 'hook-exit', code: null })
    }
    this.hookReady = false
    this.opsUp = false
    this.ops = opsStopped(this.ops)
    this.clearIdle()
    this.flushOps(false)
    for (const cb of [...this.pending.values()]) cb(null)
    if (this.fsHost === 'desk') this.fullscreenLost()
    else if (this.fsHost === 'hook') this.routeSoon()
  }

  stop(): void {
    const child = this.proc
    if (!child) return
    child.postMessage({ type: 'stop' })
    setTimeout(() => child.kill(), 2_000).unref()
    this.reset(child)
  }

  /** The utility follows its users: the key hook, a request in flight, the ops script, the watcher. */
  private release(): void {
    if (!this.proc || this.hookOn || this.ops.inFlight > 0 || this.ops.running || this.fsHost !== 'none') return
    this.stop()
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  /** After any change in use: the idle stop's timer, and the utility's own stop. */
  private settle(): void {
    this.clearIdle()
    const wait = idleDelay(this.ops, Date.now())
    if (wait !== null) {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null
        this.idleCheck()
      }, wait)
    }
    this.release()
  }

  private idleCheck(): void {
    const now = Date.now()
    if (!shouldStopOps(this.ops, now)) return this.settle()
    const idleMs = now - this.ops.lastRequestAt
    this.ops = opsStopped(this.ops)
    this.opsUp = false
    log('info', 'desk:ops-stopped', { idleMs })
    // The script's own exit path raises anything still lowered.
    this.proc?.postMessage({ type: 'ops-stop' })
    this.release()
  }

  onHook(cb: ((m: Record<string, unknown>) => void) | null): void {
    this.hookListener = cb
  }

  /** Spawns the key hook (one at most); false when the desk helper is not running. */
  async startHook(): Promise<boolean> {
    if (this.hookOn) return true
    this.hookOn = true
    this.hookReady = false
    if (!(await this.utility().catch(() => false)) || !this.proc || !this.hookOn) {
      this.hookOn = false
      this.routeSoon()
      this.release()
      return false
    }
    this.proc.postMessage({ type: 'hook-start', scriptPath: resourcePath(process.platform === 'darwin' ? 'desk/keyhook-mac.js' : 'desk/keyhook.ps1') })
    return true
  }

  sendHook(msg: Record<string, unknown>): void {
    if (this.hookOn) this.proc?.postMessage({ type: 'hook-send', msg })
  }

  stopHook(): void {
    if (!this.hookOn) return
    this.hookOn = false
    this.hookReady = false
    this.proc?.postMessage({ type: 'hook-stop' })
    this.routeSoon()
    this.release()
  }

  // ---------- the dictation bar's full-screen source ----------

  /**
   * Tracks whether the foreground window fills its monitor: `cb` gets that monitor's top-left in
   * physical pixels, or null (not full screen, or the watcher stopped); only changes are reported.
   * null stops tracking. Windows only.
   */
  watchFullscreen(cb: ((at: { x: number; y: number } | null) => void) | null): void {
    this.fsListener = cb
    if (!cb) {
      if (this.fsRetryTimer) clearTimeout(this.fsRetryTimer)
      this.fsRetryTimer = null
      this.fsRetries = 0
    }
    this.routeSoon()
  }

  /**
   * Routes once the current turn is done, so changes made together settle on their end state:
   * disarming stops the hook and the tracking in one go, and must not start the ops script to
   * host the watcher in between.
   */
  private routeSoon(): void {
    if (this.routing) return
    this.routing = true
    queueMicrotask(() => {
      this.routing = false
      this.routeFullscreen()
    })
  }

  /** Moves the watcher to the host it should have now: the hook once it is ready, else the ops script. */
  private routeFullscreen(): void {
    if (this.fsRetryTimer) return
    const prev = this.fsHost
    const hook = !this.hookOn ? 'down' : this.hookReady ? 'ready' : 'starting'
    const next = fullscreenHost({ platform: process.platform, tracking: !!this.fsListener, hook, current: prev })
    if (next === prev) return this.release()
    this.fsHost = next
    if (prev === 'hook') this.sendHook({ op: 'watch-foreground', on: false })
    if (prev === 'desk') {
      this.ops = { ...this.ops, watching: false }
      // Telling a stopped script to stop would start it.
      if (this.ops.running) void this.ask('watch-foreground', 1_500, { on: false })
      else this.settle()
    }
    log('debug', 'desk:fullscreen-host', { host: next })
    // The hook taking over keeps the state until its first line; anything else starts from "not full".
    if (!(prev === 'desk' && next === 'hook')) this.setFullscreen(null)
    if (next === 'hook') this.sendHook({ op: 'watch-foreground', on: true })
    else if (next === 'desk') {
      this.ops = { ...this.ops, watching: true }
      void this.ask('watch-foreground', 1_500, { on: true }).then((r) => {
        if (!r && this.fsHost === 'desk') this.fullscreenLost()
      })
    }
    this.release()
  }

  /** The ops script hosting the watcher failed: try again a few times, then go without it. */
  private fullscreenLost(): void {
    this.fsHost = 'none'
    this.ops = { ...this.ops, watching: false }
    this.setFullscreen(null)
    if (!this.fsListener) return
    if (this.fsRetries >= WATCH_RETRIES) {
      log('warn', 'desk:fullscreen-unavailable', { attempts: this.fsRetries })
      return
    }
    this.fsRetries++
    this.fsRetryTimer = setTimeout(() => {
      this.fsRetryTimer = null
      this.routeFullscreen()
    }, WATCH_RETRY_MS * this.fsRetries)
  }

  private onFullscreen(m: Record<string, unknown>): void {
    const from: FullscreenHost = m['from'] === 'hook' ? 'hook' : 'desk'
    if (from !== this.fsHost) return
    const s = parseFullscreen(m)
    if (!s) return
    this.fsRetries = 0
    this.setFullscreen(s)
  }

  private setFullscreen(s: FullscreenState | null): void {
    const { state, notify } = foldFullscreen(this.fsState, s)
    this.fsState = state
    if (notify) this.fsListener?.(state?.full ? { x: state.x, y: state.y } : null)
  }

  // ---------- requests ----------

  /** The raw reply (ok or not), or null when none came. */
  private async call(op: DeskOp, timeoutMs: number, args?: Record<string, unknown>): Promise<Reply | null> {
    if (!this.supported) return null
    this.ops = requestStarted(this.ops, Date.now()).state
    this.clearIdle()
    if (!(await this.utility().catch(() => false)) || !this.proc) {
      this.ops = requestEnded(this.ops, Date.now())
      this.settle()
      return null
    }
    const proc = this.proc
    const id = this.nextId++
    return new Promise<Reply | null>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (r: Reply | null): void => {
        if (!this.pending.delete(id)) return
        if (timer) clearTimeout(timer)
        // The script holds what a duck lowered until an unduck (or its exit) raises it.
        const duck = !r?.ok ? undefined : op === 'duck' ? Array.isArray(r['entries']) && r['entries'].length > 0 : op === 'unduck' ? false : undefined
        this.ops = requestEnded(this.ops, Date.now(), duck)
        this.settle()
        resolve(r)
      }
      this.pending.set(id, finish)
      const arm = (): void => {
        timer = setTimeout(() => finish(null), timeoutMs)
      }
      // The timeout runs from the ops script's ready line, so a cold start never eats a request's time.
      if (process.platform !== 'win32' || this.opsUp) arm()
      else {
        timer = setTimeout(() => finish(null), OPS_START_MS)
        this.opsWaiters.push((ok) => {
          if (!this.pending.has(id)) return
          if (timer) clearTimeout(timer)
          if (ok) arm()
          else finish(null)
        })
      }
      proc.postMessage({ type: 'req', id, op, args })
    })
  }

  /** null on any failure or timeout. */
  async ask(op: Exclude<DeskOp, 'field'>, timeoutMs: number, args?: Record<string, unknown>): Promise<Reply | null> {
    const r = await this.call(op, timeoutMs, args)
    return r && r.ok ? r : null
  }

  /** Like `ask`, but says whether the helper failed or never replied, for the watcher's logs. */
  private async request(op: 'field', timeoutMs: number): Promise<Reply | 'no-reply' | 'error'> {
    const r = await this.call(op, timeoutMs)
    return !r ? 'no-reply' : r.ok ? r : 'error'
  }

  async foreground(timeoutMs = 1_000): Promise<DeskForeground | null> {
    const r = await this.ask('foreground', timeoutMs)
    return r ? { process: String(r['process'] ?? ''), title: String(r['title'] ?? ''), bundle: typeof r['bundle'] === 'string' && r['bundle'] ? r['bundle'] : null } : null
  }

  async context(timeoutMs: number): Promise<DeskContext> {
    const r = await this.ask('context', timeoutMs)
    if (!r) return { result: 'timeout', process: '', title: '', bundle: null, field: null, before: '', after: '', selection: '' }
    const f = r['field'] as Record<string, unknown> | null
    return {
      result: (r['result'] as DeskContext['result']) ?? 'error',
      process: String(r['process'] ?? ''),
      title: String(r['title'] ?? ''),
      bundle: typeof r['bundle'] === 'string' && r['bundle'] ? r['bundle'] : null,
      field: f
        ? {
            name: String(f['name'] ?? ''),
            type: String(f['type'] ?? ''),
            password: f['password'] === true,
            editable: f['editable'] === true,
            multiline: typeof f['multiline'] === 'boolean' ? f['multiline'] : null
          }
        : null,
      before: String(r['before'] ?? ''),
      after: String(r['after'] ?? ''),
      selection: String(r['selection'] ?? '')
    }
  }

  /** Windows only. */
  async field(timeoutMs: number): Promise<DeskField | 'no-reply' | 'error'> {
    const r = await this.request('field', timeoutMs)
    if (typeof r === 'string') return r
    return {
      result: (r['result'] as DeskField['result']) ?? 'no-text',
      pid: Number(r['pid'] ?? 0),
      window: String(r['window'] ?? ''),
      before: String(r['before'] ?? ''),
      selection: String(r['selection'] ?? ''),
      after: String(r['after'] ?? ''),
      cutBefore: r['cutBefore'] === true,
      cutAfter: r['cutAfter'] === true
    }
  }

  /** true / false, or null when the platform can't tell. */
  async modifiersHeld(): Promise<boolean | null> {
    const r = await this.ask('modifiers', 500)
    return r && typeof r['held'] === 'boolean' ? r['held'] : null
  }

  /** Lowers every other app's audio on every output device (Notula's own processes are skipped); null on failure. */
  async duck(): Promise<DuckResult | null> {
    if (process.platform !== 'win32') return null
    const r = await this.ask('duck', 2_000, { root: process.pid, factor: DUCK.factor, ms: DUCK.downMs })
    if (!r || !Array.isArray(r['entries'])) return null
    const raw = r['entries'] as Array<Record<string, unknown>>
    const entries = (raw as unknown[]).filter(isDuckEntry).map((e) => ({ key: e.key, saved: e.saved, set: e.set }))
    return {
      entries,
      devices: new Set(raw.map((e) => e['device'])).size,
      processes: [...new Set(raw.map((e) => String(e['process'] ?? '')).filter(Boolean))]
    }
  }

  /** Raises what the helper lowered, plus `entries` it no longer holds (a crash marker); null on failure. */
  async unduck(entries: DuckEntry[]): Promise<{ sessions: number; devices: number } | null> {
    if (process.platform !== 'win32') return null
    const r = await this.ask('unduck', 2_000, { entries, ms: DUCK.upMs })
    return r ? { sessions: Number(r['sessions'] ?? 0), devices: Number(r['devices'] ?? 0) } : null
  }

  /** Unmutes the default output: only for a marker an older build left after muting it. */
  async unmuteOutput(): Promise<boolean> {
    if (process.platform !== 'win32') return false
    return (await this.ask('unmute', 1_500)) !== null
  }

  async paste(): Promise<boolean> {
    const r = await this.ask('paste', 3_000)
    return r?.['sent'] === true
  }
}
