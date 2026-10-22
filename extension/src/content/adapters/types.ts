// SPDX-License-Identifier: Apache-2.0
// What a site adapter gives the reader. Every method returns only what it found; a missing
// field is named in `misses` so Notula can say "Course details partly missing on <site>".

import type { ExtAdapter, ExtOutlineItem } from '../../../../src/shared/types/extension-protocol'
import type { CaptionsReply, PageFields, TranscriptRead } from '../../lib/messages'

export interface PageResult {
  page: PageFields
  misses: string[]
}

export interface Adapter {
  id: ExtAdapter
  /** The canonical key of what this page plays. */
  video(): string | null
  /** YouTube's ad state; false elsewhere. */
  ad(): boolean
  page(): PageResult | null
  outline(): ExtOutlineItem[]
  /** Caption text for Notula's `captions.request` (YouTube's caption order; text tracks elsewhere). */
  captions(video: string, langs: string[], replay: boolean): Promise<CaptionsReply>
  /** Read this lesson's transcript: the popup button only. */
  transcript(): Promise<TranscriptRead>
}

export interface AdapterEnv {
  /** The main media element of this frame. */
  media(): HTMLMediaElement | null
  /** Hands a track the player loaded on its own to the service worker. */
  track(track: import('../../lib/messages').CaptionsTrack): void
  chapters(video: string, items: { start: number; title: string }[], source: 'player' | 'description'): void
  /** Something changed that the reader should report now (YouTube player data arrived). */
  changed(): void
}
