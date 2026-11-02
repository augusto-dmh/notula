// SPDX-License-Identifier: Apache-2.0
// Recognition: which course in Courses a playback belongs to, and which lesson of it. A pure
// function from local signals to a `Recognition`, next to the media state machine; it reads
// nothing and stores nothing. Only courses in Courses are matched; everything else falls to the
// Sources card.
//
// Not written yet: every playback is recognized as `none`.

import type { AppMapping, CanonicalKey, CatalogItem, LessonRead, Recognition, SourceSeries } from '@shared/types/sources'

/** The signals of one playback (S1–S7). Each is null when unknown or not read. */
export interface Signals {
  /** S1: the app id and its mapping (course apps); null for a browser window. */
  app: { appUserModelId: string; mapping: AppMapping | null } | null
  /** S2: the session's title and artist. */
  session: { title: string; artist: string | null }
  /** S3: the course app's window title, or the browser tab's name. */
  windowTitle: string | null
  /** S4: duration and position; `durationMs` null for a live playback. */
  timing: { durationMs: number | null; positionMs: number | null; live: boolean }
  /** S5: the newest lesson-URL visit in History, for a granted host. */
  history: { url: string; canonicalKey: CanonicalKey | null } | null
  /** S6: the playing tab's address bar (browsers only). */
  addressBar: { url: string; canonicalKey: CanonicalKey | null } | null
  /** S7: the window read, for a course whose switch is on. */
  windowRead: LessonRead | null
}

/** A course as recognition sees it: the series, its lesson list, and its finished lessons. */
export interface RecognizableCourse {
  series: SourceSeries
  catalog: CatalogItem[]
  /** Catalog item ids of finished lessons, newest finish first (lesson rule 5). */
  finishedItemIds: string[]
}

export function recognize(_signals: Signals, _courses: readonly RecognizableCourse[]): Recognition {
  return {
    courseId: null,
    confidence: 'none',
    lesson: { itemId: null, number: null, label: null, state: 'pending', origin: null },
    signals: []
  }
}
