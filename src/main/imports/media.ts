// SPDX-License-Identifier: Apache-2.0
// The never-shown #/media-worker window:
// WebCodecs decoding of an imported MP3, ADTS AAC or M4A (and WAV parsing) to 16 kHz s16le mono,
// for the local engine. Main owns the file: it streams pieces on request and never reads the
// whole file into memory; the window gets bytes and returns PCM over one transferred MessagePort.
// The window is sandboxed (the factory's literal web preferences), created on demand and closed
// after a minute without work.

import { open } from 'node:fs/promises'
import { MessageChannelMain, type BrowserWindow, type MessagePortMain } from 'electron'
import type { PushChannel } from '@shared/ipc'
import type { MainContext } from '../context'
import { log } from '../log'
import type { MainToMedia, MediaFormat, MediaToMain } from './media-protocol'

const PIECE_BYTES = 262_144
/** A decode with nothing owed to it that says nothing for this long has stalled. */
const STALL_MS = 60_000
const HELLO_WAIT_MS = 3_000
const HELLO_TRIES = 5
const IDLE_CLOSE_MS = 60_000

export interface DecodeHandlers {
  /** A 1 s batch (the last may be shorter). Acknowledge it with `ack(seq)` when the engine took it. */
  onPcm(seq: number, pcm: Buffer): void
}

export interface DecodeRun {
  ack(seq: number): void
  cancel(): void
  /** Resolves with the decoded length; rejects `MediaDecodeError`. */
  done: Promise<{ ms: number }>
}

/** Root mean square of s16le PCM, 0–1 (a debug line's sanity value). */
function rms(pcm: Buffer): number {
  let sum = 0
  const n = pcm.byteLength >> 1
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768
    sum += v * v
  }
  return n ? Math.round(Math.sqrt(sum / n) * 10_000) / 10_000 : 0
}

export class MediaDecodeError extends Error {
  constructor(
    readonly code: 'unsupported' | 'decode',
    message: string
  ) {
    super(message)
    this.name = 'MediaDecodeError'
  }
}

interface Job {
  path: string
  size: number
  handlers: DecodeHandlers
  resolve(v: { ms: number }): void
  reject(e: Error): void
  /** Last message either way, and PCM batches received but not yet acknowledged. */
  lastActivity: number
  owed: number
}

export class MediaHost {
  private win: BrowserWindow | null = null
  private port: MessagePortMain | null = null
  private connecting: Promise<MessagePortMain> | null = null
  private readonly jobs = new Map<string, Job>()
  private idleTimer: NodeJS.Timeout | null = null

  constructor(private readonly ctx: MainContext) {}

  private async connect(): Promise<MessagePortMain> {
    if (this.port && this.win && !this.win.isDestroyed()) return this.port
    if (this.connecting) return this.connecting
    this.connecting = this.open().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async open(): Promise<MessagePortMain> {
    const win = this.ctx.windows.createSecondary({
      kind: 'media-worker',
      route: '/media-worker',
      width: 320,
      height: 240,
      skipTaskbar: true,
      focusable: false
    })
    this.win = win
    win.on('closed', () => {
      if (this.win !== win) return
      this.win = null
      this.port?.close()
      this.port = null
      for (const [id, j] of this.jobs) {
        this.jobs.delete(id)
        j.reject(new MediaDecodeError('decode', 'The audio decoder stopped.'))
      }
    })
    await new Promise<void>((resolve) => {
      if (!win.webContents.isLoading()) resolve()
      else win.webContents.once('did-finish-load', () => resolve())
    })
    // The page's lazy root may attach its listener after the load: send a port, and send a
    // fresh one until the page answers `hello` on it.
    for (let attempt = 1; attempt <= HELLO_TRIES; attempt++) {
      if (win.isDestroyed()) break
      const { port1, port2 } = new MessageChannelMain()
      const hello = new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), HELLO_WAIT_MS)
        port1.on('message', (e) => {
          const m = e.data as MediaToMain
          if (m?.type === 'hello') {
            clearTimeout(t)
            resolve(true)
            return
          }
          this.onMessage(port1, m)
        })
        port1.start()
      })
      win.webContents.postMessage('imports:media-port' satisfies PushChannel, null, [port2])
      if (await hello) {
        this.port = port1
        log('info', 'imports:media-worker-ready', { attempt })
        return port1
      }
      port1.close()
    }
    if (!win.isDestroyed()) win.destroy()
    throw new MediaDecodeError('decode', 'The audio decoder did not start.')
  }

  private onMessage(port: MessagePortMain, m: MediaToMain): void {
    if (!m || typeof m !== 'object' || port !== this.port) return
    if (m.type === 'hello') return
    const job = this.jobs.get(m.jobId)
    if (job) job.lastActivity = Date.now()
    if (!job) return
    switch (m.type) {
      case 'want':
        log('debug', 'imports:media-want', { jobId: m.jobId, offset: m.offset })
        void this.sendPiece(m.jobId, job, m.offset)
        return
      case 'pcm': {
        const pcm = Buffer.from(m.pcm.buffer, m.pcm.byteOffset, m.pcm.byteLength)
        if (m.seq === 0 || m.seq % 30 === 0) log('debug', 'imports:media-pcm', { jobId: m.jobId, seq: m.seq, bytes: pcm.byteLength, rms: rms(pcm) })
        job.owed++
        job.handlers.onPcm(m.seq, pcm)
        return
      }
      case 'done':
        this.jobs.delete(m.jobId)
        job.resolve({ ms: m.ms })
        this.armIdle()
        return
      case 'error':
        this.jobs.delete(m.jobId)
        job.reject(new MediaDecodeError(m.code, m.message))
        this.armIdle()
        return
    }
  }

  private async sendPiece(jobId: string, job: Job, offset: number): Promise<void> {
    if (!this.port || offset < 0 || offset > job.size) return
    const length = Math.min(PIECE_BYTES, job.size - offset)
    const bytes = new Uint8Array(length)
    try {
      const h = await open(job.path, 'r')
      try {
        let got = 0
        while (got < length) {
          const { bytesRead } = await h.read(bytes, got, length - got, offset + got)
          if (!bytesRead) break
          got += bytesRead
        }
      } finally {
        await h.close()
      }
    } catch (err) {
      this.jobs.delete(jobId)
      this.post({ type: 'cancel', jobId })
      job.reject(new MediaDecodeError('decode', `The file could not be read: ${err instanceof Error ? err.message : String(err)}`))
      return
    }
    this.post({ type: 'data', jobId, offset, bytes, eof: offset + length >= job.size })
  }

  private post(m: MainToMedia): void {
    try {
      this.port?.postMessage(m)
    } catch (err) {
      log('warn', 'imports:media-post-failed', { type: m.type, err })
    }
  }

  private watchdog: NodeJS.Timeout | null = null

  /** A decode that owes nothing to main and stays silent for a minute has stalled: it fails. */
  private armWatchdog(): void {
    if (this.watchdog) return
    this.watchdog = setInterval(() => {
      const now = Date.now()
      for (const [id, j] of this.jobs) {
        if (j.owed > 0 || now - j.lastActivity < STALL_MS) continue
        this.jobs.delete(id)
        this.post({ type: 'cancel', jobId: id })
        log('warn', 'imports:media-stalled', { jobId: id })
        j.reject(new MediaDecodeError('decode', 'The audio decoder stopped responding.'))
      }
      if (!this.jobs.size && this.watchdog) {
        clearInterval(this.watchdog)
        this.watchdog = null
      }
    }, 10_000)
    this.watchdog.unref()
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.jobs.size || !this.win) return
      const w = this.win
      this.win = null
      this.port?.close()
      this.port = null
      if (!w.isDestroyed()) w.destroy()
      log('info', 'imports:media-worker-closed', {})
    }, IDLE_CLOSE_MS)
    this.idleTimer.unref()
  }

  /** Decodes one file. The worker pulls the file in pieces; PCM comes back in 1 s batches. */
  decode(jobId: string, path: string, format: MediaFormat, size: number, handlers: DecodeHandlers): DecodeRun {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    let cancelled = false
    const done = new Promise<{ ms: number }>((resolve, reject) => {
      this.jobs.set(jobId, { path, size, handlers, resolve, reject, lastActivity: Date.now(), owed: 0 })
      this.armWatchdog()
      this.connect()
        .then(() => {
          if (cancelled) return
          this.post({ type: 'start', jobId, format, totalBytes: size })
        })
        .catch((err: unknown) => {
          this.jobs.delete(jobId)
          reject(err instanceof Error ? err : new Error(String(err)))
        })
    })
    done.catch(() => undefined)
    return {
      done,
      ack: (seq) => {
        const j = this.jobs.get(jobId)
        if (j) {
          j.owed = Math.max(0, j.owed - 1)
          j.lastActivity = Date.now()
        }
        this.post({ type: 'ack', jobId, seq })
      },
      cancel: () => {
        cancelled = true
        const j = this.jobs.get(jobId)
        this.jobs.delete(jobId)
        this.post({ type: 'cancel', jobId })
        j?.reject(new MediaDecodeError('decode', 'cancelled'))
        this.armIdle()
      }
    }
  }
}
