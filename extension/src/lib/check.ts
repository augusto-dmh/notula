// SPDX-License-Identifier: Apache-2.0
// Small validators. Every message that crosses a boundary (native port, runtime messages,
// window.postMessage from the page's world) is rebuilt from known keys with these, never trusted
// as is. A failed check returns undefined and the caller drops the whole message.

export type Obj = Record<string, unknown>

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A string, cut to `max` characters. */
export function str(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined
  return v.length > max ? v.slice(0, max) : v
}

export function strOrNull(v: unknown, max: number): string | null | undefined {
  if (v === null) return null
  return str(v, max)
}

/** A finite number within [min, max]. */
export function num(v: unknown, min = -Infinity, max = Infinity): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return undefined
  return v
}

export function numOrNull(v: unknown, min = -Infinity, max = Infinity): number | null | undefined {
  if (v === null) return null
  return num(v, min, max)
}

export function int(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const n = num(v, min, max)
  return n !== undefined && Number.isInteger(n) ? n : undefined
}

export function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

export function oneOf<T extends string>(v: unknown, values: readonly T[]): T | undefined {
  return typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T) : undefined
}

const encoder = new TextEncoder()

/** UTF-8 size of a value once serialized to JSON. */
export function jsonBytes(v: unknown): number {
  return encoder.encode(JSON.stringify(v)).length
}

/** Collapses whitespace and trims; page text often carries layout newlines. */
export function clean(v: string | null | undefined, max = 300): string | null {
  if (!v) return null
  const s = v.replace(/\s+/g, ' ').trim()
  if (!s) return null
  return s.length > max ? s.slice(0, max) : s
}
