// SPDX-License-Identifier: Apache-2.0
// The native-messaging port to Notula's relay host: when it connects, the handshake and the backoff.
//
// Pull, not always-on: the port opens when a granted tab starts playing, on Mark this moment, when
// the popup opens, and for a short hello at browser start. It closes 120 s after the last playback
// stops, or as soon as Notula answers mode `none`. A native port keeps the service worker alive
// (Chrome 105+), so the timers here only run while a port is open.
//
// Everything Notula sends goes through `parseFromNotula`; anything else is counted and dropped.

import {
  EXT_BRIDGE,
  EXT_LIMITS,
  EXT_PROTOCOL,
  compareVersions,
  parseFromNotula,
  protocolSupported,
  MAX_FRAME_BYTES,
  type ExtMode,
  type ExtPolicy,
  type ExtToNotula,
  type NotulaToExt
} from '../lib/protocol'
import { jsonBytes } from '../lib/check'
import type { PopupConnection } from '../lib/messages'
import { count, drainCounts } from './counters'

export type ConnectReason = 'play' | 'popup' | 'mark' | 'startup' | 'retry'

export interface BridgeHandlers {
  /** The session is up (hello.ack) or Notula changed its mode or policy. */
  onReady(): void
  onMessage(msg: NotulaToExt): void
  /** True while a granted tab plays; decides whether to stay connected. */
  wantsConnection(): boolean
  /** Just before an idle disconnect, for the last `media.gone` messages. */
  beforeIdleClose(): void
  /** The first-run explanation was accepted. */
  allowed(): Promise<boolean>
}

const OFF_POLICY: ExtPolicy = { incognito: false, captions: false, captions_replay: false, outline: false }
/** Not running: retry after 5 s, 30 s, 2 min, then only on the next play. */
const BACKOFF_MS = [5_000, 30_000, 120_000]
const HELLO_TIMEOUT_MS = 5_000
/** The relay retries its pipe for 10 s after saying not-running. */
const RELAY_WAIT_MS = 12_000
/** After mode `none`, plays don't reconnect for this long; the popup and Mark still do. */
const NONE_QUIET_MS = 10 * 60_000
const STARTUP_IDLE_MS = 5_000
const POPUP_IDLE_MS = 30_000
const LOG_EVERY_MS = 60_000
/** Caption parts go out at most 10 per second, under Notula's 20 per second cap. */
const PACE_MS = 100
const QUEUE_MAX = 400

let handlers: BridgeHandlers | null = null
let port: chrome.runtime.Port | null = null
let ready = false
let connection: PopupConnection = 'idle'
let appVersion: string | null = null
let mode: ExtMode = 'none'
let feedTab: string | null = null
let policy: ExtPolicy = OFF_POLICY
let backoff = 0
let retryAt = 0
let quietUntil = 0
let reconnectedOnce = false
let helloTimer: ReturnType<typeof setTimeout> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let logTimer: ReturnType<typeof setInterval> | null = null
/** Token bucket for the 20 messages per second Notula accepts. */
let tokens: number = EXT_LIMITS.messagesPerSecond
let tokensAt = Date.now()
const queue: ExtToNotula[] = []
let drainTimer: ReturnType<typeof setTimeout> | null = null

export function initBridge(h: BridgeHandlers): void {
  handlers = h
}

export const bridge = {
  get ready(): boolean {
    return ready
  },
  get connection(): PopupConnection {
    return connection
  },
  get appVersion(): string | null {
    return appVersion
  },
  get mode(): ExtMode {
    return ready ? mode : 'none'
  },
  get feedTab(): string | null {
    return ready && mode === 'feed' ? feedTab : null
  },
  get policy(): ExtPolicy {
    return ready ? policy : OFF_POLICY
  }
}

function clearTimer(t: ReturnType<typeof setTimeout> | null): null {
  if (t) clearTimeout(t)
  return null
}

function setConnection(next: PopupConnection): void {
  if (connection === next) return
  connection = next
  void chrome.storage.session.set({ connection: next, appVersion }).catch(() => undefined)
}

/** Restores the last known state after the service worker restarts. */
export async function restoreBridge(): Promise<void> {
  try {
    const s = await chrome.storage.session.get(['connection', 'appVersion'])
    if (typeof s.connection === 'string' && !port) {
      const c = s.connection as PopupConnection
      // A port never survives a service-worker restart, so a live state becomes idle.
      connection = c === 'connected' || c === 'connecting' ? 'idle' : c
    }
    if (typeof s.appVersion === 'string') appVersion = s.appVersion
  } catch {
    // storage.session can be unavailable in tests or early startup; the defaults stand.
  }
}

/** Opens the port when the policy allows it. */
export async function ensureConnected(reason: ConnectReason): Promise<void> {
  if (!handlers || port) return
  if (!(await handlers.allowed())) {
    setConnection('setup')
    return
  }
  const now = Date.now()
  const userAction = reason === 'popup' || reason === 'mark'
  if (!userAction) {
    if (now < quietUntil) return
    if (reason === 'play' && now < retryAt) return
  }
  open(reason)
}

function open(reason: ConnectReason): void {
  try {
    port = chrome.runtime.connectNative(EXT_BRIDGE.hostName)
  } catch {
    count('native:connect-throw')
    port = null
    failed('host-failed')
    return
  }
  ready = false
  setConnection('connecting')
  port.onMessage.addListener(onPortMessage)
  port.onDisconnect.addListener(onPortDisconnect)
  helloTimer = clearTimer(helloTimer)
  helloTimer = setTimeout(() => {
    count('native:hello-timeout')
    close()
    failed('host-failed')
  }, HELLO_TIMEOUT_MS)
  post(hello(), true)
  if (reason === 'startup') scheduleIdle(STARTUP_IDLE_MS)
  else if (reason === 'popup' || reason === 'mark') scheduleIdle(POPUP_IDLE_MS)
}

function hello(): ExtToNotula {
  const brands = navigator.userAgentData?.brands ?? []
  // Prefer the real brand over Chromium's and the GREASE entries ("Not.A/Brand").
  const real =
    brands.find((b) => /edge|chrome|brave|opera|vivaldi/i.test(b.brand) && !/chromium/i.test(b.brand)) ??
    brands.find((b) => /chromium/i.test(b.brand)) ??
    null
  return {
    type: 'hello',
    protocol: [EXT_PROTOCOL.oldest, EXT_PROTOCOL.current],
    ext: { version: chrome.runtime.getManifest().version, store: __EXT_STORE__ },
    browser: { brand: real?.brand.slice(0, 40) ?? 'Chromium', major: Number.parseInt(real?.version ?? '0', 10) || 0 }
  }
}

function onPortMessage(raw: unknown): void {
  const parsed = parseFromNotula(raw)
  if (!parsed.ok) {
    count(parsed.reason === 'unknown' ? 'native:unknown-type' : 'native:invalid')
    return
  }
  const msg = parsed.msg
  switch (msg.type) {
    case 'bridge':
      // The relay found no Notula. It keeps trying for 10 s, then exits and the port closes.
      setConnection('not-running')
      helloTimer = clearTimer(helloTimer)
      helloTimer = setTimeout(() => {
        close()
        failed('not-running')
      }, RELAY_WAIT_MS)
      return
    case 'hello.ack': {
      helloTimer = clearTimer(helloTimer)
      appVersion = msg.app.version
      if (!protocolSupported(msg.protocol)) {
        close()
        quietUntil = Date.now() + NONE_QUIET_MS
        setConnection('app-outdated')
        return
      }
      if (compareVersions(chrome.runtime.getManifest().version, msg.min_ext) < 0) {
        close()
        quietUntil = Date.now() + NONE_QUIET_MS
        setConnection('extension-outdated')
        return
      }
      ready = true
      backoff = 0
      retryAt = 0
      reconnectedOnce = false
      policy = msg.policy
      applyMode(msg.mode, msg.feed_tab)
      return
    }
    case 'mode':
      if (!ready) return
      applyMode(msg.mode, msg.feed_tab)
      return
    case 'policy':
      if (!ready) return
      policy = msg.policy
      handlers?.onReady()
      return
    default:
      if (ready) handlers?.onMessage(msg)
  }
}

function applyMode(next: ExtMode, tab: string | null): void {
  mode = next
  feedTab = next === 'feed' ? tab : null
  void chrome.storage.session.set({ mode, feedTab }).catch(() => undefined)
  if (next === 'none') {
    // Notula isn't reading playback (Sources off, the extension off, or the device lock).
    close()
    quietUntil = Date.now() + NONE_QUIET_MS
    setConnection('off-in-notula')
    return
  }
  quietUntil = 0
  setConnection('connected')
  if (!logTimer) logTimer = setInterval(flushLog, LOG_EVERY_MS)
  handlers?.onReady()
  touchIdle()
}

function onPortDisconnect(): void {
  const error = chrome.runtime.lastError?.message ?? ''
  const wasReady = ready
  port = null
  ready = false
  stopTimers()
  const state = classify(error)
  if (wasReady && state === null && handlers?.wantsConnection() && !reconnectedOnce) {
    // The port dropped under a live session: reconnect once, then back off.
    reconnectedOnce = true
    open('retry')
    return
  }
  if (state === null) {
    // We closed it, or the host exited cleanly after an idle period.
    if (connection === 'connected' || connection === 'connecting') setConnection('idle')
    return
  }
  failed(state)
}

/** Maps the browser's port error to a popup state; null for a normal close. */
function classify(error: string): PopupConnection | null {
  if (!error) return connection === 'not-running' ? 'not-running' : null
  if (/not found/i.test(error)) return 'host-missing'
  if (/forbidden/i.test(error)) return 'host-forbidden'
  if (/exited|failed to start|communicating/i.test(error)) {
    return connection === 'not-running' ? 'not-running' : 'host-failed'
  }
  count('native:other-error')
  return 'host-failed'
}

function failed(state: PopupConnection): void {
  setConnection(state)
  const delay = BACKOFF_MS[backoff]
  backoff++
  retryTimer = clearTimer(retryTimer)
  if (delay === undefined) {
    // Backoff used up: wait for the next play to start.
    retryAt = 0
    backoff = 0
    quietUntil = 0
    return
  }
  retryAt = Date.now() + delay
  retryTimer = setTimeout(() => {
    retryTimer = null
    if (handlers?.wantsConnection()) void ensureConnected('retry')
  }, delay)
}

function stopTimers(): void {
  helloTimer = clearTimer(helloTimer)
  idleTimer = clearTimer(idleTimer)
  drainTimer = clearTimer(drainTimer)
  queue.length = 0
  if (logTimer) clearInterval(logTimer)
  logTimer = null
}

/** Closes the port on purpose (idle, mode none, a failed handshake). */
export function close(): void {
  const p = port
  port = null
  ready = false
  stopTimers()
  if (p) {
    try {
      p.disconnect()
    } catch {
      // Already gone.
    }
  }
}

function scheduleIdle(ms: number): void {
  idleTimer = clearTimer(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (handlers?.wantsConnection()) {
      touchIdle()
      return
    }
    handlers?.beforeIdleClose()
    close()
    if (connection === 'connected') setConnection('idle')
  }, ms)
}

/** Called when playback stops or changes: disconnect 120 s after the last one stops. */
export function touchIdle(): void {
  if (!port) return
  if (handlers?.wantsConnection()) {
    idleTimer = clearTimer(idleTimer)
    return
  }
  if (!idleTimer) scheduleIdle(EXT_LIMITS.idleDisconnectMs)
}

function takeToken(): boolean {
  const now = Date.now()
  tokens = Math.min(EXT_LIMITS.messagesPerSecond, tokens + ((now - tokensAt) / 1_000) * EXT_LIMITS.messagesPerSecond)
  tokensAt = now
  if (tokens < 1) return false
  tokens -= 1
  return true
}

function post(msg: ExtToNotula, force = false): boolean {
  if (!port) return false
  if (jsonBytes(msg) > MAX_FRAME_BYTES) {
    count('send:too-big')
    return false
  }
  if (!force && !takeToken()) {
    count('send:rate')
    return false
  }
  try {
    port.postMessage(msg)
    return true
  } catch {
    count('send:failed')
    return false
  }
}

/**
 * Sends one message under the mode rules: nothing but `hello` in mode `none`; `media`,
 * `media.gone`, `mark` and `log` in `candidates`; the full set in `feed`. Per-tab rules (only the
 * feed tab in `feed`) are the caller's.
 */
export function send(msg: ExtToNotula): boolean {
  if (!ready || mode === 'none') return false
  if (mode === 'candidates' && !['media', 'media.gone', 'mark', 'log'].includes(msg.type)) return false
  return post(msg, msg.type === 'mark')
}

/** Queues messages (caption parts) and sends them paced; feed mode only. */
export function sendPaced(msgs: ExtToNotula[]): boolean {
  if (!ready || mode !== 'feed') return false
  if (queue.length + msgs.length > QUEUE_MAX) {
    count('send:queue-full')
    return false
  }
  queue.push(...msgs)
  if (!drainTimer) drain()
  return true
}

function drain(): void {
  drainTimer = null
  const next = queue.shift()
  if (!next) return
  if (!ready || mode !== 'feed') {
    queue.length = 0
    return
  }
  post(next, true)
  drainTimer = setTimeout(drain, PACE_MS)
}

function flushLog(): void {
  if (!ready || mode === 'none') return
  for (const [event, n] of drainCounts()) post({ type: 'log', event, count: n }, true)
}
