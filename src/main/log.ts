// SPDX-License-Identifier: Apache-2.0
// Local diagnostics only (no telemetry). Appends JSON lines to
// `<userData>/logs/app.log`. Secret-looking fields are redacted at any depth,
// so a key never reaches the file, but callers still must not log secrets.
//
// `debug` lines are written by development builds always, and by packaged
// builds only while detailed logging is on (`setVerboseLogging`, which diagnostics calls at
// startup and on `diagnostics.verboseLogging` changes).

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const REDACTED_FIELD = /^(key|token|authorization|api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token)$/i
const MAX_DEPTH = 6

let stream: WriteStream | null = null
/** Packaged builds drop `debug` lines unless this is on. */
let verbose = false

/** Detailed logging in packaged builds. Development builds always write debug lines. */
export function setVerboseLogging(on: boolean): void {
  verbose = on
}

function open(): WriteStream {
  if (stream) return stream
  // Resolved lazily: index.ts moves userData to Notula-dev before anything logs.
  const dir = join(app.getPath('userData'), 'logs')
  mkdirSync(dir, { recursive: true })
  stream = createWriteStream(join(dir, 'app.log'), { flags: 'a' })
  stream.on('error', () => {
    stream = null
  })
  return stream
}

function redact(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack }
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? value.toString() : value
  }
  if (value instanceof Uint8Array) return `[${value.byteLength} bytes]`
  if (seen.has(value) || depth >= MAX_DEPTH) return '[…]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, seen))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACTED_FIELD.test(k) ? '[redacted]' : redact(v, depth + 1, seen)
  }
  return out
}

export function log(level: LogLevel, event: string, data?: Record<string, unknown>): void {
  if (level === 'debug' && !verbose && app.isPackaged) return
  const line = {
    t: new Date().toISOString(),
    level,
    event,
    ...(data ? { data: redact(data, 0, new WeakSet()) } : {})
  }
  const text = JSON.stringify(line)
  if (!app.isPackaged) {
    if (level === 'error') console.error(text)
    else if (level === 'warn') console.warn(text)
    else console.log(text)
  }
  try {
    open().write(text + '\n')
  } catch {
    // Logging must never take the app down.
  }
}
