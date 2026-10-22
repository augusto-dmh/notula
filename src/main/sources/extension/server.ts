// SPDX-License-Identifier: Apache-2.0
// The bridge's per-user pipe: the Local API's
// pattern (`local-api/index.ts`) with its own name, token and limits.
//
// - `\\.\pipe\notula-ext-bridge-<16 hex>`, a new random part and a new token at every start. No
//   TCP port, ever. `<userData>\ext-bridge\endpoint.json` {protocol, path, token} is written when
//   the pipe listens and removed on stop and quit.
// - One JSON object per line. The first line must be the relay's `auth` within 2 s (the relay
//   writes it as soon as it connects): the token (constant-time) and the origin (one of the
//   allowed extension ids). Anything else closes the connection with no reply.
// - Limits: before auth, over 1 KiB buffered closes the connection, and at most 4 connections may
//   wait for auth (the pipe's default DACL lets other local users open it). After auth, a line over
//   1 MiB is dropped and counted; over 4 MiB buffered closes the connection; more than 20 messages
//   a second per connection are dropped and counted. At most 32 connections.
// - Every line after `auth` goes through `parseLine` (validate.ts) before anyone sees it.
// Logs carry codes and counts only.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { EXT_BRIDGE, EXT_LIMITS, EXT_PROTOCOL, type ExtToNotula, type NotulaToExt } from '@shared/types/extension-protocol'
import { log } from '../../log'
import { parseAuth, parseLine } from './validate'

const AUTH_TIMEOUT_MS = 2_000
/** An `auth` line is under 400 bytes. */
const AUTH_BUFFER_MAX = 1_024
const UNAUTHED_MAX = 4

export interface BridgeConn {
  readonly id: number
  readonly origin: string
  send(msg: NotulaToExt): void
  close(): void
}

export interface ServerHooks {
  /** `auth` passed. */
  opened(c: BridgeConn): void
  message(c: BridgeConn, msg: ExtToNotula): void
  closed(c: BridgeConn): void
  /** A refused, dropped or unknown line, by reason (counts only). */
  dropped(reason: string): void
}

interface Conn extends BridgeConn {
  origin: string
  socket: Socket
  buf: string
  authed: boolean
  closing: boolean
  tokens: number
  at: number
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

export class BridgeServer {
  private server: Server | null = null
  private path: string | null = null
  private token: string | null = null
  private nextId = 1
  private readonly conns = new Set<Conn>()

  constructor(
    private readonly dir: string,
    private readonly origins: () => string[],
    private readonly hooks: ServerHooks
  ) {}

  get listening(): boolean {
    return this.server !== null
  }

  private get endpointFile(): string {
    return join(this.dir, EXT_BRIDGE.endpointFile)
  }

  async start(): Promise<boolean> {
    if (this.server) return true
    const p = `\\\\.\\pipe\\${EXT_BRIDGE.pipePrefix}${randomBytes(8).toString('hex')}`
    const s = createServer({ allowHalfOpen: false }, (socket) => this.onConnection(socket))
    s.maxConnections = EXT_LIMITS.connections
    const ok = await new Promise<boolean>((resolve) => {
      s.once('error', (err: NodeJS.ErrnoException) => {
        log('warn', 'ext-bridge:listen-failed', { code: err.code })
        resolve(false)
      })
      s.listen(p, () => resolve(true))
    })
    if (!ok) {
      s.close()
      return false
    }
    this.server = s
    this.path = p
    this.token = randomBytes(32).toString('base64url')
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(this.endpointFile, JSON.stringify({ protocol: EXT_PROTOCOL.current, path: p, token: this.token }), { mode: 0o600 })
    } catch (err) {
      log('warn', 'ext-bridge:endpoint-write-failed', { code: (err as NodeJS.ErrnoException).code ?? null })
      await this.stop()
      return false
    }
    log('info', 'ext-bridge:listening')
    return true
  }

  async stop(): Promise<void> {
    const s = this.server
    this.server = null
    this.token = null
    this.path = null
    for (const c of [...this.conns]) c.socket.destroy()
    this.conns.clear()
    this.removeEndpoint()
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()))
  }

  /** At quit: synchronous, no waiting. */
  stopNow(): void {
    for (const c of this.conns) c.socket.destroy()
    this.conns.clear()
    this.server?.close()
    this.server = null
    this.token = null
    this.removeEndpoint()
  }

  private removeEndpoint(): void {
    try {
      rmSync(this.endpointFile, { force: true })
    } catch {
      // Best effort.
    }
  }

  // ---------- one connection ----------

  private onConnection(socket: Socket): void {
    const c: Conn = {
      id: this.nextId++,
      origin: '',
      socket,
      buf: '',
      authed: false,
      closing: false,
      tokens: EXT_LIMITS.messagesPerSecond,
      at: Date.now(),
      send: (msg) => {
        if (c.closing || socket.destroyed || socket.writableEnded) return
        const line = JSON.stringify(msg)
        if (Buffer.byteLength(line, 'utf8') > EXT_LIMITS.frameBytes) {
          this.hooks.dropped('out-too-big')
          return
        }
        socket.write(line + '\n')
      },
      close: () => {
        if (c.closing) return
        c.closing = true
        socket.end()
        setTimeout(() => socket.destroy(), 1_000).unref()
      }
    }
    let waiting = 0
    for (const o of this.conns) if (!o.authed) waiting++
    if (waiting >= UNAUTHED_MAX) {
      this.hooks.dropped('unauthed-cap')
      socket.on('error', () => undefined)
      socket.destroy()
      return
    }
    this.conns.add(c)
    socket.setEncoding('utf8')
    const timer = setTimeout(() => {
      if (!c.authed) socket.destroy()
    }, AUTH_TIMEOUT_MS)
    timer.unref()
    socket.on('data', (chunk: string) => {
      if (c.closing || socket.destroyed) return
      c.buf += chunk
      let nl: number
      while ((nl = c.buf.indexOf('\n')) >= 0) {
        const line = c.buf.slice(0, nl).trim()
        c.buf = c.buf.slice(nl + 1)
        if (line) this.onLine(c, line)
        if (c.closing || socket.destroyed) return
      }
      if (c.buf.length > (c.authed ? EXT_LIMITS.bufferBytes : AUTH_BUFFER_MAX)) {
        this.hooks.dropped(c.authed ? 'buffer' : 'auth-buffer')
        socket.destroy()
      }
    })
    socket.on('error', () => undefined)
    socket.on('close', () => {
      clearTimeout(timer)
      this.conns.delete(c)
      if (c.authed) this.hooks.closed(c)
    })
  }

  private onLine(c: Conn, line: string): void {
    if (!c.authed) {
      // Before auth: exactly one well-formed auth line, or the connection ends with no reply.
      let raw: unknown = null
      try {
        raw = JSON.parse(line)
      } catch {
        raw = null
      }
      const a = parseAuth(raw)
      const token = this.token
      if (!a || !token || !sameSecret(a.token, token) || !this.origins().includes(a.origin)) {
        log('debug', 'ext-bridge:auth-refused')
        c.socket.destroy()
        return
      }
      c.authed = true
      c.origin = a.origin
      this.hooks.opened(c)
      return
    }
    if (Buffer.byteLength(line, 'utf8') > EXT_LIMITS.frameBytes) return this.hooks.dropped('too-big')
    if (!this.allow(c)) return this.hooks.dropped('rate')
    const parsed = parseLine(line)
    if (!parsed.ok) return this.hooks.dropped(parsed.reason)
    if (parsed.msg.type === 'media' && Buffer.byteLength(line, 'utf8') > EXT_LIMITS.mediaBytes) return this.hooks.dropped('media-too-big')
    if (parsed.msg.type === 'captions' && Buffer.byteLength(line, 'utf8') > EXT_LIMITS.captionsPartBytes + 4_096) return this.hooks.dropped('captions-too-big')
    this.hooks.message(c, parsed.msg)
  }

  /** Token bucket: 20 messages a second per connection. */
  private allow(c: Conn): boolean {
    const now = Date.now()
    c.tokens = Math.min(EXT_LIMITS.messagesPerSecond, c.tokens + ((now - c.at) / 1_000) * EXT_LIMITS.messagesPerSecond)
    c.at = now
    if (c.tokens < 1) return false
    c.tokens -= 1
    return true
  }
}
