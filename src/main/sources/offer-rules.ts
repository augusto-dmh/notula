// SPDX-License-Identifier: Apache-2.0
// The source card's pure rules for videos outside Courses (offer.ts), kept apart so the dev
// harness (scripts/dev/media-replay.mjs) checks them without Electron:
// - quiet windows per card outcome and key: Skip 12 h; ignored (the card expired) 30 min, 12 h
//   after the second ignore; noted (Take notes, Continue, Switch note) 10 min, so Continue comes
//   at most once per 10 min;
// - Next item through ads: the window counts play time only, leaving out the time ad-like items
//   played (items under the 120 s floor between the end and the next item), with a hard cap of
//   5 min from the end;
// - long ads: no guess card while the playing tab looks like a YouTube watch page, and a guess
//   card only after 2 min with no match.

import { isVideoSite } from '../media/lines'
import type { Playback } from '@shared/types/sources'
import { SOURCES_LIMITS } from '@shared/types/sources'

export const QUIET_MS = {
  skipped: 12 * 60 * 60 * 1_000,
  ignoredFirst: 30 * 60 * 1_000,
  ignoredRepeat: 12 * 60 * 60 * 1_000,
  noted: 10 * 60 * 1_000
} as const

/** Next item: the hard cap from the end, whatever the ads. */
export const NEXT_CAP_MS = 5 * 60 * 1_000
/** A guess card waits this long after identification for a better match. */
export const GUESS_WAIT_MS = 2 * 60 * 1_000
/** Ad-like intervals are kept this long (past the Next cap). */
const AD_KEEP_MS = NEXT_CAP_MS + 60_000

export type CardOutcome = 'shown' | 'skipped' | 'ignored' | 'noted'

/** A key's last card and what became of it. */
export interface KeyRecord {
  outcome: CardOutcome
  at: number
  /** Expired cards of this key so far. */
  ignores: number
}

/** How long a key stays quiet after its record. A card still showing keeps it quiet too. */
export function quietMs(r: KeyRecord | undefined): number {
  if (!r) return 0
  switch (r.outcome) {
    case 'shown':
      return SOURCES_LIMITS.cardLifetimeMs + 5_000
    case 'skipped':
      return QUIET_MS.skipped
    case 'ignored':
      return r.ignores >= 2 ? QUIET_MS.ignoredRepeat : QUIET_MS.ignoredFirst
    case 'noted':
      return QUIET_MS.noted
  }
}

export function isQuiet(r: KeyRecord | undefined, now: number): boolean {
  return !!r && now - r.at < quietMs(r)
}

/** The record after an outcome. */
export function recordOutcome(prev: KeyRecord | undefined, outcome: CardOutcome, now: number): KeyRecord {
  const ignores = (prev?.ignores ?? 0) + (outcome === 'ignored' ? 1 : 0)
  return { outcome, at: now, ignores }
}

/** An item that played between two videos and reads as an ad: under the 120 s floor, or the machine's ad flag. */
export function isAdLike(p: Pick<Playback, 'ad' | 'durationMs' | 'live' | 'state'>): boolean {
  if (p.ad) return true
  if (p.live || p.state === 'candidate' || p.state === 'muted') return false
  return p.durationMs !== null && p.durationMs < SOURCES_LIMITS.minDurationMs
}

/** Per browser, the wall-clock intervals ad-like items were present. */
export class AdLedger {
  private readonly open = new Map<string, { browser: string; start: number }>()
  private readonly done: { browser: string; start: number; end: number }[] = []

  /** One provider snapshot: ad-like items start and stop being present. */
  apply(playbacks: readonly Pick<Playback, 'id' | 'browser' | 'ad' | 'durationMs' | 'live' | 'state' | 'seenAt' | 'app'>[], now: number): void {
    const present = new Set<string>()
    for (const p of playbacks) {
      if (p.state === 'ended' || p.app) continue
      if (!isAdLike(p)) {
        // Turned out real (the 120 s floor passed, it became a candidate): not an ad.
        this.open.delete(p.id)
        continue
      }
      present.add(p.id)
      if (!this.open.has(p.id)) this.open.set(p.id, { browser: p.browser, start: Math.min(now, p.seenAt ?? now) })
    }
    for (const [id, o] of [...this.open]) {
      if (present.has(id)) continue
      this.open.delete(id)
      this.done.push({ browser: o.browser, start: o.start, end: now })
    }
    while (this.done.length && now - (this.done[0] as { end: number }).end > AD_KEEP_MS) this.done.shift()
  }

  /** Ad time in `browser` between `from` and `to` (overlaps merged). */
  adMsBetween(browser: string, from: number, to: number): number {
    const parts = this.done
      .filter((d) => d.browser === browser)
      .map((d) => [Math.max(from, d.start), Math.min(to, d.end)] as const)
      .filter(([a, b]) => b > a)
      .sort((x, y) => x[0] - y[0])
    let total = 0
    let reach = from
    for (const [a, b] of parts) {
      const start = Math.max(a, reach)
      if (b > start) total += b - start
      reach = Math.max(reach, b)
    }
    return total
  }

  clear(): void {
    this.open.clear()
    this.done.length = 0
  }
}

/**
 * Next item: started after the fed note's playback ended (a little slack for a start just
 * before), within 30 s of play time not counting ads, and within 5 min of the end.
 */
export function withinNextWindow(endedAt: number, startedAt: number, adMs: number, slackMs: number): boolean {
  if (startedAt < endedAt - slackMs) return false
  const gap = startedAt - endedAt
  if (gap > NEXT_CAP_MS) return false
  return gap - adMs <= SOURCES_LIMITS.nextItemWindowMs
}

/**
 * A guess card's gate: `hold` while the playing tab looks like a YouTube watch page (its site is
 * YouTube-like, or a browser tab whose name didn't match the session title: an ad over a watch
 * page), or less than 2 min after identification; else `go`.
 */
export function guessGate(p: Pick<Playback, 'site' | 'app' | 'url'>, draftSite: string | null, identifiedAt: number, now: number): 'hold' | 'go' {
  const site = draftSite ?? p.site
  const watchPage = isVideoSite(site) || (!p.app && !p.site && !p.url)
  if (watchPage) return 'hold'
  return now - identifiedAt >= GUESS_WAIT_MS ? 'go' : 'hold'
}
