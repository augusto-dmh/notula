// SPDX-License-Identifier: Apache-2.0
// One note's speakers as the pill, the card and the who's-who sheet see them: the shared
// label layer's identities and turns, a colour per speaker, the suggestion rows, the pass, the
// meeting app, whether the note is being viewed (not captured) and whether its job runs.

import { useMemo } from 'react'
import { currentPassId, speakerIdentities, type IdentityTurn, type SpeakerIdentity } from '@shared/lib/speakers'
import type { TranscriptChunk } from '@shared/types/transcript'
import type { SpeakerNoteView } from './SpeakerPill'
import { jobBusy, meetingAppOf, unnamedSpeakers, useSpeakerJob, useSpeakerRows, type UnnamedSpeaker } from './speaker-state'

export interface SpeakerNote {
  view: SpeakerNoteView
  identityTurns: IdentityTurn[]
  /** Unnamed speakers with a suggestion row, by speech time: the card's count and the sheet's rows. */
  unnamed: UnnamedSpeaker[]
}

export function useSpeakerNote(noteId: string, chunks: TranscriptChunk[], capturing: boolean): SpeakerNote {
  const rows = useSpeakerRows(noteId)
  const job = useSpeakerJob(noteId)
  const analysis = useMemo(() => speakerIdentities(chunks, { live: capturing }), [chunks, capturing])
  const base = useMemo(() => {
    const identities = new Map<string, SpeakerIdentity>(analysis.identities.map((i) => [i.key, i]))
    // Colours in order of first appearance; the owner (Me) takes the accent.
    const colours = new Map<string, number>()
    let next = 0
    for (const t of analysis.turns) {
      const k = t.identityKey
      if (!k || colours.has(k)) continue
      colours.set(k, identities.get(k)?.isOwner ? -1 : next++)
    }
    const turns = new Map<string, IdentityTurn[]>()
    for (const t of analysis.turns) {
      if (!t.identityKey) continue
      const list = turns.get(t.identityKey) ?? []
      list.push(t)
      turns.set(t.identityKey, list)
    }
    return { identities, colours, turns, passId: currentPassId(chunks), app: meetingAppOf(chunks) }
  }, [analysis, chunks])
  const busy = jobBusy(job)
  const view = useMemo(
    (): SpeakerNoteView => ({ noteId, ...base, rows: new Map(rows.map((r) => [r.identityKey, r])), viewing: !capturing, busy }),
    [noteId, base, rows, capturing, busy]
  )
  const unnamed = useMemo(() => unnamedSpeakers(analysis.identities, rows), [analysis, rows])
  return { view, identityTurns: analysis.turns, unnamed }
}
