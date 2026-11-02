// SPDX-License-Identifier: Apache-2.0
// The main side of the notula-media utility process: forks it on demand, starts and stops the
// reader, turns its records into session snapshots, and answers tab-strip reads (`locate`) for
// identification. The detector status lives here.
//
// - The worker restarts the PowerShell reader itself (1 s doubling, 5 tries). If the utility
//   process itself dies while the reader is wanted, it is forked again once per 30 s; a second
//   death within 30 s is `failed`.
// - `locate` answers within 4 s, or with no matches. The Courses commands (`apps`, `window-title`,
//   `lesson-read`, `seek`) answer within their own timeouts, or as if nothing was found.

import { basename, dirname, join } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import { SOURCES_LIMITS, type DetectorState, type DetectorStatus, type LessonRead, type LessonReadSite } from '@shared/types/sources'
import { resourcePath } from '../lifecycle/resources'
import { log } from '../log'
import { BROWSER_APPS, matchesFromRecord, type ReaderTabMatch } from './lines'
import { MEDIA_READER_LIMITS, type MainToMedia, type MediaToMain } from './protocol'

/** A raw `sessions` record: web apps need their mapping before it becomes sessions (index.ts). */
type SessionsListener = (rec: Record<string, unknown>) => void
type StatusListener = (s: DetectorStatus) => void

/** out/main/media.js, from the main bundle (or a shared chunk next to it). */
function mediaWorkerPath(): string {
  const here = basename(__dirname) === 'chunks' ? dirname(__dirname) : __dirname
  return join(here, 'media.js')
}

class MediaReaderHost {
  private proc: UtilityProcess | null = null
  private wanted = false
  private lastForkAt = 0
  private nextId = 1
  /** Commands waiting for their answer, by id; null = no answer (timeout, reader gone). */
  private readonly pending = new Map<number, { ev: string; resolve: (rec: Record<string, unknown> | null) => void; timer: NodeJS.Timeout }>()
  private readonly sessionListeners = new Set<SessionsListener>()
  private readonly statusListeners = new Set<StatusListener>()
  private current: DetectorStatus = { state: 'off', reason: null, lastStep: null }

  status(): DetectorStatus {
    return { ...this.current }
  }

  onSessions(l: SessionsListener): () => void {
    this.sessionListeners.add(l)
    return () => this.sessionListeners.delete(l)
  }

  onStatus(l: StatusListener): () => void {
    this.statusListeners.add(l)
    return () => this.statusListeners.delete(l)
  }

  setLastStep(step: DetectorStatus['lastStep']): void {
    if (this.current.lastStep === step) return
    this.current = { ...this.current, lastStep: step }
    this.emitStatus()
  }

  /** `unsupported` platforms and switched-off detection report `off` / `unavailable` without a fork. */
  setUnavailable(reason: string): void {
    this.wanted = false
    this.setState('unavailable', reason)
  }

  start(): void {
    if (this.wanted) return
    // An `unavailable` reader stays so until the app restarts (no restart loop).
    if (this.current.state === 'unavailable') return
    this.wanted = true
    this.setState('starting', null)
    this.send({ type: 'start', args: { scriptPath: resourcePath('media/session.ps1'), apps: Object.keys(BROWSER_APPS) } })
  }

  stop(): void {
    if (!this.wanted) return
    this.wanted = false
    this.proc?.postMessage({ type: 'stop' } satisfies MainToMedia)
    this.failPending()
    if (this.current.state !== 'unavailable') this.setState('off', null)
  }

  /** The tabs of a browser whose name starts with `title`; null when the reader isn't running. */
  async locate(process: string, title: string, address: boolean): Promise<ReaderTabMatch[] | null> {
    const rec = await this.ask('locate', MEDIA_READER_LIMITS.locateTimeoutMs, (id) => ({ type: 'locate', id, process, title, address }))
    if (!rec || rec['error'] === true) return null
    return matchesFromRecord(rec)?.matches ?? null
  }

  /** The reader's `apps` record (browser app shortcuts and Web Applications folder names); null when unanswered. */
  async apps(): Promise<Record<string, unknown> | null> {
    const rec = await this.ask('apps', MEDIA_READER_LIMITS.appsTimeoutMs, (id) => ({ type: 'apps', id }))
    return rec && rec['error'] !== true ? rec : null
  }

  /** A browser window's title by handle; null when unreadable or not a browser window. */
  async windowTitle(hwnd: string): Promise<string | null> {
    const rec = await this.ask('window-title', MEDIA_READER_LIMITS.windowTitleTimeoutMs, (id) => ({ type: 'window-title', id, hwnd }))
    const t = rec?.['title']
    return typeof t === 'string' ? t.slice(0, 2_000) : null
  }

  /** The window read: the lesson fields only (parsed in the worker), or why there are none. */
  async lessonRead(hwnd: string, site: LessonReadSite): Promise<{ read: LessonRead | null; reason: string; reads: number; ms: number }> {
    const t0 = Date.now()
    const rec = await this.ask('lesson-read', SOURCES_LIMITS.windowReadBudgetMs + MEDIA_READER_LIMITS.lessonReadGraceMs, (id) => ({ type: 'lesson-read', id, hwnd, site }))
    const read = rec?.['read']
    const reads = typeof rec?.['reads'] === 'number' ? rec['reads'] : 0
    const reason = typeof rec?.['reason'] === 'string' ? rec['reason'].slice(0, 30) : rec ? 'read' : 'no-answer'
    return { read: read && typeof read === 'object' ? (read as LessonRead) : null, reason, reads, ms: Date.now() - t0 }
  }

  /**
   * Seeks the session of an app id; `gone` only when the reader says it isn't there. No answer (a
   * timeout, a reader not running) is `refused`: it says nothing about the session.
   */
  async seek(app: string, ms: number): Promise<'ok' | 'refused' | 'gone'> {
    const rec = await this.ask('seek', MEDIA_READER_LIMITS.seekTimeoutMs, (id) => ({ type: 'seek', id, app, ms }))
    const r = rec?.['result']
    return r === 'ok' || r === 'gone' ? r : 'refused'
  }

  /** One command and its answer (`ev` with the same id); null when the reader isn't running or is late. */
  private ask(ev: string, timeoutMs: number, msg: (id: number) => MainToMedia): Promise<Record<string, unknown> | null> {
    if (!this.wanted || !this.proc || this.current.state !== 'running') return Promise.resolve(null)
    const id = this.nextId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        log('debug', 'media:command-timeout', { ev })
        resolve(null)
      }, timeoutMs)
      this.pending.set(id, { ev, resolve, timer })
      this.proc?.postMessage(msg(id))
    })
  }

  private send(m: MainToMedia): void {
    const proc = this.ensureProc()
    proc?.postMessage(m)
  }

  private ensureProc(): UtilityProcess | null {
    if (this.proc) return this.proc
    try {
      this.lastForkAt = Date.now()
      const proc = utilityProcess.fork(mediaWorkerPath(), [], { serviceName: 'notula-media' })
      this.proc = proc
      proc.on('message', (m: MediaToMain) => this.onWorker(m))
      proc.once('spawn', () => log('info', 'media:worker-forked', { pid: proc.pid ?? 0 }))
      proc.once('exit', (code: number) => {
        if (this.proc !== proc) return
        this.proc = null
        this.failPending()
        if (!this.wanted) return
        log('warn', 'media:worker-exited', { code })
        if (Date.now() - this.lastForkAt < MEDIA_READER_LIMITS.restartResetMs) {
          this.wanted = false
          this.setState('failed', 'worker-exited')
          return
        }
        this.setState('restarting', 'worker-exited')
        setTimeout(() => {
          if (!this.wanted) return
          this.send({ type: 'start', args: { scriptPath: resourcePath('media/session.ps1'), apps: Object.keys(BROWSER_APPS) } })
        }, MEDIA_READER_LIMITS.restartDelayMs).unref()
      })
      return proc
    } catch (err) {
      log('error', 'media:worker-fork-failed', { err })
      this.wanted = false
      this.setState('failed', 'fork-failed')
      return null
    }
  }

  private onWorker(m: MediaToMain): void {
    if (m.type === 'log') {
      log(m.level, m.event, m.data)
      return
    }
    if (m.type === 'state') {
      const map: Record<typeof m.state, DetectorState> = {
        starting: 'starting',
        running: 'running',
        restarting: 'restarting',
        failed: 'failed',
        unavailable: 'unavailable',
        stopped: 'off'
      }
      if (m.state === 'stopped' && !this.wanted) {
        if (this.current.state !== 'unavailable') this.setState('off', null)
        return
      }
      if (m.state === 'restarting' || m.state === 'failed' || m.state === 'unavailable') this.failPending()
      if (m.state === 'failed' || m.state === 'unavailable') this.wanted = false
      this.setState(map[m.state], m.state === 'unavailable' || m.state === 'failed' ? (m.detail ?? m.state) : null)
      return
    }
    const rec = m.record
    if (rec['ev'] === 'sessions') {
      for (const l of this.sessionListeners) l(rec)
      return
    }
    const id = rec['id']
    if (typeof id !== 'number') return
    const p = this.pending.get(id)
    if (!p || p.ev !== rec['ev']) return
    this.pending.delete(id)
    clearTimeout(p.timer)
    p.resolve(rec)
  }

  private failPending(): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.resolve(null)
      this.pending.delete(id)
    }
  }

  private setState(state: DetectorState, reason: string | null): void {
    // Reasons are codes (`constrained-language`, `exited (1)`), never a title or URL.
    const next: DetectorStatus = { state, reason: reason ? reason.slice(0, 80) : null, lastStep: this.current.lastStep }
    if (next.state === this.current.state && next.reason === this.current.reason) return
    this.current = next
    log('info', 'media:detector-state', { state, reason: next.reason })
    this.emitStatus()
  }

  private emitStatus(): void {
    const s = this.status()
    for (const l of this.statusListeners) l(s)
  }
}

/** The one reader host of this app run. */
export const mediaReader = new MediaReaderHost()
