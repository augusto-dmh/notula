// SPDX-License-Identifier: Apache-2.0
// Shared plumbing for cloud connections: socket events → AsrConnection events, the
// per-socket timing anchor, and the liveness watchdog.

import { EventEmitter } from 'node:events'
import type { AsrProviderId } from '@shared/types/transcript'
import { log } from '../../log'
import { ReconnectingSocket, type SocketSpec } from '../socket'
import type { AsrConnection, AsrConnectionEvents } from './types'

const LIVENESS_TICK_MS = 1_000
/** The graceful wait plus the socket close. */
const CLOSE_TIMEOUT_MS = 7_000
const SOCKET_CLOSE_MS = 2_000
/** Audio counts as "still being sent" when a batch went out this recently. */
const SENDING_WINDOW_MS = 2_000

export abstract class CloudConnection extends EventEmitter<AsrConnectionEvents> implements AsrConnection {
  protected readonly socket: ReconnectingSocket
  /** Capture time of the first audio sent on the current socket. */
  protected baseEpochMs: number | null = null
  /** Increments per socket, so segment keys never collide across reconnects. */
  protected socketGen = 0
  private lastResultAt = 0
  private lastAudioAt = 0
  private openedAt = 0
  private livenessTimer: NodeJS.Timeout | null = null
  protected closing = false

  abstract readonly providerId: AsrProviderId
  abstract readonly model: string
  abstract readonly replayIntervalMs: number

  constructor(
    spec: SocketSpec,
    private readonly livenessTimeoutMs: number
  ) {
    super()
    this.socket = new ReconnectingSocket(spec)
    this.socket.on('open', () => {
      this.socketGen++
      this.baseEpochMs = null
      this.openedAt = Date.now()
      this.lastResultAt = 0
      this.onSocketOpen()
      this.emit('open')
    })
    this.socket.on('close', (info) => {
      this.onSocketClose()
      this.emit('close', { willReconnect: info.willReconnect })
    })
    this.socket.on('failure', (f) => {
      if (this.closing) return
      this.emit('error', { kind: f.kind, message: f.message, ...(f.status ? { status: f.status } : {}) })
    })
    this.socket.on('reconnect', (info) => this.emit('reconnect', info))
    this.socket.on('message', (data, isBinary) => {
      if (isBinary) return
      let msg: unknown
      try {
        msg = JSON.parse(data.toString())
      } catch (err) {
        this.emit('error', { kind: 'parse', message: err instanceof Error ? err.message : 'unparsable message' })
        return
      }
      try {
        this.onMessage(msg as Record<string, unknown>)
      } catch (err) {
        this.emit('error', { kind: 'parse', message: err instanceof Error ? err.message : String(err) })
      }
    })
  }

  start(): this {
    this.socket.start()
    this.livenessTimer = setInterval(() => this.checkLiveness(), LIVENESS_TICK_MS)
    return this
  }

  isOpen(): boolean {
    return this.socket.isOpen()
  }

  send(pcm: Buffer, captureTimeMs: number): boolean {
    if (this.closing || !this.socket.isOpen()) return false
    if (this.baseEpochMs === null) this.baseEpochMs = captureTimeMs
    const ok = this.socket.sendBinary(pcm)
    if (ok) this.lastAudioAt = Date.now()
    return ok
  }

  retryNow(): void {
    this.socket.retryNow()
  }

  abstract updateKeywords(terms: string[]): void

  async close(timeoutMs = CLOSE_TIMEOUT_MS): Promise<void> {
    if (this.closing) return
    this.closing = true
    if (this.livenessTimer) clearInterval(this.livenessTimer)
    this.livenessTimer = null
    const socketMs = Math.min(SOCKET_CLOSE_MS, Math.max(500, timeoutMs / 3))
    try {
      await this.gracefulClose(Math.max(0, timeoutMs - socketMs))
    } catch (err) {
      log('warn', 'asr:graceful-close-failed', { provider: this.providerId, err })
    }
    await this.socket.close(socketMs)
  }

  /** Counts a server message as a sign of life. */
  protected markAlive(): void {
    this.lastResultAt = Date.now()
  }

  protected anchor(): number {
    return this.baseEpochMs ?? Date.now()
  }

  protected onSocketOpen(): void {}
  protected onSocketClose(): void {}
  protected abstract onMessage(msg: Record<string, unknown>): void
  /** Asks the provider to flush its last results; waits at most `waitMs`. */
  protected abstract gracefulClose(waitMs: number): Promise<void>

  private checkLiveness(): void {
    if (this.closing || !this.socket.isOpen()) return
    const now = Date.now()
    if (now - this.lastAudioAt > SENDING_WINDOW_MS) return
    const since = Math.max(this.lastResultAt, this.openedAt)
    if (now - since > this.livenessTimeoutMs) {
      this.emit('error', { kind: 'liveness', message: 'Missing transcription: no result while audio is being sent.' })
      this.lastResultAt = now
      this.socket.forceReconnect('liveness timeout')
    }
  }
}

/** A number from an unknown field, or the fallback. */
export function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
