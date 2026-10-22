// SPDX-License-Identifier: Apache-2.0
// registerLocalApi(): Notula's Local API: the `local-api:*` IPC and the per-user pipe listener it
// shares with the companion CLI.
//
// - Listens while `localApi.enabled` or `companionCli.enabled` is on, and never while
//   `privacy.localOnly` is on (closed within 1 s). Windows: `\\.\pipe\notula-local-api-<16 hex>`,
//   a new random part at every start. macOS: `<userData>/local-api/api.sock` (folder 0700, socket
//   0600). No TCP port, ever.
// - `<userData>/local-api/endpoint.json` { version, path, pid } and, while the companion CLI is
//   on, `companion.json` { protocol_version, path, token } with a per-start token. Both are
//   removed on stop and quit.
// - Newline-delimited JSON: `auth` first, then `request` → `response`. Unread input over 256 KiB
//   destroys the connection. 4 requests in flight per connection, 20/s per key.
// - Keys: `ntl_api_` + 32 random bytes base64url; only the SHA-256 hash is stored; constant-time
//   comparison. No IPC reply ever carries a stored key, a hash or the companion token.
// - Recent activity: the last 50 calls, in memory, without parameters or results.
// - Content sources: `notes.list` takes `source_kind`, `series_id`, `has_source` and `has_series`
//   (false = source notes in no series, the vault's unfiled inbox); `series.list` and `series.get`
//   answer from the storage joins, under `notes:read`.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import type { InvokeChannel, InvokeRes, PushChannel } from '@shared/ipc'
import { notulaError, parseError } from '@shared/errors'
import {
  LOCAL_API_KEY_PREFIX,
  LOCAL_API_LIMITS,
  LOCAL_API_METHOD_SCOPE,
  LOCAL_API_METHODS,
  type LocalApiActivity,
  type LocalApiErrorCode,
  type LocalApiKeyInput,
  type LocalApiMethod,
  type LocalApiScope,
  type LocalApiStatus
} from '@shared/types/local-api'
import type { Settings } from '@shared/types/settings'
import type { SourceKind } from '@shared/types/sources'
import type { MainContext } from '../context'
import { log } from '../log'
import { egressBlocked } from '../privacy'
import type { ApiNoteFilters } from '../storage/api'

/** `source_kind` values (the storage repo checks them again). */
const SOURCE_KINDS: readonly SourceKind[] = ['video', 'live', 'lesson', 'other']

/** The Local API row's line while local-only is on (also used by the companion row). */
export const LOCAL_API_LOCAL_ONLY_LINE = 'Off while Nothing leaves this machine is on. Programs that read your notes could send them elsewhere.'

const COMPANION_CLIENT = 'Companion CLI'
const AUTH_TIMEOUT_MS = 10_000

type Auth =
  | { kind: 'key'; id: string; description: string; scopes: LocalApiScope[]; expiresAt: number | null }
  | { kind: 'companion' }

interface Conn {
  socket: Socket
  buf: string
  auth: Auth | null
  inFlight: number
  closing: boolean
}

interface Config {
  apiEnabled: boolean
  companionEnabled: boolean
  allowTranscripts: boolean
  allowFolderWrites: boolean
  localOnly: boolean
  profileName: string
  profileEmail: string
}

class ApiError extends Error {
  constructor(
    readonly code: LocalApiErrorCode,
    message: string
  ) {
    super(message)
  }
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

const TZ_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i

// ---------- listener hooks for the companion CLI ----------

const startHooks: ((info: { path: string }) => void)[] = []

/** The companion CLI writes its files at each listener start. */
export function onLocalApiListenerStart(cb: (info: { path: string }) => void): void {
  startHooks.push(cb)
}

export function registerLocalApi(ctx: MainContext): void {
  const dir = join(ctx.userDataPath, 'local-api')
  const endpointFile = join(dir, 'endpoint.json')
  const companionFile = join(dir, 'companion.json')
  const isWin = process.platform === 'win32'

  let cfg: Config = {
    apiEnabled: false,
    companionEnabled: false,
    allowTranscripts: true,
    allowFolderWrites: false,
    localOnly: false,
    profileName: '',
    profileEmail: ''
  }
  let server: Server | null = null
  let path: string | null = null
  let companionToken: string | null = null
  let listenFailed = false
  const conns = new Set<Conn>()
  const buckets = new Map<string, { tokens: number; at: number }>()
  const touched = new Map<string, number>()
  const activity: LocalApiActivity[] = []
  let chain: Promise<void> = Promise.resolve()

  const fromSettings = (s: Settings): Config => ({
    apiEnabled: s['localApi.enabled'],
    companionEnabled: s['companionCli.enabled'],
    allowTranscripts: s['companionCli.allowTranscripts'],
    allowFolderWrites: s['companionCli.allowFolderWrites'],
    localOnly: s['privacy.localOnly'],
    profileName: s['profile.name'],
    profileEmail: s['profile.email']
  })

  const wanted = (c: Config): boolean => c.apiEnabled || c.companionEnabled

  const status = (): LocalApiStatus => ({
    enabled: cfg.apiEnabled,
    listening: server !== null,
    endpoint: server ? path : null,
    companionActive: server !== null && companionToken !== null,
    error: wanted(cfg) && cfg.localOnly ? 'local-only' : listenFailed ? 'listen-failed' : null
  })

  const push = (): void => {
    const s = status()
    for (const wc of ctx.windows.targets()) wc.send('local-api:changed' satisfies PushChannel, s)
  }

  const removeFiles = (): void => {
    for (const f of [companionFile, endpointFile]) {
      try {
        rmSync(f, { force: true })
      } catch {
        // Best effort.
      }
    }
  }

  const writeFile = (file: string, body: unknown): void => {
    writeFileSync(file, JSON.stringify(body), { mode: 0o600 })
    if (!isWin) chmodSync(file, 0o600)
  }

  // ---------- one connection ----------

  const send = (c: Conn, msg: unknown): void => {
    if (c.socket.destroyed || c.socket.writableEnded) return
    c.socket.write(JSON.stringify(msg) + '\n')
  }

  const close = (c: Conn): void => {
    c.closing = true
    c.socket.end()
    setTimeout(() => c.socket.destroy(), 1_000).unref()
  }

  const recordActivity = (a: LocalApiActivity): void => {
    activity.unshift(a)
    if (activity.length > LOCAL_API_LIMITS.activityMax) activity.length = LOCAL_API_LIMITS.activityMax
  }

  /** Token bucket, 20/s per key: true when the request may run. */
  const allow = (clientId: string): boolean => {
    const now = Date.now()
    const b = buckets.get(clientId) ?? { tokens: LOCAL_API_LIMITS.ratePerSec, at: now }
    b.tokens = Math.min(LOCAL_API_LIMITS.ratePerSec, b.tokens + ((now - b.at) / 1_000) * LOCAL_API_LIMITS.ratePerSec)
    b.at = now
    buckets.set(clientId, b)
    if (b.tokens < 1) return false
    b.tokens -= 1
    return true
  }

  const scopesOf = (a: Auth): LocalApiScope[] =>
    a.kind === 'key'
      ? a.scopes
      : (['notes:read', cfg.allowTranscripts ? 'transcripts:read' : null, cfg.allowFolderWrites ? 'folders:write' : null].filter(Boolean) as LocalApiScope[])

  const authenticate = async (token: unknown): Promise<Auth | null> => {
    if (typeof token !== 'string' || !token || token.length > 200) return null
    if (token.startsWith(LOCAL_API_KEY_PREFIX)) {
      // User keys work only while `localApi.enabled` is on.
      if (!cfg.apiEnabled) return null
      const hash = sha256(token)
      const row = await ctx.storage.findLocalApiKey(hash).catch(() => null)
      if (!row || !sameSecret(hash, row.key_hash) || row.status !== 'active') return null
      const now = Date.now()
      if (now - (touched.get(row.id) ?? 0) > 60_000) {
        touched.set(row.id, now)
        void ctx.storage.touchLocalApiKey(row.id, new Date(now).toISOString()).catch(() => undefined)
      }
      return { kind: 'key', id: row.id, description: row.description, scopes: row.scopes, expiresAt: row.expiresAt ? Date.parse(row.expiresAt) : null }
    }
    if (cfg.companionEnabled && companionToken && sameSecret(token, companionToken)) return { kind: 'companion' }
    return null
  }

  const onLine = async (c: Conn, line: string): Promise<void> => {
    let msg: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      msg = parsed as Record<string, unknown>
    } catch {
      send(c, { type: 'response', id: 'unknown', ok: false, error: { code: 'INVALID_REQUEST', message: 'Each line must be one JSON object' } })
      // Before auth, anything but a well-formed auth line ends the connection.
      if (!c.auth) close(c)
      return
    }
    const id = typeof msg['id'] === 'string' || typeof msg['id'] === 'number' ? msg['id'] : 'unknown'

    if (msg['type'] === 'auth') {
      if (c.auth) {
        send(c, { type: 'auth', ok: false, error: { code: 'INVALID_REQUEST', message: 'Already authenticated' } })
        return
      }
      const a = await authenticate(msg['token'])
      if (!a) {
        send(c, { type: 'auth', ok: false, error: { code: 'UNAUTHENTICATED', message: 'Invalid key' } })
        log('debug', 'local-api:auth-refused')
        close(c)
        return
      }
      c.auth = a
      send(c, { type: 'auth', ok: true })
      return
    }

    if (msg['type'] !== 'request') {
      send(c, { type: 'response', id, ok: false, error: { code: 'INVALID_REQUEST', message: 'Unknown message type' } })
      if (!c.auth) close(c)
      return
    }
    const auth = c.auth
    if (!auth) {
      send(c, { type: 'response', id, ok: false, error: { code: 'UNAUTHENTICATED', message: 'Authenticate before sending requests' } })
      close(c)
      return
    }

    const started = Date.now()
    const method = typeof msg['method'] === 'string' ? msg['method'] : ''
    const client = auth.kind === 'key' ? auth.description || 'Unnamed key' : COMPANION_CLIENT
    const finish = (ok: boolean, code: LocalApiErrorCode | null): void => {
      const ms = Date.now() - started
      if ((LOCAL_API_METHODS as readonly string[]).includes(method)) {
        recordActivity({ at: new Date(started).toISOString(), client, method, ok, code, durationMs: ms })
      }
      log('debug', 'local-api:call', { client: auth.kind, method: (LOCAL_API_METHODS as readonly string[]).includes(method) ? method : 'unknown', ok, code, ms })
    }
    const fail = (code: LocalApiErrorCode, message: string): void => {
      send(c, { type: 'response', id, ok: false, error: { code, message } })
      finish(false, code)
    }

    if (auth.kind === 'key' && auth.expiresAt !== null && auth.expiresAt <= Date.now()) {
      send(c, { type: 'response', id, ok: false, error: { code: 'UNAUTHENTICATED', message: 'This key has expired' } })
      finish(false, 'UNAUTHENTICATED')
      close(c)
      return
    }
    if (c.inFlight >= LOCAL_API_LIMITS.inFlightPerConnection || !allow(auth.kind === 'key' ? auth.id : 'companion')) {
      return fail('INVALID_REQUEST', 'Too many requests')
    }
    if (!(LOCAL_API_METHODS as readonly string[]).includes(method)) return fail('INVALID_REQUEST', `Unknown method ${method.slice(0, 60) || '(none)'}`)
    const m = method as LocalApiMethod
    if (!scopesOf(auth).includes(LOCAL_API_METHOD_SCOPE[m])) return fail('FORBIDDEN', `This key doesn't allow ${LOCAL_API_METHOD_SCOPE[m]}`)

    c.inFlight++
    try {
      const params = msg['params'] === undefined || msg['params'] === null ? {} : msg['params']
      if (typeof params !== 'object' || Array.isArray(params)) throw new ApiError('INVALID_REQUEST', 'params must be an object')
      const result = await runMethod(m, params as Record<string, unknown>)
      send(c, { type: 'response', id, ok: true, result })
      finish(true, null)
    } catch (err) {
      if (err instanceof ApiError) return fail(err.code, err.message)
      const p = parseError(err)
      if (p.code === 'not-found') return fail('NOT_FOUND', 'Not found')
      if (p.code === 'invalid-input') return fail('INVALID_REQUEST', p.message)
      log('warn', 'local-api:method-failed', { method: m, code: p.code })
      fail('INTERNAL_ERROR', 'Notula could not answer. Try again.')
    } finally {
      c.inFlight--
    }
  }

  const onConnection = (socket: Socket): void => {
    const c: Conn = { socket, buf: '', auth: null, inFlight: 0, closing: false }
    conns.add(c)
    socket.setEncoding('utf8')
    const timer = setTimeout(() => {
      if (!c.auth) socket.destroy()
    }, AUTH_TIMEOUT_MS)
    timer.unref()
    // Lines run in order; a slow method doesn't hold up the next line's parse.
    let queue: Promise<void> = Promise.resolve()
    socket.on('data', (chunk: string) => {
      if (c.closing) return
      c.buf += chunk
      let nl: number
      while ((nl = c.buf.indexOf('\n')) >= 0) {
        const line = c.buf.slice(0, nl).trim()
        c.buf = c.buf.slice(nl + 1)
        if (!line) continue
        if (!c.auth) {
          // Before auth, one line at a time: nothing else may run until auth resolves.
          queue = queue.then(() => (c.closing ? undefined : onLine(c, line)))
        } else {
          void queue.then(() => (c.closing ? undefined : onLine(c, line)))
        }
      }
      if (c.buf.length > LOCAL_API_LIMITS.bufferBytes) {
        log('debug', 'local-api:connection-dropped', { reason: 'buffer' })
        socket.destroy()
      }
    })
    socket.on('error', () => undefined)
    socket.on('close', () => {
      clearTimeout(timer)
      conns.delete(c)
    })
  }

  // ---------- the methods ----------

  const int = (v: unknown, name: string, min: number, max: number, dflt: number): number => {
    if (v === undefined || v === null) return dflt
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new ApiError('INVALID_REQUEST', `${name} must be a whole number from ${min} to ${max}`)
    return v
  }
  const time = (v: unknown, name: string): string | undefined => {
    if (v === undefined || v === null) return undefined
    if (typeof v !== 'string' || !TZ_TIME.test(v) || Number.isNaN(Date.parse(v))) throw new ApiError('INVALID_REQUEST', `${name} must be a time with a timezone`)
    return new Date(v).toISOString()
  }
  const id = (v: unknown, name: string): string => {
    if (typeof v !== 'string' || !v.trim() || v.length > 200) throw new ApiError('INVALID_REQUEST', `${name} is required`)
    return v.trim()
  }
  const flag = (v: unknown, name: string): boolean | undefined => {
    if (v === undefined || v === null) return undefined
    if (typeof v !== 'boolean') throw new ApiError('INVALID_REQUEST', `${name} must be true or false`)
    return v
  }
  /** `notes.list`'s content-source filters (`has_series: false` = source notes in no series). */
  const sourceFilters = (p: Record<string, unknown>): ApiNoteFilters => {
    const f: ApiNoteFilters = {}
    const kind = p['source_kind']
    if (kind !== undefined && kind !== null) {
      if (typeof kind !== 'string' || !(SOURCE_KINDS as readonly string[]).includes(kind)) {
        throw new ApiError('INVALID_REQUEST', `source_kind must be one of ${SOURCE_KINDS.join(', ')}`)
      }
      f.sourceKind = kind as SourceKind
    }
    if (p['series_id'] !== undefined && p['series_id'] !== null) f.seriesId = id(p['series_id'], 'series_id')
    const hasSource = flag(p['has_source'], 'has_source')
    if (hasSource !== undefined) f.hasSource = hasSource
    const hasSeries = flag(p['has_series'], 'has_series')
    if (hasSeries !== undefined) f.hasSeries = hasSeries
    return f
  }
  const withOwner = <T extends { owner: { name: string | null; email: string | null } }>(n: T): T => ({
    ...n,
    owner: { name: cfg.profileName || null, email: cfg.profileEmail || null }
  })

  const runMethod = async (m: LocalApiMethod, p: Record<string, unknown>): Promise<unknown> => {
    switch (m) {
      case 'notes.list': {
        const limit = int(p['limit'], 'limit', 1, LOCAL_API_LIMITS.listMax, LOCAL_API_LIMITS.listDefault)
        const offset = int(p['offset'], 'offset', 0, Number.MAX_SAFE_INTEGER, 0)
        const r = await ctx.storage.apiListNotes({
          limit,
          offset,
          createdAfter: time(p['created_after'], 'created_after'),
          createdBefore: time(p['created_before'], 'created_before'),
          ...sourceFilters(p)
        })
        return { notes: r.notes.map(withOwner), has_more: r.hasMore, next_offset: r.hasMore ? offset + r.notes.length : null }
      }
      case 'notes.get': {
        const ids = p['ids']
        if (!Array.isArray(ids) || ids.length < 1 || ids.length > LOCAL_API_LIMITS.idsMax) throw new ApiError('INVALID_REQUEST', `ids must list 1 to ${LOCAL_API_LIMITS.idsMax} ids`)
        const r = await ctx.storage.apiGetNotes(ids.map((x) => id(x, 'ids')))
        return { notes: r.notes.map(withOwner), not_found: r.notFound }
      }
      case 'transcripts.get': {
        const t = await ctx.storage.apiTranscript(id(p['id'], 'id'))
        if (!t) throw new ApiError('NOT_FOUND', 'Note not found')
        return t
      }
      case 'folders.list': {
        let search: string | undefined
        if (p['search'] !== undefined && p['search'] !== null) {
          if (typeof p['search'] !== 'string') throw new ApiError('INVALID_REQUEST', 'search must be text')
          search = p['search'].trim()
          if (search.length < 1 || search.length > LOCAL_API_LIMITS.searchMax) throw new ApiError('INVALID_REQUEST', `search must be 1 to ${LOCAL_API_LIMITS.searchMax} characters`)
        }
        return { folders: await ctx.storage.apiListFolders(search === undefined ? {} : { search }) }
      }
      case 'folders.notes.add': {
        const folderId = id(p['folder_id'], 'folder_id')
        const docId = id(p['document_id'], 'document_id')
        const n = await ctx.storage.addNotesToFolder(folderId, [docId], 'manual')
        return { message: n > 0 ? 'Note added to the folder' : 'The note was already in the folder' }
      }
      case 'folders.notes.remove': {
        await ctx.storage.removeNoteFromFolder(id(p['folder_id'], 'folder_id'), id(p['document_id'], 'document_id'))
        return { message: 'Note removed from the folder' }
      }
      // Content sources: series with their lessons in catalog order.
      case 'series.list':
        return { series: await ctx.storage.apiListSeries() }
      case 'series.get': {
        const s = await ctx.storage.apiGetSeries(id(p['id'], 'id'))
        if (!s) throw new ApiError('NOT_FOUND', 'Series not found')
        return s
      }
    }
  }

  // ---------- start and stop ----------

  const stop = async (): Promise<void> => {
    const s = server
    server = null
    companionToken = null
    for (const c of conns) c.socket.destroy()
    conns.clear()
    buckets.clear()
    removeFiles()
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()))
    if (!isWin && path) {
      try {
        rmSync(path, { force: true })
      } catch {
        // Best effort.
      }
    }
    path = null
  }

  const start = async (): Promise<void> => {
    const wasListening = server !== null
    await stop()
    listenFailed = false
    if (wanted(cfg) && !(await egressBlocked(ctx, { kind: 'local-api' }))) {
      const p = isWin ? `\\\\.\\pipe\\notula-local-api-${randomBytes(8).toString('hex')}` : join(dir, 'api.sock')
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        if (!isWin) {
          chmodSync(dir, 0o700)
          rmSync(p, { force: true })
        }
      } catch (err) {
        log('warn', 'local-api:dir-failed', { err: err instanceof Error ? err.message : String(err) })
      }
      const s = createServer({ allowHalfOpen: false }, onConnection)
      s.maxConnections = 32
      const ok = await new Promise<boolean>((resolve) => {
        s.once('error', (err: NodeJS.ErrnoException) => {
          log('warn', 'local-api:listen-failed', { code: err.code })
          resolve(false)
        })
        s.listen(p, () => resolve(true))
      })
      if (ok) {
        server = s
        path = p
        try {
          if (!isWin) chmodSync(p, 0o600)
          writeFile(endpointFile, { version: LOCAL_API_LIMITS.protocolVersion, path: p, pid: process.pid })
          if (cfg.companionEnabled) {
            companionToken = randomBytes(32).toString('base64url')
            writeFile(companionFile, { protocol_version: LOCAL_API_LIMITS.protocolVersion, path: p, token: companionToken })
          }
        } catch (err) {
          log('warn', 'local-api:discovery-write-failed', { err: err instanceof Error ? err.message : String(err) })
        }
        log('info', 'local-api:listening', { api: cfg.apiEnabled, companion: companionToken !== null })
        for (const h of startHooks) {
          try {
            h({ path: p })
          } catch (err) {
            log('warn', 'local-api:start-hook-failed', { err: err instanceof Error ? err.message : String(err) })
          }
        }
      } else {
        listenFailed = true
        s.close()
      }
    } else if (wasListening) {
      log('info', 'local-api:stopped', { reason: wanted(cfg) ? 'local-only mode' : 'off' })
    }
    push()
  }

  const restart = (): Promise<void> => {
    chain = chain.then(start, start)
    return chain
  }

  void app.whenReady().then(async () => {
    // Files left by a crash name a dead endpoint.
    removeFiles()
    try {
      cfg = fromSettings(await ctx.settings.getAll())
    } catch (err) {
      log('warn', 'local-api:read-failed', { err: err instanceof Error ? err.message : String(err) })
    }
    if (wanted(cfg)) await restart()
  })

  ctx.bus.on('settings:changed', (e) => {
    const next = fromSettings(e.settings)
    const relisten = next.apiEnabled !== cfg.apiEnabled || next.companionEnabled !== cfg.companionEnabled || next.localOnly !== cfg.localOnly
    cfg = next
    if (relisten) void restart()
  })

  // `before-quit` too: the storage close ends with app.exit(), which skips `will-quit`.
  const onQuit = (): void => {
    for (const c of conns) c.socket.destroy()
    server?.close()
    server = null
    removeFiles()
    if (!isWin) {
      try {
        rmSync(join(dir, 'api.sock'), { force: true })
      } catch {
        // Best effort.
      }
    }
  }
  app.on('before-quit', onQuit)
  app.on('will-quit', onQuit)

  // ---------- IPC ----------

  const dropKey = (keyId: string): void => {
    for (const c of conns) if (c.auth?.kind === 'key' && c.auth.id === keyId) c.socket.destroy()
    buckets.delete(keyId)
  }

  const keyId = (v: unknown): string => {
    if (typeof v !== 'string' || !v) throw notulaError('invalid-input', 'id is required')
    return v
  }

  const cleanScopes = (v: unknown): LocalApiScope[] => {
    if (!Array.isArray(v)) throw notulaError('invalid-input', 'scopes are required')
    const all: LocalApiScope[] = ['notes:read', 'transcripts:read', 'folders:write']
    if (v.some((s) => !all.includes(s as LocalApiScope))) throw notulaError('invalid-input', 'Unknown scope')
    return all.filter((s) => s === 'notes:read' || v.includes(s))
  }

  const cleanDescription = (v: unknown): string => {
    const d = typeof v === 'string' ? v.trim() : ''
    if (d.length > LOCAL_API_LIMITS.descriptionMax) throw notulaError('invalid-input', `Keep the description under ${LOCAL_API_LIMITS.descriptionMax} characters.`)
    return d
  }

  ipcMain.handle('local-api:get-status' satisfies InvokeChannel, (): InvokeRes<'local-api:get-status'> => status())

  ipcMain.handle('local-api:set-enabled' satisfies InvokeChannel, async (_e, p: { enabled: boolean }): Promise<InvokeRes<'local-api:set-enabled'>> => {
    const on = p?.enabled === true
    if (on && cfg.localOnly) throw notulaError('invalid-input', LOCAL_API_LOCAL_ONLY_LINE)
    if (on !== cfg.apiEnabled) {
      cfg = { ...cfg, apiEnabled: on }
      await ctx.settings.set('localApi.enabled', on)
      await restart()
    }
    return status()
  })

  ipcMain.handle('local-api:list-keys' satisfies InvokeChannel, (): Promise<InvokeRes<'local-api:list-keys'>> => ctx.storage.listLocalApiKeys())

  ipcMain.handle('local-api:create-key' satisfies InvokeChannel, async (_e, p: LocalApiKeyInput): Promise<InvokeRes<'local-api:create-key'>> => {
    const days = { never: 0, '30d': 30, '90d': 90, '1y': 365 }[p?.expiresIn]
    if (days === undefined) throw notulaError('invalid-input', 'Choose when the key expires')
    const key = LOCAL_API_KEY_PREFIX + randomBytes(32).toString('base64url')
    const id = randomUUID()
    await ctx.storage.createLocalApiKey({
      id,
      description: cleanDescription(p.description),
      scopes: cleanScopes(p.scopes),
      key_hash: sha256(key),
      expires_at: days ? new Date(Date.now() + days * 86_400_000).toISOString() : null
    })
    log('info', 'local-api:key-created', { expiresIn: p.expiresIn })
    // The only time a key reaches the renderer.
    return { id, key }
  })

  ipcMain.handle(
    'local-api:update-key' satisfies InvokeChannel,
    async (_e, p: { id: string; description?: string; scopes?: LocalApiScope[] }): Promise<InvokeRes<'local-api:update-key'>> => {
      const patch: { description?: string; scopes?: LocalApiScope[] } = {}
      if (p?.description !== undefined) patch.description = cleanDescription(p.description)
      if (p?.scopes !== undefined) patch.scopes = cleanScopes(p.scopes)
      const k = await ctx.storage.updateLocalApiKey(keyId(p?.id), patch)
      // Open connections use the new description and scopes from their next request.
      for (const c of conns) if (c.auth?.kind === 'key' && c.auth.id === k.id) c.auth = { ...c.auth, description: k.description, scopes: k.scopes }
      return k
    }
  )

  ipcMain.handle('local-api:revoke-key' satisfies InvokeChannel, async (_e, p: { id: string }): Promise<InvokeRes<'local-api:revoke-key'>> => {
    const k = await ctx.storage.updateLocalApiKey(keyId(p?.id), { revoked_at: new Date().toISOString() })
    dropKey(k.id)
    log('info', 'local-api:key-revoked')
    return k
  })

  ipcMain.handle('local-api:delete-key' satisfies InvokeChannel, async (_e, p: { id: string }): Promise<InvokeRes<'local-api:delete-key'>> => {
    const idv = keyId(p?.id)
    await ctx.storage.deleteLocalApiKey(idv)
    dropKey(idv)
  })

  ipcMain.handle('local-api:get-activity' satisfies InvokeChannel, (): InvokeRes<'local-api:get-activity'> => activity.slice())
}
