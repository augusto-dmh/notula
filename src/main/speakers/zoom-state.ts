// SPDX-License-Identifier: Apache-2.0
// How well the Zoom reader is doing, for the local log only: each record sorts into one state,
// a change is logged once it held 9 s, and the time in each state is summed for one line per
// call. No names, no telemetry; no label or band reads it. Pure: attribution.ts logs.

import { ATTRIBUTION_LIMITS } from '@shared/types/transcript'

/** The record's refusal classes that still mean "nobody is talking": the marker read the view. */
const IDLE_REFUSALS = new Set(['idle', 'window', 'version'])

/**
 * `naming:<method>` (`naming-self:<method>` when it named the user), `one-remote`, `idle` or
 * `refused:<class>`.
 */
export function zoomStateOf(r: {
  speaker: boolean
  speakerIsSelf: boolean
  method: string | null
  refusal: string | null
  oneRemote: boolean
}): string {
  if (r.speaker) return `${r.speakerIsSelf ? 'naming-self' : 'naming'}:${r.method ?? 'unknown'}`
  if (r.oneRemote) return 'one-remote'
  if (r.refusal === null || IDLE_REFUSALS.has(r.refusal)) return 'idle'
  return `refused:${r.refusal}`
}

export class ZoomStateLog {
  private shown: string | null = null
  private pending: { state: string; since: number } | null = null
  private last: { state: string; at: number } | null = null
  private totals = new Map<string, number>()
  private maxPeople = 0

  reset(): void {
    this.shown = null
    this.pending = null
    this.last = null
    this.totals.clear()
    this.maxPeople = 0
  }

  /** One record. Returns the change to log, once the new state has held long enough. */
  record(state: string, at: number, count: number | null): { from: string | null; to: string } | null {
    if (count !== null && count > this.maxPeople) this.maxPeople = count
    if (this.last) {
      const gap = Math.max(0, at - this.last.at)
      // A long gap (the reader stalled, the window went away) drops a pending change.
      if (gap > ATTRIBUTION_LIMITS.zoomStateGapMs) this.pending = null
      this.totals.set(this.last.state, (this.totals.get(this.last.state) ?? 0) + Math.min(gap, ATTRIBUTION_LIMITS.zoomStateGapMs))
    }
    this.last = { state, at }
    if (state === this.shown) {
      this.pending = null
      return null
    }
    if (!this.pending || this.pending.state !== state) this.pending = { state, since: at }
    if (at - this.pending.since < ATTRIBUTION_LIMITS.zoomStateHoldMs) return null
    const from = this.shown
    this.shown = state
    this.pending = null
    return { from, to: state }
  }

  /** The call's times per state (ms) and its highest participant count; null when no record came. */
  summary(): { times: Record<string, number>; maxPeople: number } | null {
    if (!this.last) return null
    return { times: Object.fromEntries([...this.totals].sort((a, b) => b[1] - a[1])), maxPeople: this.maxPeople }
  }
}
