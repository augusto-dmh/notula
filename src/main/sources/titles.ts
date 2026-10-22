// SPDX-License-Identifier: Apache-2.0
// Source note titles.
//
// The note's title is the clean source title: strip ` - YouTube`, `(Official Video)`, a trailing
// `| <channel>` and a leading `(N) ` notification count. The breadcrumb (series, lesson number,
// channel) is the UI's, never part of the title. AI title generation never runs for source notes
// (`enhance/title.ts`). The note follows a changed source title only while its title still equals
// the generated one (`note_sources.generated_title`; the sources core applies it).
//
// Pure: `scripts/dev/catalog-parse.mjs` loads this file through Node's type stripping.

import { cleanTitle } from '@shared/lib/source-key'
import type { SourceDraft } from '@shared/types/sources'

const YOUTUBE_SUFFIX = /\s+[-|–—]\s+youtube\s*$/i
/** `(Official Video)`, `[Official Music Video]`, `(Official Audio)` and the like. */
const OFFICIAL = /\s*[([]\s*official\s+(?:music\s+|lyric\s+)?(?:video|audio)\s*[)\]]/gi
const MAX_TITLE = 500

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The clean source title. Never empty while the raw title has text (it falls back to the trimmed raw title). */
export function renderSourceTitle(source: Pick<SourceDraft, 'title' | 'channel' | 'provider' | 'site'>): string {
  const raw = source.title.replace(/\s+/g, ' ').trim()
  if (!raw) return ''
  let t = raw
  // A few passes: `(3) Title (Official Video) | Channel - YouTube` peels from both ends.
  for (let i = 0; i < 4; i++) {
    const before = t
    t = cleanTitle(t, source.site && !source.site.includes('.') ? source.site : null)
    t = t.replace(YOUTUBE_SUFFIX, '').replace(OFFICIAL, '')
    const channel = source.channel?.trim()
    if (channel) t = t.replace(new RegExp(`\\s*\\|\\s*${escape(channel)}\\s*$`, 'i'), '')
    t = t.replace(/\s+/g, ' ').trim()
    if (t === before) break
  }
  if (!t) t = raw
  return t.length > MAX_TITLE ? t.slice(0, MAX_TITLE).trimEnd() : t
}

/**
 * A title reduced for matching against a catalog: the clean title, case- and accent-folded,
 * without a leading lesson marker (`Aula 12 -`, `Lesson 3:`, `12.`, `#12`), punctuation as
 * spaces.
 */
export function matchTitle(title: string): string {
  return renderSourceTitle({ title, channel: null, provider: 'web', site: null })
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/^(?:(?:aula|lesson|class|lição|licao|clase)\s*\d+|#\s*\d+|\d+\s*[.)-])\s*[-–—:.|]?\s*/u, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}
