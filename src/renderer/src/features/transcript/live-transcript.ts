// SPDX-License-Identifier: Apache-2.0
// The note's chunk list from main's store: `transcript:get` once,
// then `transcript:changed` upserts and removals. Deleted chunks are dropped.

import { useEffect, useState } from 'react'
import type { TranscriptChanged, TranscriptChunk } from '@shared/types/transcript'
import { compareChunks, isVisible } from './turns'

export function useLiveTranscript(noteId: string): { chunks: TranscriptChunk[]; loaded: boolean } {
  const [state, setState] = useState<{ chunks: TranscriptChunk[]; loaded: boolean }>({ chunks: [], loaded: false })

  useEffect(() => {
    let alive = true
    let loaded = false
    const map = new Map<string, TranscriptChunk>()
    const early: TranscriptChanged[] = []
    setState({ chunks: [], loaded: false })

    const apply = (p: TranscriptChanged): void => {
      for (const id of p.removedIds) map.delete(id)
      for (const c of p.upserted) map.set(c.id, c)
    }
    const publish = (): void => {
      if (!alive) return
      setState({ chunks: [...map.values()].filter(isVisible).sort(compareChunks), loaded: true })
    }

    const off = window.notula.transcript.onChanged((p) => {
      if (p.noteId !== noteId) return
      if (!loaded) {
        early.push(p)
        return
      }
      apply(p)
      publish()
    })

    window.notula.transcript
      .get({ noteId })
      .then((rows) => {
        for (const r of rows) map.set(r.id, r)
      })
      .catch(() => undefined)
      .finally(() => {
        loaded = true
        for (const p of early.splice(0)) apply(p)
        publish()
      })

    return () => {
      alive = false
      off()
    }
  }, [noteId])

  return state
}
