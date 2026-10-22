// SPDX-License-Identifier: Apache-2.0
// A reconnecting WebSocket over `ws`:
// - connect timeout 4 s;
// - the first retry delay is random within [min, max], then ×1.3 per attempt up to
//   the cap (defaults 1–5 s, cap 10 s; AssemblyAI 200–500 ms);
// - a connection is stable after 5 s open, which resets the attempt count;
// - unlimited retries; auth headers are fetched again for every attempt;
// - control messages sent while disconnected are queued and flushed on reopen
//   (audio is never queued here: the session's pending buffer owns it);
// - each reopen emits `reconnect` with the retry count and the downtime.

import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { log } from '../log'

export interface SocketSpec {
  /** For logs only; never a URL with a credential in it. */
  name: string
  url(): string | Promise<string>
  /** Fetched per attempt. Null means no credential: the attempt fails as `auth`. */
  headers(): Promise<Record<string, string> | null>
  minDelayMs?: number
  maxDelayMs?: number
  capDelayMs?: number
  connectTimeoutMs?: number
  stableAfterMs?: number
}

export interface SocketFailure {
  kind: 'auth' | 'network' | 'provider'
  message: string
  status?: number
}

export interface SocketEvents {
  open: []
  message: [data: WebSocket.RawData, isBinary: boolean]
  /** Each drop. `willReconnect` is false only after `close()`. */
  close: [info: { code: number; reason: string; willReconnect: boolean }]
  failure: [f: SocketFailure]
  reconnect: [info: { retry: number; downMs: number }]
}

const AUTH_STATUSES = new Set([401, 403])
/** Close codes some providers use for a refused credential. */
const AUTH_CLOSE_CODES = new Set([1008, 4001, 4003])
const AUTH_RETRY_MS = 10_000

export class ReconnectingSocket extends EventEmitter<SocketEvents> {
  private ws: WebSocket | null = null
  private closed = false
  private attempt = 0
  private reconnects = 0
  private downSince: number | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private connectTimer: NodeJS.Timeout | null = null
  private stableTimer: NodeJS.Timeout | null = null
  private lastFailureAuth = false
  private readonly controlQueue: string[] = []
  private everOpened = false

  constructor(private readonly spec: SocketSpec) {
    super()
  }

  start(): void {
    this.launch()
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  sendBinary(buf: Buffer): boolean {
    if (!this.isOpen() || !this.ws) return false
    this.ws.send(buf, { binary: true })
    return true
  }

  /** Sends now when open; otherwise queues it for the reopen when `queue` is true. */
  sendJson(msg: unknown, queue = true): boolean {
    const text = JSON.stringify(msg)
    if (this.isOpen() && this.ws) {
      this.ws.send(text)
      return true
    }
    if (queue) this.controlQueue.push(text)
    return false
  }

  /** Drops the current socket and reconnects through the normal backoff. */
  forceReconnect(reason: string): void {
    if (this.closed) return
    log('warn', 'asr:socket-force-reconnect', { socket: this.spec.name, reason })
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.removeAllListeners()
      ws.on('error', () => undefined)
      ws.terminate()
    }
    this.onDrop(4000, reason)
  }

  /** Skips a pending backoff wait. */
  retryNow(): void {
    if (this.closed || this.isOpen() || !this.retryTimer) return
    clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.attempt = 0
    this.launch()
  }

  /** Stops reconnecting. Resolves once the socket is gone (at most `timeoutMs`). */
  async close(timeoutMs = 2_000): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.clearTimers()
    const ws = this.ws
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      this.emit('close', { code: 1000, reason: 'closed', willReconnect: false })
      return
    }
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(t)
        resolve()
      }
      const t = setTimeout(() => {
        ws.terminate()
        resolve()
      }, timeoutMs)
      ws.once('close', done)
      if (ws.readyState === WebSocket.OPEN) ws.close(1000)
      else ws.terminate()
    })
  }

  /** Resolves when the server closes the socket (after a graceful close request), or at the timeout. */
  waitForServerClose(timeoutMs: number): Promise<void> {
    const ws = this.ws
    if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, timeoutMs)
      ws.once('close', () => {
        clearTimeout(t)
        resolve()
      })
    })
  }

  /** One attempt. Whatever it throws becomes a failure, which schedules the retry. */
  private launch(): void {
    this.connect().catch((err: unknown) => {
      log('error', 'asr:socket-connect-threw', { socket: this.spec.name, message: errMessage(err) })
      if (!this.closed) this.fail({ kind: 'provider', message: errMessage(err) })
    })
  }

  private async connect(): Promise<void> {
    if (this.closed) return
    let headers: Record<string, string> | null
    let url: string
    try {
      headers = await this.spec.headers()
      url = await this.spec.url()
    } catch (err) {
      this.fail({ kind: 'provider', message: err instanceof Error ? err.message : String(err) })
      return
    }
    if (this.closed) return
    if (!headers) {
      this.fail({ kind: 'auth', message: 'No key is set for this provider.' })
      return
    }
    let ws: WebSocket
    try {
      ws = new WebSocket(url, { headers, handshakeTimeout: this.spec.connectTimeoutMs ?? 4_000 })
    } catch (err) {
      // `ws` validates headers synchronously: a stored key with a character that
      // cannot go in a header throws ERR_INVALID_CHAR here.
      const badHeader = (err as { code?: unknown }).code === 'ERR_INVALID_CHAR'
      this.fail(
        badHeader
          ? { kind: 'auth', message: 'The stored key contains a character that cannot be sent. Enter the key again.' }
          : { kind: 'provider', message: errMessage(err) }
      )
      return
    }
    this.ws = ws
    this.connectTimer = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        ws.removeAllListeners()
        ws.on('error', () => undefined)
        ws.terminate()
        if (this.ws === ws) this.ws = null
        this.fail({ kind: 'network', message: 'Connection timed out.' })
      }
    }, this.spec.connectTimeoutMs ?? 4_000)

    ws.on('unexpected-response', (_req, res) => {
      const status = res.statusCode ?? 0
      res.resume()
      ws.removeAllListeners()
      ws.on('error', () => undefined)
      ws.terminate()
      if (this.ws === ws) this.ws = null
      this.clearConnectTimer()
      this.fail({
        kind: AUTH_STATUSES.has(status) ? 'auth' : status >= 500 || status === 429 ? 'network' : 'provider',
        message: AUTH_STATUSES.has(status) ? `The provider refused the key (HTTP ${status}).` : `HTTP ${status}`,
        status
      })
    })

    ws.on('open', () => {
      this.clearConnectTimer()
      const retry = this.reconnects
      const downMs = this.downSince === null ? 0 : Date.now() - this.downSince
      this.downSince = null
      this.lastFailureAuth = false
      this.stableTimer = setTimeout(() => {
        this.attempt = 0
      }, this.spec.stableAfterMs ?? 5_000)
      for (const text of this.controlQueue.splice(0)) ws.send(text)
      this.emit('open')
      if (this.everOpened) this.emit('reconnect', { retry, downMs })
      this.everOpened = true
    })

    ws.on('message', (data, isBinary) => this.emit('message', data, isBinary))

    ws.on('error', (err) => {
      // A `close` always follows; report the cause here.
      this.emit('failure', { kind: 'network', message: err.message })
    })

    ws.on('close', (code, reasonBuf) => {
      this.clearConnectTimer()
      if (this.ws !== ws) return
      this.ws = null
      const reason = reasonBuf.toString('utf8').slice(0, 200)
      if (!this.closed && AUTH_CLOSE_CODES.has(code)) {
        this.lastFailureAuth = true
        this.emit('failure', { kind: 'auth', message: reason || `Closed with code ${code}.` })
      }
      this.onDrop(code, reason)
    })
  }

  private fail(f: SocketFailure): void {
    this.lastFailureAuth = f.kind === 'auth'
    this.emit('failure', f)
    this.onDrop(f.kind === 'auth' ? 4001 : 1006, f.message)
  }

  private onDrop(code: number, reason: string): void {
    if (this.stableTimer) clearTimeout(this.stableTimer)
    this.stableTimer = null
    if (this.downSince === null) this.downSince = Date.now()
    this.emit('close', { code, reason, willReconnect: !this.closed })
    if (this.closed || this.retryTimer) return
    const delay = this.nextDelay()
    this.attempt++
    this.reconnects++
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.launch()
    }, delay)
  }

  private nextDelay(): number {
    if (this.lastFailureAuth) return AUTH_RETRY_MS
    const min = this.spec.minDelayMs ?? 1_000
    const max = this.spec.maxDelayMs ?? 5_000
    const cap = this.spec.capDelayMs ?? 10_000
    const first = min + Math.random() * (max - min)
    return Math.min(cap, first * Math.pow(1.3, this.attempt))
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = null
  }

  private clearTimers(): void {
    this.clearConnectTimer()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.stableTimer) clearTimeout(this.stableTimer)
    this.retryTimer = null
    this.stableTimer = null
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
