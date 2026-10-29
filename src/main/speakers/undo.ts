// SPDX-License-Identifier: Apache-2.0
// The naming Undo window: only the word write happens at once. The
// destructive side effects of naming, Skip, Not <name> and Remove sample (the cluster vector's
// deletion, the sample, the relabel fan-out, the cap trimming) wait until the 10 s window
// closes. Undo inside the window restores the words and cancels them all. If Notula quits
// inside the window, they run at quit.

import { randomUUID } from 'node:crypto'
import { SPEAKER_PROFILE_LIMITS } from '@shared/types/speakers'
import { log } from '../log'

export interface Undoable {
  /** The deferred effects: run once, when the window closes or at quit. Idempotent. */
  apply(): Promise<void>
  /** Undo inside the window: restores what the immediate write changed (through the label-write queue). */
  revert(): Promise<void>
}

interface Open {
  effects: Undoable
  timer: ReturnType<typeof setTimeout>
}

/** Windows still open, by token. */
const open = new Map<string, Open>()
/** Effects running now (a closed window), so `flushAll` waits for them too. */
const running = new Set<Promise<void>>()

function run(token: string): Promise<void> {
  const o = open.get(token)
  if (!o) return Promise.resolve()
  open.delete(token)
  clearTimeout(o.timer)
  const p = o.effects
    .apply()
    .catch((err: unknown) => log('warn', 'speakers:undo-effects-failed', { err }))
    .finally(() => running.delete(p))
  running.add(p)
  return p
}

/**
 * Registers the effects and returns the token for `speaker-names:undo`. `ms` (default the Undo
 * window) is for a longer deferral that must still run at quit.
 */
export function deferUndoable(effects: Undoable, ms: number = SPEAKER_PROFILE_LIMITS.undoWindowMs): string {
  const token = randomUUID()
  const timer = setTimeout(() => void run(token), ms)
  // An open window never keeps the process alive: quit flushes it.
  timer.unref?.()
  open.set(token, { effects, timer })
  return token
}

/** Resolves true when the window was still open and everything was restored. */
export async function undo(token: string): Promise<boolean> {
  const o = open.get(token)
  if (!o) return false
  open.delete(token)
  clearTimeout(o.timer)
  try {
    await o.effects.revert()
    return true
  } catch (err) {
    // The deferred effects stay cancelled; the words keep the naming.
    log('warn', 'speakers:undo-failed', { err })
    return false
  }
}

/** Windows still open or effects still running. */
export function hasPendingUndo(): boolean {
  return open.size > 0 || running.size > 0
}

/** At quit: runs every pending effect now. */
export async function flushAll(): Promise<void> {
  const tokens = [...open.keys()]
  if (tokens.length) log('info', 'speakers:undo-flush', { pending: tokens.length })
  for (const t of tokens) await run(t)
  await Promise.allSettled([...running])
}
