// SPDX-License-Identifier: Apache-2.0
// The extension's page facts on an identified draft.
// Pure. Applied only to extension playbacks, and only while `sources.extension.coursePages` is
// on (the provider also drops `page` messages while it is off).
//
// - Lesson: the page's lesson number (`index`) becomes the draft's lesson: `numbered` when the
//   page read it, `guessed` when the extension inferred it. A number the URL already gave
//   (a playlist `index=`) stands. The section title is the lesson's label.
// - Series: a course the URL already names keeps its key and gains the page's title, section and
//   index. A course the URL doesn't name is keyed from the page's course URL when the shared
//   parser can key it; otherwise none is made (a key the URL parser can't reproduce would split
//   the series). A YouTube playlist the page names gives `youtube:playlist:<id>` (the parser's
//   own form) when the draft has no series of its own, or only its channel.
// - Channel: filled from the page only when the draft has none.

import { parseSourceUrl } from '@shared/lib/source-key'
import type { ExtPage } from '@shared/types/extension-protocol'
import type { SeriesHint, SourceDraft } from '@shared/types/sources'

const PLAYLIST_ID = /^[\w-]{2,64}$/
/** Personal or generated lists (mixes, Watch later, Liked): never a series. */
const NOT_SERIES = /^(RD|WL$|LL$|LM$)/

const text = (v: string | null | undefined): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null)
const count = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 100_000 ? v : null)

export function applyPage(draft: SourceDraft, page: ExtPage | null): SourceDraft {
  if (!page) return draft
  const out: SourceDraft = { ...draft }
  const section = text(page.section?.title)
  const lessonNo = count(page.lesson?.index)
  const playlistNo = count(page.playlist?.index)

  // Series.
  let series: SeriesHint | null = draft.series
  if (page.course) {
    const title = text(page.course.title)
    if (series?.kind === 'course') series = { ...series, title: series.title ?? title, section: section ?? series.section, index: lessonNo ?? series.index }
    else if (!series || series.kind === 'channel') {
      const keyed = page.course.url ? parseSourceUrl(page.course.url)?.series : null
      if (keyed?.kind === 'course') series = { ...keyed, title: keyed.title ?? title, section, index: lessonNo }
    }
  } else if (page.playlist && draft.provider === 'youtube' && (!series || series.kind === 'channel')) {
    const id = page.playlist.id
    if (PLAYLIST_ID.test(id) && !NOT_SERIES.test(id)) {
      series = { kind: 'playlist', provider: 'youtube', canonicalKey: `youtube:playlist:${id}`, title: text(page.playlist.title), index: playlistNo, section: null }
    }
  }
  out.series = series

  // Lesson.
  const number = series?.kind === 'playlist' ? playlistNo : lessonNo
  const field = series?.kind === 'playlist' ? 'playlist' : 'lesson'
  if (number !== null && draft.lesson?.state !== 'numbered' && (series?.kind === 'course' || series?.kind === 'playlist' || draft.kind === 'lesson')) {
    out.lesson = { number, label: section ?? draft.lesson?.label ?? null, state: page.confidence[field] === 'page' ? 'numbered' : 'guessed' }
  } else if (section && draft.lesson && !draft.lesson.label) {
    out.lesson = { ...draft.lesson, label: section }
  }

  // Channel.
  if (!out.channel) out.channel = text(page.channel?.name)
  return out
}
