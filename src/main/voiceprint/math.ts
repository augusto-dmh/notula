// SPDX-License-Identifier: Apache-2.0
// The self voice's rules: the meeting classification and the enrolment guard (speaker
// profiles). Pure functions; main only. Thresholds live in VOICEPRINT_LIMITS.

import { MEETING_APPS } from '@shared/types/meetings'
import type { TranscriptChunk } from '@shared/types/transcript'
import { VOICEPRINT_LIMITS as L } from '@shared/types/voiceprint'
import { BROWSER_IDS } from '../consent/apps'

export type VoiceprintClassification = 'online' | 'in_person' | 'unknown'

function speechMs(chunks: TranscriptChunk[], source: TranscriptChunk['source']): number {
  let ms = 0
  for (const c of chunks) {
    if (c.source !== source || !c.is_final || !c.text.trim()) continue
    const d = Date.parse(c.end_timestamp) - Date.parse(c.start_timestamp)
    if (Number.isFinite(d) && d > 0) ms += d
  }
  return ms
}

/** In person or online, from a meeting's final chunks and the mic apps seen during it. */
export function classify(chunks: TranscriptChunk[], appsSeen: Iterable<string>): VoiceprintClassification {
  const system = speechMs(chunks, 'system')
  const mic = speechMs(chunks, 'microphone')
  const conferencingApp = [...appsSeen].some((id) => id in MEETING_APPS && !BROWSER_IDS.has(id))
  if (system >= L.onlineSystemSpeechMs || conferencingApp) return 'online'
  if (mic >= L.inPersonMicMs && system <= L.inPersonSystemMaxMs) return 'in_person'
  return 'unknown'
}

/** The dominant speaker of an enrolment input, when it passes 20 s and a 0.8 share. */
export function dominant<T extends { speechMs: number; vector: Float32Array | null }>(
  speakers: readonly T[]
): { speaker: T | null; speechMs: number; reason: 'too-little-speech' | 'not-dominant' | null } {
  const total = speakers.reduce((n, s) => n + s.speechMs, 0)
  const top = [...speakers].sort((a, b) => b.speechMs - a.speechMs)[0]
  if (!top || top.speechMs < L.enrolDominantMs || !top.vector) return { speaker: null, speechMs: top?.speechMs ?? 0, reason: 'too-little-speech' }
  if (top.speechMs / total < L.enrolShare) return { speaker: null, speechMs: top.speechMs, reason: 'not-dominant' }
  return { speaker: top, speechMs: top.speechMs, reason: null }
}
