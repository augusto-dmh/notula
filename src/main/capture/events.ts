// SPDX-License-Identifier: Apache-2.0
// Validation of `capture:event` payloads from the renderer engine. Every
// field is checked and rebuilt before the controller sees it: a bad `source` used
// to throw inside the IPC listener, and `log` events wrote arbitrary renderer data
// to app.log. Engine log lines are also rate-limited.

import type { CaptureEngineEvent, InputDevice } from '@shared/types/capture'
import type { AudioSource } from '@shared/types/common'

const SOURCES: readonly AudioSource[] = ['microphone', 'system']
const LOG_LEVELS = ['info', 'warn', 'error'] as const
/** A 100 ms batch is 3,200 bytes; anything far above is not audio from our worklet. */
const MAX_PCM_BYTES = 64 * 1024
const MAX_DEVICES = 64
const MAX_TEXT = 500
const MAX_LOG_FIELDS = 20
const LOG_EVENT = /^[a-z0-9][a-z0-9:._-]{0,63}$/i
const LOG_WINDOW_MS = 10_000
const LOG_MAX_PER_WINDOW = 30

type Fields = Record<string, unknown>

function source(v: unknown): AudioSource | null {
  return SOURCES.includes(v as AudioSource) ? (v as AudioSource) : null
}

function text(v: unknown): string | null {
  return typeof v === 'string' ? v.slice(0, MAX_TEXT) : null
}

function textOrNull(v: unknown): string | null | undefined {
  if (v === null) return null
  return typeof v === 'string' ? v.slice(0, MAX_TEXT) : undefined
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function device(v: unknown): InputDevice | null {
  if (!v || typeof v !== 'object') return null
  const d = v as Fields
  const deviceId = text(d['deviceId'])
  const groupId = text(d['groupId'])
  const label = text(d['label'])
  if (deviceId === null || groupId === null || label === null || typeof d['isDefault'] !== 'boolean') return null
  return { deviceId, groupId, label, isDefault: d['isDefault'] }
}

function logData(v: unknown): Record<string, string | number | boolean> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, string | number | boolean> = {}
  for (const [k, value] of Object.entries(v as Fields).slice(0, MAX_LOG_FIELDS)) {
    if (!LOG_EVENT.test(k)) continue
    if (typeof value === 'string') out[k] = value.slice(0, MAX_TEXT)
    else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) out[k] = value
  }
  return out
}

/** The event rebuilt from checked fields, or null when it is malformed. */
export function parseEngineEvent(raw: unknown): CaptureEngineEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Fields
  switch (e['type']) {
    case 'initialized':
    case 'stopped':
      return { type: e['type'] }
    case 'started': {
      const sources = Array.isArray(e['sources']) ? e['sources'].map(source) : null
      if (!sources || sources.some((s) => s === null)) return null
      return { type: 'started', sources: [...new Set(sources as AudioSource[])] }
    }
    case 'start-failed': {
      const error = text(e['error'])
      return error === null ? null : { type: 'start-failed', error }
    }
    case 'buffer': {
      const s = source(e['source'])
      const pcm = e['pcm']
      const captureTimeMs = finite(e['captureTimeMs'])
      if (!s || !(pcm instanceof Uint8Array) || pcm.byteLength > MAX_PCM_BYTES || captureTimeMs === null) return null
      return { type: 'buffer', source: s, pcm, captureTimeMs }
    }
    case 'volume': {
      const s = source(e['source'])
      const rms = finite(e['rms'])
      return s && rms !== null ? { type: 'volume', source: s, rms: Math.max(rms, 0) } : null
    }
    case 'source-error': {
      const s = source(e['source'])
      const name = text(e['name'])
      const message = text(e['message'])
      return s && name !== null && message !== null ? { type: 'source-error', source: s, name, message } : null
    }
    case 'devices': {
      if (!Array.isArray(e['devices']) || e['devices'].length > MAX_DEVICES) return null
      const devices = e['devices'].map(device)
      return devices.some((d) => d === null) ? null : { type: 'devices', devices: devices as InputDevice[] }
    }
    case 'active-device': {
      const deviceId = textOrNull(e['deviceId'])
      const label = textOrNull(e['label'])
      const requested = e['requestedDeviceId'] === undefined ? null : textOrNull(e['requestedDeviceId'])
      if (deviceId === undefined || label === undefined || requested === undefined) return null
      return { type: 'active-device', deviceId, label, requestedDeviceId: requested }
    }
    case 'system-source': {
      const label = textOrNull(e['label'])
      return label === undefined ? null : { type: 'system-source', label }
    }
    case 'restart-request':
      return e['scope'] === 'all' ? { type: 'restart-request', scope: 'all' } : null
    case 'log': {
      const level = LOG_LEVELS.find((l) => l === e['level'])
      const event = e['event']
      if (!level || typeof event !== 'string' || !LOG_EVENT.test(event)) return null
      const data = logData(e['data'])
      return { type: 'log', level, event, ...(data ? { data } : {}) }
    }
    default:
      return null
  }
}

/** At most 30 engine log lines per 10 s; the rest are counted and reported once. */
export class EngineLogLimiter {
  private windowStart = 0
  private count = 0
  private suppressed = 0

  /** True when this line may be written. `onResume` reports what the last window dropped. */
  allow(onResume: (suppressed: number) => void): boolean {
    const now = Date.now()
    if (now - this.windowStart >= LOG_WINDOW_MS) {
      if (this.suppressed) onResume(this.suppressed)
      this.windowStart = now
      this.count = 0
      this.suppressed = 0
    }
    if (this.count >= LOG_MAX_PER_WINDOW) {
      this.suppressed++
      return false
    }
    this.count++
    return true
  }
}
