// SPDX-License-Identifier: Apache-2.0
// The catch-all egress layer.
//
// - `egressFetch` / `assertEgress` are the network path for newer code: they check
//   `egressBlocked` and, while local-only is on, refuse every non-loopback URL.
// - `installRequestFilters(session)` attaches the single `webRequest.onBeforeRequest` listener of
//   a session. Electron keeps only the last listener per session, so every other filter (the
//   Gravatar filter included) joins through `registerRequestFilter`. The built-in filter runs
//   first and cancels non-loopback hosts while `isLocalOnly()`.
// - `installSocketGuard()` patches `net.Socket.prototype.connect` once in main: while local-only is
//   on, a TCP connect to a non-loopback host is refused before any DNS lookup, and the socket is
//   destroyed on the next tick with code ENOTULALOCALONLY. Pipe and Unix-socket connects pass.
//   Utility processes open no network connections, so the guard lives in main only.

import net from 'node:net'
import { net as electronNet, type Session } from 'electron'
import { notulaError } from '@shared/errors'
import type { MainContext } from '../context'
import { log } from '../log'
import { egressBlocked, isLocalOnly, LOCAL_ONLY_REASON, type EgressTarget } from '../privacy'
import { isLoopbackHost, isLoopbackUrl } from './loopback'

export { isLoopbackHost, isLoopbackUrl } from './loopback'

// ---------- refusal log: at most one line per (caller, host) per minute, never the query ----------

const REFUSAL_LOG_MS = 60_000
const lastRefusalLog = new Map<string, number>()

function logRefusal(caller: string, host: string): void {
  const key = `${caller}\u0000${host}`
  const now = Date.now()
  const last = lastRefusalLog.get(key)
  if (last !== undefined && now - last < REFUSAL_LOG_MS) return
  lastRefusalLog.set(key, now)
  if (lastRefusalLog.size > 500) lastRefusalLog.clear()
  log('info', 'egress:refused', { caller, host, reason: LOCAL_ONLY_REASON })
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return '(invalid url)'
  }
}

// ---------- the socket guard ----------

export const LOCAL_ONLY_SOCKET_CODE = 'ENOTULALOCALONLY'

let socketGuardInstalled = false

/** The host a `Socket.connect(...)` call targets, or null for a pipe / Unix-socket connect. */
function connectHost(args: unknown[]): string | null {
  const first = args[0]
  if (Array.isArray(first)) return connectHost(first)
  if (typeof first === 'object' && first !== null) {
    const o = first as { path?: unknown; host?: unknown; port?: unknown }
    if (typeof o.path === 'string' && o.port === undefined) return null
    return typeof o.host === 'string' && o.host !== '' ? o.host : 'localhost'
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return null
  const second = args[1]
  return typeof second === 'string' && second !== '' ? second : 'localhost'
}

/** Main only, once, before wiring. */
export function installSocketGuard(): void {
  if (socketGuardInstalled) return
  socketGuardInstalled = true
  const original = net.Socket.prototype.connect
  const guarded = function (this: net.Socket, ...args: unknown[]): net.Socket {
    if (isLocalOnly()) {
      const host = connectHost(args)
      if (host !== null && !isLoopbackHost(host)) {
        logRefusal('socket', host)
        const err = Object.assign(new Error('local-only mode: connection refused'), { code: LOCAL_ONLY_SOCKET_CODE })
        process.nextTick(() => this.destroy(err))
        return this
      }
    }
    return (original as (...a: unknown[]) => net.Socket).apply(this, args)
  }
  net.Socket.prototype.connect = guarded as typeof net.Socket.prototype.connect
}

// ---------- the request-filter registry ----------

export interface RequestFilter {
  id: string
  /** Electron URL match patterns (`*://*.gravatar.com/*`). */
  urls: string[]
  decide(details: { url: string; resourceType: string; webContentsId?: number }): 'cancel' | 'pass'
}

const filters = new Map<string, { filter: RequestFilter; patterns: RegExp[] }>()
const installedSessions = new WeakSet<Session>()

/** An Electron match pattern (`<scheme>://<host>/<path>`, `*` wildcards) as a RegExp. */
function patternToRegExp(pattern: string): RegExp {
  if (pattern === '<all_urls>') return /^(https?|wss?):\/\//
  const m = /^(\*|[a-z]+):\/\/([^/]*)(\/.*)?$/i.exec(pattern)
  if (!m) return /$^/
  const esc = (s: string): string => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  const scheme = m[1] === '*' ? '(https?|wss?)' : esc(m[1] ?? '')
  const rawHost = m[2] ?? '*'
  const host = rawHost === '*' ? '[^/]*' : rawHost.startsWith('*.') ? `([^/]*\\.)?${esc(rawHost.slice(2))}(:\\d+)?` : `${esc(rawHost)}(:\\d+)?`
  const path = esc(m[3] ?? '/*')
  return new RegExp(`^${scheme}://${host}${path}$`, 'i')
}

/** Joins the registry; applies to every session that has (or later gets) the listener. */
export function registerRequestFilter(f: RequestFilter): () => void {
  filters.set(f.id, { filter: f, patterns: f.urls.map(patternToRegExp) })
  return () => {
    if (filters.get(f.id)?.filter === f) filters.delete(f.id)
  }
}

const FILTER_URLS = ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']

/** The one onBeforeRequest listener of a session; the built-in egress filter runs first. */
export function installRequestFilters(session: Session): void {
  if (installedSessions.has(session)) return
  installedSessions.add(session)
  session.webRequest.onBeforeRequest({ urls: FILTER_URLS }, (details, callback) => {
    try {
      if (isLocalOnly() && !isLoopbackUrl(details.url)) {
        logRefusal(`request:${details.resourceType}`, hostOf(details.url))
        callback({ cancel: true })
        return
      }
      for (const { filter, patterns } of filters.values()) {
        if (!patterns.some((p) => p.test(details.url))) continue
        const verdict = filter.decide({
          url: details.url,
          resourceType: details.resourceType,
          webContentsId: details.webContentsId
        })
        if (verdict === 'cancel') {
          callback({ cancel: true })
          return
        }
      }
      callback({})
    } catch (err) {
      log('error', 'egress:filter-failed', { err })
      callback({ cancel: isLocalOnly() })
    }
  })
}

// ---------- the network path for newer code ----------

/** Throws `provider-error: local-only mode` when the target kind is blocked, or when local-only is on and the URL is not loopback. */
export async function assertEgress(
  ctx: Pick<MainContext, 'settings'>,
  target: EgressTarget,
  url: string,
  caller: string
): Promise<void> {
  const blocked =
    (await egressBlocked(ctx, target)) || ((isLocalOnly() || (await ctx.settings.get('privacy.localOnly'))) && !isLoopbackUrl(url))
  if (!blocked) return
  logRefusal(caller, hostOf(url))
  throw notulaError('provider-error', LOCAL_ONLY_REASON)
}

/** `assertEgress`, then Electron `net.fetch`. */
export async function egressFetch(
  ctx: Pick<MainContext, 'settings'>,
  target: EgressTarget,
  url: string,
  init: RequestInit | undefined,
  caller: string
): Promise<Response> {
  await assertEgress(ctx, target, url, caller)
  return electronNet.fetch(url, init)
}
