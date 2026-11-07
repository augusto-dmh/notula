// SPDX-License-Identifier: Apache-2.0
// Where the foreground app and title come from, and how long a screenshot waits for them. Pure,
// so scripts/dev/helpers-check.ts can check it.
//
// The key hook's process answers while it is up and ready (Windows): one window read, no ops
// script. Otherwise the desk helper's ops script does. A warm script, or macOS (one osascript per
// op), gets the usual short wait. A cold script needs its start first: the wait then covers it,
// bounded, because the read has to happen before the grab's overlay takes the foreground.

/** The usual wait for the foreground app and title. */
export const FOREGROUND_MS = 500
/** The longest wait when the ops script has to start first. */
export const FOREGROUND_COLD_MS = 3_000

export function foregroundRoute(o: { platform: string; hookReady: boolean; opsUp: boolean }): { via: 'hook' | 'desk'; waitMs: number } {
  if (o.platform !== 'win32') return { via: 'desk', waitMs: FOREGROUND_MS }
  if (o.hookReady) return { via: 'hook', waitMs: FOREGROUND_MS }
  return { via: 'desk', waitMs: o.opsUp ? FOREGROUND_MS : FOREGROUND_COLD_MS }
}
