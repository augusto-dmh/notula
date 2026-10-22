// SPDX-License-Identifier: Apache-2.0
// Time without system sleep, for the stop drain's budgets: a drain cut short by a sleep
// is finished on resume.
//
// Wall-clock deadlines taken before a sleep are all past on wake, and on Windows the
// timers that waited through the freeze fire first after it. Here every read compares
// the wall clock with the last sign of life, and a heartbeat runs while any budget or
// timer is held, so a jump can only be a freeze (or a stalled main thread). The jump is
// left out: a sleep costs a drain at most one beat of its budget.

const BEAT_MS = 500
/** A gap between two signs of life this long is a freeze, not a busy turn. */
const JUMP_MS = 5_000

let frozenMs = 0
let lastSeen = Date.now()
let holders = 0
let freezes = 0
let beat: ReturnType<typeof setInterval> | null = null

/** Wall-clock ms minus every freeze seen while something was measuring. */
export function awakeNow(): number {
  const now = Date.now()
  const gap = now - lastSeen
  if (holders > 0 && gap > JUMP_MS) {
    frozenMs += gap - BEAT_MS
    freezes++
  } else if (gap < 0) {
    // The wall clock was set back: awake time stands still instead of running backwards.
    frozenMs += gap
  }
  lastSeen = now
  return now - frozenMs
}

function hold(): () => void {
  if (holders++ === 0) {
    lastSeen = Date.now()
    beat = setInterval(awakeNow, BEAT_MS)
    beat.unref()
  }
  let released = false
  return () => {
    if (released) return
    released = true
    if (--holders === 0 && beat) {
      clearInterval(beat)
      beat = null
    }
  }
}

/** A time budget that does not run while the system sleeps. */
export class AwakeBudget {
  private readonly release = hold()
  private readonly freezesAtStart = freezes
  private readonly end: number

  constructor(ms: number) {
    this.end = awakeNow() + ms
  }

  /** Awake ms left; negative once spent. */
  left(): number {
    return this.end - awakeNow()
  }

  /** The system slept since the budget started. */
  sawFreeze(): boolean {
    awakeNow()
    return freezes > this.freezesAtStart
  }

  done(): void {
    this.release()
  }
}

/** Calls `fn` after `ms` of awake time. Returns the cancel. */
export function awakeTimer(ms: number, fn: () => void): () => void {
  const release = hold()
  const end = awakeNow() + ms
  let t: ReturnType<typeof setTimeout> | null = null
  const check = (): void => {
    const left = end - awakeNow()
    if (left > 0) {
      t = setTimeout(check, left)
      return
    }
    t = null
    release()
    fn()
  }
  t = setTimeout(check, Math.max(0, ms))
  return () => {
    if (t) clearTimeout(t)
    t = null
    release()
  }
}

/** Resolves when `p` settles or after `ms` of awake time, whichever comes first. */
export function withAwakeTimeout(p: Promise<unknown>, ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const cancel = awakeTimer(ms, resolve)
    p.then(
      () => {
        cancel()
        resolve()
      },
      () => {
        cancel()
        resolve()
      }
    )
  })
}
