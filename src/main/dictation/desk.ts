// SPDX-License-Identifier: Apache-2.0
// Main's side of the notula-desk helper: forks out/main/desk.js while dictation is
// armed, keeps it warm, and answers `ask(op)` with a timeout. A failed or missing helper
// degrades each caller (no context, the clipboard instead of a paste); it never throws.
// Windows adds `dblclick` (the OS double-click interval) and `duck` / `unduck` (other apps'
// audio sessions on every output device, for "Lower other audio while dictating").
// It also hosts the dictation bar's key hook: `startHook` /
// `sendHook` / `stopHook`, with its events and its exit on `onHook`.
// The paste watcher reads with `field` (Windows): a light read near the caret.

import { join } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
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

/** About 20 % of each app's level, faded down over 150 ms and back up over 250 ms. */
const DUCK = { factor: 0.2, downMs: 150, upMs: 250 }

export function isDuckEntry(v: unknown): v is DuckEntry {
  const e = v as Partial<DuckEntry> | null
  return !!e && typeof e.key === 'string' && typeof e.saved === 'number' && typeof e.set === 'number'
}

type Reply = Record<string, unknown> & { ok: boolean; error?: string }

export class Desk {
  private proc: UtilityProcess | null = null
  private ready: Promise<boolean> | null = null
  private nextId = 1
  private readonly pending = new Map<number, (r: Reply | null) => void>()
  private hookOn = false
  private hookListener: ((m: Record<string, unknown>) => void) | null = null

  get supported(): boolean {
    return process.platform === 'win32' || process.platform === 'darwin'
  }

  start(): Promise<boolean> {
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
        } else if (m['type'] === 'reply') {
          const cb = this.pending.get(Number(m['id']))
          if (cb) {
            this.pending.delete(Number(m['id']))
            cb(m as Reply)
          }
        } else if (m['type'] === 'hook' || m['type'] === 'hook-exit') {
          if (m['type'] === 'hook-exit') this.hookOn = false
          this.hookListener?.(m)
        } else if (m['type'] === 'log') {
          log((m['level'] as 'debug' | 'warn') ?? 'debug', String(m['event']), m['data'] as Record<string, unknown> | undefined)
        } else if (m['type'] === 'exit') {
          clearTimeout(timer)
          resolve(false)
          this.reset(child)
        }
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

  private reset(child: UtilityProcess): void {
    if (this.proc !== child) return
    this.proc = null
    this.ready = null
    if (this.hookOn) {
      this.hookOn = false
      this.hookListener?.({ type: 'hook-exit', code: null })
    }
    for (const cb of this.pending.values()) cb(null)
    this.pending.clear()
  }

  stop(): void {
    const child = this.proc
    if (!child) return
    child.postMessage({ type: 'stop' })
    setTimeout(() => child.kill(), 2_000).unref()
    this.reset(child)
  }

  onHook(cb: ((m: Record<string, unknown>) => void) | null): void {
    this.hookListener = cb
  }

  /** Spawns the key hook (one at most); false when the desk helper is not running. */
  async startHook(): Promise<boolean> {
    if (!(await this.start().catch(() => false)) || !this.proc) return false
    if (this.hookOn) return true
    this.hookOn = true
    this.proc.postMessage({ type: 'hook-start', scriptPath: resourcePath(process.platform === 'darwin' ? 'desk/keyhook-mac.js' : 'desk/keyhook.ps1') })
    return true
  }

  sendHook(msg: Record<string, unknown>): void {
    if (this.hookOn) this.proc?.postMessage({ type: 'hook-send', msg })
  }

  stopHook(): void {
    if (!this.hookOn) return
    this.hookOn = false
    this.proc?.postMessage({ type: 'hook-stop' })
  }

  /** null on any failure or timeout. */
  async ask(
    op: 'foreground' | 'context' | 'modifiers' | 'paste' | 'fullscreen' | 'dblclick' | 'duck' | 'unduck' | 'unmute',
    timeoutMs: number,
    args?: Record<string, unknown>
  ): Promise<Reply | null> {
    if (!(await this.start().catch(() => false)) || !this.proc) return null
    const id = this.nextId++
    const proc = this.proc
    return new Promise<Reply | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(null)
      }, timeoutMs)
      this.pending.set(id, (r) => {
        clearTimeout(timer)
        resolve(r && r.ok ? r : null)
      })
      proc.postMessage({ type: 'req', id, op, args })
    })
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

  /** Like `ask`, but says whether the helper failed or never replied, for the watcher's logs. */
  private async request(op: 'field', timeoutMs: number): Promise<Reply | 'no-reply' | 'error'> {
    if (!(await this.start().catch(() => false)) || !this.proc) return 'no-reply'
    const id = this.nextId++
    const proc = this.proc
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve('no-reply')
      }, timeoutMs)
      this.pending.set(id, (r) => {
        clearTimeout(timer)
        resolve(!r ? 'no-reply' : r.ok ? r : 'error')
      })
      proc.postMessage({ type: 'req', id, op })
    })
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

  /** The foreground window fills its monitor: that monitor's top-left in physical pixels; null = no or unknown. */
  async fullscreen(): Promise<{ x: number; y: number } | null> {
    const r = await this.ask('fullscreen', 1_500)
    return r && r['fullscreen'] === true ? { x: Number(r['x']), y: Number(r['y']) } : null
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
