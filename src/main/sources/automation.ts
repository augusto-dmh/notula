// SPDX-License-Identifier: Apache-2.0
// Courses automation, the pure parts: what a playback's recognition leads to, when a hand-started
// capture may be linked, when a lesson counts as finished, and the per-playback rule that allows
// one automatic start until the lesson key or the title changes. No Electron, no storage: the
// sources core (index.ts, feed.ts) feeds them facts, and `scripts/dev/course-automation-check.mjs`
// runs them as cases.

import { BUILTIN_COURSE_HOSTS, hostIs, parseSourceUrl } from '@shared/lib/source-key'
import type { CourseBehavior, CourseConfidence, Recognition, SourceCardMode } from '@shared/types/sources'
import { SOURCES_LIMITS } from '@shared/types/sources'

// ---------- the decision per playback ----------

/** The capture running when a lesson starts. */
export interface CapturingNote {
  noteId: string
  /** This playback's own automatic note (the next lesson moves capture along). */
  ownAuto: boolean
  /** Started by hand within `LINK_WINDOW_MS`, no calendar event, no source (`qualifiesForLink`). */
  linkable: boolean
}

export interface DecisionInput {
  recognition: Recognition | null
  /** The recognized course's behavior; null when no course matched. */
  behavior: CourseBehavior | null
  /** An unmapped course app, a known course host, or a Circle or Hubla lesson URL. */
  courseLike: boolean
  privateWindow: boolean | 'unknown'
  onboarding: boolean
  locked: boolean
  capturing: CapturingNote | null
  /** Undo or Stop happened for this playback's key and title, or it already started once. */
  suppressed: boolean
}

export type Decision =
  | { kind: 'auto-start' }
  | { kind: 'card'; mode: Extract<SourceCardMode, 'course' | 'add-course' | 'link-capturing' | 'which-course'> }
  /** Today's Sources offer (videos outside Courses). */
  | { kind: 'offer' }
  | { kind: 'nothing'; reason: 'private' | 'onboarding' | 'capturing' | 'suppressed' | 'not-recognized' }

const MATCHED: ReadonlySet<CourseConfidence> = new Set(['exact', 'title', 'app'])

/** One recognition → what happens (behavior §4.5.1, §4.5.5–6, §4.9.7, §4.9.9). */
export function decide(i: DecisionInput): Decision {
  // InPrivate and Incognito: no automatic start and no cards either (the existing Sources rule).
  if (i.privateWindow !== false) return { kind: 'nothing', reason: 'private' }
  if (i.onboarding) return { kind: 'nothing', reason: 'onboarding' }
  const rec = i.recognition
  if (!rec) return { kind: 'nothing', reason: 'not-recognized' }
  if (MATCHED.has(rec.confidence) && rec.courseId && i.behavior) {
    if (i.suppressed) return { kind: 'nothing', reason: 'suppressed' }
    if (i.capturing && !i.capturing.ownAuto) {
      // A meeting-mode note captures: offer to link it, never change it by itself.
      return i.capturing.linkable ? { kind: 'card', mode: 'link-capturing' } : { kind: 'nothing', reason: 'capturing' }
    }
    // Under the device lock the card asks (acting on it unlocks first); nothing starts by itself.
    if (i.behavior.onPlay === 'ask' || i.locked) return { kind: 'card', mode: 'course' }
    return { kind: 'auto-start' }
  }
  if (rec.confidence === 'ambiguous') {
    if (i.suppressed) return { kind: 'nothing', reason: 'suppressed' }
    if (i.capturing && !i.capturing.ownAuto && !i.capturing.linkable) return { kind: 'nothing', reason: 'capturing' }
    return { kind: 'card', mode: 'which-course' }
  }
  return i.courseLike ? { kind: 'card', mode: 'add-course' } : { kind: 'offer' }
}

/** Course-like, outside Courses: an unmapped course app, a known course host, or a Circle or Hubla lesson URL. */
export function isCourseLike(p: { app: boolean; url: string | null; site: string | null }, courseHosts: readonly string[] = []): boolean {
  if (p.app) return true
  const hosts = [...BUILTIN_COURSE_HOSTS, ...courseHosts]
  const known = (h: string | null): boolean => !!h && hosts.some((c) => hostIs(h, c.toLowerCase()))
  if (known(p.site)) return true
  const parsed = p.url ? parseSourceUrl(p.url) : null
  if (!parsed) return false
  if (known(parsed.host)) return true
  if (parsed.provider === 'circle' && parsed.kind === 'lesson') return true
  if (hostIs(parsed.host, 'hub.la')) {
    try {
      return /^\/m\/[^/]+\/p\/[^/]+/.test(new URL(parsed.url).pathname)
    } catch {
      return false
    }
  }
  return false
}

// ---------- Link this note ----------

/** A hand-started capture this recent may be linked to a lesson. */
export const LINK_WINDOW_MS = 5 * 60_000

/** Started by hand in the last 5 minutes, with no calendar event and no source (§4.5.5). */
export function qualifiesForLink(n: { captureStartedAt: number | null; hasEvent: boolean; hasSource: boolean; byHand: boolean }, now: number): boolean {
  if (!n.byHand || n.hasEvent || n.hasSource || n.captureStartedAt === null) return false
  return now - n.captureStartedAt <= LINK_WINDOW_MS
}

// ---------- finished ----------

/** The session ended this close to the end: finished. */
export const FINISHED_TAIL_MS = 60_000
/** A live playback watched this long, then ended: finished. */
export const LIVE_FINISHED_MS = 10 * 60_000

export interface FinishInput {
  durationMs: number | null
  live: boolean
  /** The newest known position. */
  positionMs: number | null
  /** The session ended (gone), not merely paused. */
  ended: boolean
  /** Accumulated watched time of this note's spans. */
  watchedMs: number
}

/** Position ≥ 90 % of the duration, or ended in the last 60 s; live: ended after ≥ 10 min watched (§4.8.2). */
export function isFinished(f: FinishInput): boolean {
  if (f.live || f.durationMs === null || f.durationMs <= 0) return f.ended && f.watchedMs >= LIVE_FINISHED_MS
  if (f.positionMs === null) return false
  if (f.positionMs >= (f.durationMs * SOURCES_LIMITS.finishedPercent) / 100) return true
  return f.ended && f.durationMs - f.positionMs <= FINISHED_TAIL_MS
}

// ---------- one automatic start per playback ----------

interface Mark {
  key: string
  title: string
  reason: 'started' | 'undone' | 'stopped' | 'answered'
}

/**
 * One automatic start per playback; none again after Undo or Stop until its lesson key or its
 * title changes. Memory only.
 */
export class AutoSuppression {
  private readonly marks = new Map<string, Mark>()

  /** False while this playback, with this key and title, already started or was undone or stopped. */
  allowed(playbackId: string, key: string, title: string): boolean {
    const m = this.marks.get(playbackId)
    return !m || m.key !== key || m.title !== title
  }

  mark(playbackId: string, key: string, title: string, reason: Mark['reason']): void {
    this.marks.set(playbackId, { key, title, reason })
    if (this.marks.size > 200) this.marks.delete(this.marks.keys().next().value as string)
  }

  reason(playbackId: string): Mark['reason'] | null {
    return this.marks.get(playbackId)?.reason ?? null
  }

  forget(playbackId: string): void {
    this.marks.delete(playbackId)
  }

  clear(): void {
    this.marks.clear()
  }
}
