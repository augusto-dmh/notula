// SPDX-License-Identifier: Apache-2.0
// The rename-and-shift step of the log rotation, kept free of Electron so a dev check can
// run it on a temp folder. `app.log` becomes `app.1.log`, `app.1.log` becomes `app.2.log`
// and so on; the file beyond `keep` is dropped first.

import { existsSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** `app.log` rotates once it reaches this size. */
export const LOG_ROTATE_BYTES = 5 * 1024 * 1024
/** Rotated files kept next to the current one. */
export const LOG_KEEP = 3

const rotated = (dir: string, base: string, n: number): string => join(dir, `${base}.${n}.log`)

/**
 * Rotates `<base>.log` in `dir`. Returns false, without throwing, when any step fails.
 * Only the files up to the first free slot shift, and the oldest drops only when every
 * slot is taken, so a failed attempt never costs a kept file on the next one. It stops at
 * the first failure, and `<base>.log` stays in place unless its slot was freed.
 */
export function rotateLogFiles(dir: string, base = 'app', keep = LOG_KEEP): boolean {
  try {
    const current = join(dir, `${base}.log`)
    if (!existsSync(current)) return false
    let free = 1
    while (free <= keep && existsSync(rotated(dir, base, free))) free++
    if (free > keep) {
      free = keep
      unlinkSync(rotated(dir, base, keep))
    }
    for (let n = free - 1; n >= 1; n--) renameSync(rotated(dir, base, n), rotated(dir, base, n + 1))
    renameSync(current, rotated(dir, base, 1))
    return true
  } catch {
    return false
  }
}

/** At open: rotates `<base>.log` only once it has reached `cap` bytes. A missing file is under it. */
export function rotateIfFull(dir: string, cap = LOG_ROTATE_BYTES, base = 'app', keep = LOG_KEEP): 'under' | 'rotated' | 'failed' {
  let size = 0
  try {
    size = statSync(join(dir, `${base}.log`)).size
  } catch {
    return 'under'
  }
  if (size < cap) return 'under'
  return rotateLogFiles(dir, base, keep) ? 'rotated' : 'failed'
}
