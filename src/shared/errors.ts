// SPDX-License-Identifier: Apache-2.0
// IPC errors. Handlers throw `Error('<ErrorCode>: <message>')`; the renderer
// parses the code back out of the rejection with `parseError`.

export type ErrorCode =
  | 'storage-unavailable'
  | 'not-found'
  | 'invalid-input'
  | 'busy'
  | 'missing-key'
  | 'no-model'
  | 'provider-error'
  | 'internal'
  /** The device lock refused an IPC call. */
  | 'locked'

export const ERROR_CODES: readonly ErrorCode[] = [
  'storage-unavailable',
  'not-found',
  'invalid-input',
  'busy',
  'missing-key',
  'no-model',
  'provider-error',
  'internal',
  'locked'
]

export interface ParsedError {
  code: ErrorCode
  message: string
}

/** `'<code>: <message>'`. */
export function encodeError(code: ErrorCode, message: string): string {
  return `${code}: ${message}`
}

/** The Error a handler throws. */
export function notulaError(code: ErrorCode, message: string): Error {
  return new Error(encodeError(code, message))
}

const CODED = new RegExp(`(?:^|: )(${ERROR_CODES.join('|')}): ([\\s\\S]*)$`)

/**
 * Recovers `{ code, message }` from anything thrown or rejected. Electron wraps
 * invoke rejections as "Error invoking remote method '<channel>': Error: <code>: <message>",
 * so the code is searched for after any such prefix. Anything without a known
 * code becomes `internal`.
 */
export function parseError(err: unknown): ParsedError {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : String(err)
  const m = CODED.exec(text)
  if (m) return { code: m[1] as ErrorCode, message: m[2] ?? '' }
  return { code: 'internal', message: text }
}
