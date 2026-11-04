// SPDX-License-Identifier: Apache-2.0
// Courses automation, the pure parts: what a playback's recognition leads to, when a hand-started
// capture may be linked, when a lesson counts as finished (and which samples count for it), the
// per-playback rule that allows one automatic start until the lesson key or the title changes,
// the lesson key itself, the latest recognition kept while a decision is busy, when a stopped
// note may continue, and who generates notes for a course note. No Electron, no storage: the
// sources core (index.ts, feed.ts) and enhance feed them facts, and
// `scripts/dev/course-automation-check.mjs` runs them as cases.

import { BUILTIN_COURSE_HOSTS, hostIs, parseSourceUrl } from '@shared/lib/source-key'
import type { CourseBehavior, CourseConfidence, Recognition, SourceCardMode } from '@shared/types/sources'
import { GUESS_KEY_PREFIX, SOURCES_LIMITS } from '@shared/types/sources'

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
  // InPrivate and Incognito: no automatic start and no cards either. A window whose type can't be
  // told (Chrome's titles look the same either way) may show a card, but nothing starts by itself:
  // the existing Sources rule persists nothing there until the user acts.
  if (i.privateWindow === true) return { kind: 'nothing', reason: 'private' }
  const knownNormal = i.privateWindow === false
  if (i.onboarding) return { kind: 'nothing', reason: 'onboarding' }
  const rec = i.recognition
  if (!rec) return { kind: 'nothing', reason: 'not-recognized' }
  if (MATCHED.has(rec.confidence) && rec.courseId && i.behavior) {
    if (i.suppressed) return { kind: 'nothing', reason: 'suppressed' }
    if (i.capturing && !i.capturing.ownAuto) {
      // A meeting-mode note captures: offer to link it, never change it by itself.
      return i.capturing.linkable ? { kind: 'card', mode: 'link-capturing' } : { kind: 'nothing', reason: 'capturing' }
    }
    // Under the device lock, or in a window that may be private, the card asks (acting on it
    // unlocks first); nothing starts by itself.
    if (i.behavior.onPlay === 'ask' || i.locked || !knownNormal) return { kind: 'card', mode: 'course' }
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

/**
 * The lesson key for the one-start rule: the course's item when one is known, whatever its
 * canonical key (learning a URL later mustn't reopen the rule), else the identified key, else the
 * course and the lesson state.
 */
export function lessonKeyOf(rec: Pick<Recognition, 'courseId' | 'lesson'>, draftKey: string | null): string {
  if (rec.courseId && rec.lesson.itemId) return `${rec.courseId}:item:${rec.lesson.itemId}`
  if (draftKey && !draftKey.startsWith(GUESS_KEY_PREFIX)) return draftKey
  return `${rec.courseId ?? 'none'}:${rec.lesson.state}`
}

// ---------- a busy decision ----------

/**
 * One decision per playback at a time. A recognition that arrives while one runs isn't dropped:
 * the newest waits and runs when the current one ends (recognition runs once per title, so a
 * dropped one would never come again).
 */
export class LatestPerPlayback<T> {
  private readonly running = new Set<string>()
  private readonly waiting = new Map<string, T>()

  /** True when the caller may run now; otherwise `item` replaces whatever waited. */
  enter(playbackId: string, item: T): boolean {
    if (!this.running.has(playbackId)) {
      this.running.add(playbackId)
      return true
    }
    this.waiting.set(playbackId, item)
    return false
  }

  /** The run ended: the waiting item to run next (the playback stays busy), else null. */
  leave(playbackId: string): T | null {
    const next = this.waiting.get(playbackId)
    if (next === undefined) {
      this.running.delete(playbackId)
      return null
    }
    this.waiting.delete(playbackId)
    return next
  }

  clear(): void {
    this.running.clear()
    this.waiting.clear()
  }
}

// ---------- continuing after an end-of-watching stop ----------

/**
 * A note stopped at the end of watching plays again: it continues by itself only under the rules
 * of an automatic start (never in a private window, during onboarding, under the lock, over
 * another capture, or after Undo or Stop) and while its course still records video audio.
 */
export function resumeAllowed(i: {
  app: boolean
  privateWindow: boolean | 'unknown'
  onboarding: boolean
  locked: boolean
  capturing: boolean
  suppressed: 'started' | 'undone' | 'stopped' | 'answered' | null
  plan: 'captions' | 'system-audio' | 'none'
  onPlay: CourseBehavior['onPlay'] | null
}): boolean {
  if (!i.app && i.privateWindow !== false) return false
  if (i.onboarding || i.locked || i.capturing) return false
  if (i.suppressed === 'undone' || i.suppressed === 'stopped') return false
  return i.onPlay === 'record' && i.plan === 'system-audio'
}

// ---------- the samples finished detection reads ----------

/** Two durations this close are the same video. */
const SAME_DURATION_MS = 2_000

export interface FinishSample {
  /** The furthest position of the note's own lesson during this capture. */
  positionMs: number | null
  durationMs: number | null
  live: boolean
  /** The bound playback's title at its first sample; a new title is another lesson. */
  title: string | null
}

/**
 * Folds one sample of a watched playback into the note's finish sample. Only the note's own
 * lesson counts: a sample whose key isn't the note's (a course app that moved to the next lesson
 * in the same media session) counts only while its title is the one first seen, and never when
 * its duration differs from the lesson's. The furthest position is kept, so a few ticks of the
 * next lesson's 0:05 can't make a lesson watched to the end read as unfinished.
 */
export function foldFinishSample(
  prev: FinishSample,
  s: { keyMatches: boolean; title: string; positionMs: number; durationMs: number | null; live: boolean }
): FinishSample {
  if (!s.keyMatches) {
    if (prev.title !== null && s.title !== prev.title) return prev
    const known = prev.durationMs
    if (known !== null && s.durationMs !== null && s.durationMs > 0 && !s.live && Math.abs(s.durationMs - known) > SAME_DURATION_MS) return prev
  }
  return {
    positionMs: prev.positionMs === null ? s.positionMs : Math.max(prev.positionMs, s.positionMs),
    durationMs: s.durationMs !== null && s.durationMs > 0 && !s.live ? s.durationMs : prev.durationMs,
    live: prev.live || s.live,
    title: prev.title ?? s.title
  }
}

// ---------- Next item after an ad pod ----------

/**
 * When the fed note's playback ended, for the Next window. An end that follows an ad state (the
 * end → ad pod → next item shape, where the machine holds the item aside as a possible mid-roll
 * and only releases it when a long new title arrives) ended when the ads began, not when the
 * release was seen.
 */
export function playbackEndedAt(prevState: 'bound' | 'ad' | 'lost' | 'ended' | 'unbound', adSince: number | null, now: number): number {
  return prevState === 'ad' && adSince !== null && adSince <= now ? adSince : now
}

// ---------- who generates a course note's notes ----------

/**
 * A note of a registered course gets notes only through lesson notes (finished, once, enough
 * words, `on_end = notes`) or the user's own Generate notes; the general automatic generation
 * (after a stop, stop and summarize, the queue at launch) leaves it alone. Every other note keeps
 * it, source notes outside Courses included.
 */
export function generalAutoGeneration(n: { seriesId: string | null; seriesRegistered: boolean }): boolean {
  return !(n.seriesId !== null && n.seriesRegistered)
}
