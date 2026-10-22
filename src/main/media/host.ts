// SPDX-License-Identifier: Apache-2.0
// The main side of the notula-media utility process: forks it on demand, starts and stops the
// reader, turns its records into session snapshots, and answers tab-strip reads (`locate`) for
// identification. The detector status lives here.
//
// - The worker restarts the PowerShell reader itself (1 s doubling, 5 tries). If the utility
//   process itself dies while the reader is wanted, it is forked again once per 30 s; a second
//   death within 30 s is `failed`.
// - `locate` answers within 4 s, or with no matches.

import { basename, dirname, join } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import type { DetectorState, DetectorStatus, MediaSession } from '@shared/types/sources'
import { resourcePath } from '../lifecycle/resources'
import { log } from '../log'
import { BROWSER_APPS, matchesFromRecord, sessionsFromRecord, type ReaderTabMatch } from './lines'
import { MEDIA_READER_LIMITS, type MainToMedia, type MediaToMain } from './protocol'

type SessionsListener = (sessions: MediaSession[]) => void
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
  private nextLocateId = 1
  private readonly pending = new Map<number, { resolve: (m: ReaderTabMatch[] | null) => void; timer: NodeJS.Timeout }>()
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
  locate(process: string, title: string, address: boolean): Promise<ReaderTabMatch[] | null> {
    if (!this.wanted || !this.proc || this.current.state !== 'running') return Promise.resolve(null)
    const id = this.nextLocateId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        log('debug', 'media:locate-timeout', {})
        resolve(null)
      }, MEDIA_READER_LIMITS.locateTimeoutMs)
      this.pending.set(id, { resolve, timer })
      this.proc?.postMessage({ type: 'locate', id, process, title, address } satisfies MainToMedia)
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
      const sessions = sessionsFromRecord(rec, Date.now())
      if (sessions) for (const l of this.sessionListeners) l(sessions)
      return
    }
    if (rec['ev'] === 'locate') {
      const r = matchesFromRecord(rec)
      if (!r) return
      const p = this.pending.get(r.id)
      if (!p) return
      this.pending.delete(r.id)
      clearTimeout(p.timer)
      p.resolve(rec['error'] === true ? null : r.matches)
    }
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
