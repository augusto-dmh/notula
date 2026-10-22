// SPDX-License-Identifier: Apache-2.0
// Generation failures carry an EnhanceErrorCode (shared/types/enhance.ts), stored on
// the panel as `enhance_error` and pushed as the `error` event's code.

import type { EnhanceErrorCode } from '@shared/types/enhance'

export class EnhanceError extends Error {
  constructor(
    readonly code: EnhanceErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'EnhanceError'
  }
}

export function enhanceError(code: EnhanceErrorCode, message: string): EnhanceError {
  return new EnhanceError(code, message)
}

/** Anything thrown during a generation, as a code and a user-safe message. */
export function toEnhanceError(err: unknown): EnhanceError {
  if (err instanceof EnhanceError) return err
  if (err instanceof Error && err.name === 'AbortError') return new EnhanceError('timeout', 'The AI provider stopped responding.')
  const message = err instanceof Error ? err.message : String(err)
  return new EnhanceError('provider-error', message || 'The AI provider returned an error.')
}
