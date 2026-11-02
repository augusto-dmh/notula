// SPDX-License-Identifier: Apache-2.0
// Starts main asked for and then took back. Main's start (`startFromMain`) reads settings before
// it reaches the gates, so a cancel can arrive before there is anything pending to cancel. The
// cancel is remembered for a short while and refuses that note's main start when it arrives, so
// nothing begins after Courses' Undo or Stop, and never on a note Undo deleted. Pure, so
// `scripts/dev/course-automation-check.mjs` runs it.

/** Long enough for a start still reading its settings; short enough to never block a later one. */
export const CANCELLED_START_MS = 10_000

export class CancelledStarts {
  private readonly until = new Map<string, number>()

  cancel(noteId: string, now: number): void {
    this.until.set(noteId, now + CANCELLED_START_MS)
    for (const [id, t] of this.until) if (t <= now) this.until.delete(id)
  }

  /** True when a main start of `noteId` was cancelled moments ago; the mark is used up. */
  take(noteId: string, now: number): boolean {
    const t = this.until.get(noteId)
    if (t === undefined) return false
    this.until.delete(noteId)
    return t > now
  }
}
