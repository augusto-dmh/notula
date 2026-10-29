// SPDX-License-Identifier: Apache-2.0
// The time span of a pending request and its resolution to a cluster.
// Pure: only shared code, so the migration check bundles it on its own.
//
// The span is the cluster's longest turn, in epoch ms, wall clock (`wallClockAnchorMs + s_ms` /
// `+ e_ms`), plus the cluster's channel. A first-to-last-word span covers most of the
// meeting, so another speaker (often the user on the mic) held most of it and the offer named
// the wrong cluster. The longest turn is mostly the person's own speech, and only words of the
// request's channel count.

import { speakerIdentities, wordIdentityKeys } from '@shared/lib/speakers'
import type { AudioSource } from '@shared/types/common'
import type { TranscriptChunk } from '@shared/types/transcript'

export interface PendingSpan {
  startMs: number
  endMs: number
  /** The cluster's channel; null for a request stored without one (every word counts). */
  source?: AudioSource | null
}

/**
 * The span to store for a cluster of `passId`: its longest final turn that resolves back to it
 * (on a busy channel the longest turn may not), with its channel. Null when no turn does.
 */
export function pendingSpanOf(chunks: readonly TranscriptChunk[], passId: string, identityKey: string): Required<PendingSpan> | null {
  const turns = speakerIdentities(chunks.filter((c) => c.is_final), { live: false }).turns.filter((t) => t.identityKey === identityKey)
  turns.sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs) || a.startMs - b.startMs)
  for (const t of turns) {
    const span = { startMs: Math.max(0, Math.round(t.startMs)), endMs: Math.max(0, Math.round(t.endMs)), source: t.channel }
    if (clusterForSpan(chunks, passId, span) === identityKey) return span
  }
  return null
}

/** The cluster of the pass holding most of the span's speech on the span's channel, or null. */
export function clusterForSpan(chunks: readonly TranscriptChunk[], passId: string, span: PendingSpan): string | null {
  const prefix = `r:${passId}:`
  const final = chunks.filter((c) => c.is_final)
  const keys = wordIdentityKeys(final)
  const held = new Map<string, number>()
  for (const c of final) {
    const d = c.providerDetails
    const ks = keys.get(c.id)
    if (!d || !ks || d.mergeScopeId !== passId) continue
    if (span.source && c.source !== span.source) continue
    d.words.forEach((w, i) => {
      const k = ks[i]
      if (!k || !k.startsWith(prefix)) return
      const overlap = Math.min(span.endMs, d.wallClockAnchorMs + w.e_ms) - Math.max(span.startMs, d.wallClockAnchorMs + w.s_ms)
      if (overlap > 0) held.set(k, (held.get(k) ?? 0) + overlap)
    })
  }
  return [...held].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? null
}
