// SPDX-License-Identifier: Apache-2.0
// Main's side of the notula-desk helper: forks out/main/desk.js while dictation is
// armed, keeps it warm, and answers `ask(op)` with a timeout. A failed or missing helper
// degrades each caller (no context, the clipboard instead of a paste); it never throws.
// It also hosts the dictation bar's key hook: `startHook` /
// `sendHook` / `stopHook`, with its events and its exit on `onHook`.

import { join } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import { resourcePath } from '../lifecycle/resources'
import { log } from '../log'

export interface DeskForeground {
  process: string
  title: string
}

export interface DeskContext extends DeskForeground {
  result: 'captured' | 'empty' | 'secure_input' | 'unsupported' | 'error' | 'timeout'
  field: { name: string; type: string; password: boolean; editable: boolean } | null
  before: string
  after: string
  selection: string
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
  async ask(op: 'foreground' | 'context' | 'modifiers' | 'paste' | 'fullscreen', timeoutMs: number): Promise<Reply | null> {
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
      proc.postMessage({ type: 'req', id, op })
    })
  }

  async foreground(timeoutMs = 1_000): Promise<DeskForeground | null> {
    const r = await this.ask('foreground', timeoutMs)
    return r ? { process: String(r['process'] ?? ''), title: String(r['title'] ?? '') } : null
  }

  async context(timeoutMs: number): Promise<DeskContext> {
    const r = await this.ask('context', timeoutMs)
    if (!r) return { result: 'timeout', process: '', title: '', field: null, before: '', after: '', selection: '' }
    const f = r['field'] as Record<string, unknown> | null
    return {
      result: (r['result'] as DeskContext['result']) ?? 'error',
      process: String(r['process'] ?? ''),
      title: String(r['title'] ?? ''),
      field: f ? { name: String(f['name'] ?? ''), type: String(f['type'] ?? ''), password: f['password'] === true, editable: f['editable'] === true } : null,
      before: String(r['before'] ?? ''),
      after: String(r['after'] ?? ''),
      selection: String(r['selection'] ?? '')
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

  async paste(): Promise<boolean> {
    const r = await this.ask('paste', 3_000)
    return r?.['sent'] === true
  }
}
