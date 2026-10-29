// SPDX-License-Identifier: Apache-2.0
// The renderer state behind the speaker pill, its popover, the who's-who sheet and the card
//: the note's suggestion rows, the job state, the speakers
// status, the roster, the note's unnamed speakers, and the naming actions with their Undo
// toasts. Every name shown comes from the shared label layer (`@shared/lib/speakers`); this
// module never reads a raw `att` or `detected_speaker_name`.
//
// Naming retries once on `stale` with the note's current pass (the renderer re-reads and
// retries). Undo toasts stay for the 10 s window; Undo itself is never refused.

import { useEffect, useState } from 'react'
import { parseError } from '@shared/errors'
import { currentPassId, identityPassId, sameSpeakerName, type SpeakerIdentity } from '@shared/lib/speakers'
import { SPEAKER_JOB_BUSY, SPEAKER_PROFILE_LIMITS, type SpeakerJobState, type SpeakerRosterRow, type SpeakersStatus } from '@shared/types/speakers'
import type { SpeakerNameAccept, SpeakerNameAcceptResult, SpeakerNameSuggestion, TranscriptChunk } from '@shared/types/transcript'
import { showToast } from '../../app/toast'
import { openAgreementSheet } from '../speaker-profiles'
import { toastNamed, toastNot, toastSkipped, toastUndo } from '../speaker-profiles/strings'

const UNDO_MS = SPEAKER_PROFILE_LIMITS.undoWindowMs
const ROSTER_DEBOUNCE_MS = 120

// ---------- reads ----------

/** The note's suggestion rows (`speaker-names:list`), kept current by `speaker-names:changed`. */
export function useSpeakerRows(noteId: string): SpeakerNameSuggestion[] {
  const [rows, setRows] = useState<SpeakerNameSuggestion[]>([])
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.notula.speakerNames
        .list({ noteId })
        .then((r) => {
          if (alive) setRows(r)
        })
        .catch(() => undefined)
    }
    load()
    const off = window.notula.speakerNames.onChanged((p) => {
      if (p.noteId === noteId) load()
    })
    return () => {
      alive = false
      off()
    }
  }, [noteId])
  return rows
}

/** The note's job state; `idle` until read. */
export function useSpeakerJob(noteId: string): SpeakerJobState {
  const [state, setState] = useState<SpeakerJobState>('idle')
  useEffect(() => {
    let alive = true
    setState('idle')
    const off = window.notula.speakers.onJobChanged((p) => {
      if (p.noteId === noteId && alive) setState(p.state)
    })
    void window.notula.speakers
      .jobState({ noteId })
      .then((s) => {
        if (alive) setState(s.state)
      })
      .catch(() => undefined)
    return () => {
      alive = false
      off()
    }
  }, [noteId])
  return state
}

/** The pills and the sheet don't open in these states. */
export function jobBusy(state: SpeakerJobState): boolean {
  return SPEAKER_JOB_BUSY.includes(state)
}

let status: SpeakersStatus | null = null
const statusListeners = new Set<(s: SpeakersStatus) => void>()
let statusStarted = false

function startStatus(): void {
  if (statusStarted) return
  statusStarted = true
  const set = (s: SpeakersStatus): void => {
    status = s
    for (const l of statusListeners) l(s)
  }
  window.notula.speakers.onStatusChanged(set)
  void window.notula.speakers
    .getStatus()
    .then(set)
    .catch(() => undefined)
}

/** `speakers:get-status`, shared by every pill; null until read. */
export function useSpeakersStatus(): SpeakersStatus | null {
  const [s, setS] = useState(status)
  useEffect(() => {
    startStatus()
    statusListeners.add(setS)
    if (status) setS(status)
    return () => {
      statusListeners.delete(setS)
    }
  }, [])
  return s
}

/** The roster (`speaker-people:list`): attendees, then the user, then recent people. Reloads on `speaker-people:changed`. */
export function useRoster(noteId: string, query: string, enabled: boolean): SpeakerRosterRow[] {
  const [rows, setRows] = useState<SpeakerRosterRow[]>([])
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (!enabled) return
    return window.notula.speakerPeople.onChanged(() => setVersion((v) => v + 1))
  }, [enabled])
  useEffect(() => {
    if (!enabled) return
    let alive = true
    const q = query.trim()
    const t = window.setTimeout(
      () => {
        void window.notula.speakerPeople
          .list({ noteId, ...(q ? { query: q } : {}) })
          .then((r) => {
            if (alive) setRows(r)
          })
          .catch(() => undefined)
      },
      q ? ROSTER_DEBOUNCE_MS : 0
    )
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [noteId, query, enabled, version])
  return rows
}

// ---------- derived ----------

/** The meeting app whose tiles stamped this note's words, for "From <app>". */
export function meetingAppOf(chunks: readonly TranscriptChunk[]): string | null {
  const counts = new Map<string, number>()
  for (const c of chunks) {
    const s = c.detectedSpeaker?.source
    if (s && s !== 'diarization') counts.set(s, (counts.get(s) ?? 0) + 1)
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  return top === 'zoom-uia' ? 'Zoom' : top === 'teams-uia' ? 'Teams' : top === 'meet-uia' ? 'Google Meet' : null
}

/** One unnamed speaker of the note: neither confirmed nor auto, not suppressed, not the owner. */
export interface UnnamedSpeaker {
  identity: SpeakerIdentity
  row: SpeakerNameSuggestion
}

/**
 * The note's unnamed speakers, by speech time: those with a suggestion row (the job
 * writes one for every unnamed speaker; Skip takes it out). `att` doesn't hide a speaker.
 */
export function unnamedSpeakers(identities: readonly SpeakerIdentity[], rows: readonly SpeakerNameSuggestion[]): UnnamedSpeaker[] {
  const byKey = new Map(rows.map((r) => [r.identityKey, r]))
  const out: UnnamedSpeaker[] = []
  for (const identity of identities) {
    const row = byKey.get(identity.key)
    if (row && identity.state === 'unnamed' && !identity.suppressed && !identity.isOwner && identity.letterLabel !== null) out.push({ identity, row })
  }
  return out.sort((a, b) => b.identity.speechMs - a.identity.speechMs)
}

/** The pending row's person: the request lives on the person, so it is looked up there. */
export interface PendingPerson {
  personId: string
  name: string
  canName: boolean
}

/** People with a request waiting in this note: attendees first, then the rest of the roster. */
export async function pendingPeople(noteId: string): Promise<PendingPerson[]> {
  const roster = await window.notula.speakerPeople.list({ noteId })
  const out: PendingPerson[] = []
  for (const r of roster) {
    if (!r.personId || r.isSelf) continue
    try {
      const view = await window.notula.speakerPeople.get({ personId: r.personId })
      const hit = view.pending.find((p) => p.noteId === noteId)
      if (hit) out.push({ personId: r.personId, name: view.person.name, canName: hit.canName })
    } catch {
      // A person gone meanwhile has no request.
    }
  }
  return out
}

/** The person a pending row waits for: its guess's person when one waits, else null (another row's request isn't guessed). */
export function pendingPersonFor(row: SpeakerNameSuggestion | undefined, people: readonly PendingPerson[]): PendingPerson | null {
  if (!row?.pending || !people.length) return null
  const guess = row.candidates.find((c) => people.some((p) => p.personId === c.personId))
  return people.find((p) => p.personId === guess?.personId) ?? null
}

// ---------- actions ----------

/** What a pick names (`speaker-names:accept`): a person, an attendee's email, Me, a new name, or a plain name. */
export interface NamePick {
  name: string
  personId?: string
  email?: string
  self?: boolean
  newName?: string
  fromList: boolean
  edited?: boolean
}

export interface NameTarget {
  noteId: string
  identityKey: string
  passId: string | null
}

function errorToast(id: string, err: unknown): void {
  const message = parseError(err).message.trim()
  showToast({ id, kind: 'error', title: message || 'Notula couldn’t name this speaker. Try again.' })
}

/** `accept`, retried once on `stale` with the note's current pass. */
async function acceptOnce(req: SpeakerNameAccept): Promise<SpeakerNameAcceptResult> {
  try {
    return await window.notula.speakerNames.accept(req)
  } catch (err) {
    if (parseError(err).code !== 'stale') throw err
    const chunks = await window.notula.transcript.get({ noteId: req.noteId })
    const passId = currentPassId(chunks)
    // A key of an older pass names a speaker that no longer exists.
    if (req.identityKey.startsWith('r:') && identityPassId(req.identityKey) !== passId) throw err
    return window.notula.speakerNames.accept({ ...req, passId })
  }
}

function undoAll(tokens: readonly string[]): void {
  for (const undoToken of tokens) void window.notula.speakerNames.undo({ undoToken }).catch(() => undefined)
}

/** Shows the Undo toast of one action for the 10 s window. */
function undoToast(id: string, title: string, tokens: string[]): void {
  showToast({
    id,
    kind: 'success',
    title,
    durationMs: UNDO_MS,
    ...(tokens.length ? { action: { label: toastUndo(), onClick: () => undoAll(tokens) } } : {})
  })
}

/** The person an accept created or found, for the consent sheet that follows `needsAgreement`. */
async function personIdFor(noteId: string, pick: NamePick): Promise<string | null> {
  if (pick.personId) return pick.personId
  const rows = await window.notula.speakerPeople.list({ noteId, query: pick.email ?? pick.name })
  const hit = rows.find((r) => !r.isSelf && r.personId && (pick.email ? r.email?.toLowerCase() === pick.email.toLowerCase() : sameSpeakerName(r.name, pick.name)))
  return hit?.personId ?? null
}

/**
 * Names a speaker (or Only this turn) and shows "Named <n> passages as <name>" with Undo.
 * When main answers `needsAgreement` (Remember voice on for a person without a record), the
 * consent sheet follows; once it records, the same naming is sent again with Remember voice on
 * so the first sample is added, and the toast's Undo covers both. Resolves false on failure.
 */
export async function nameSpeaker(t: NameTarget, pick: NamePick, opts: { remember: boolean; turnChunkIds?: string[] }): Promise<boolean> {
  const toastId = `speaker-name:${t.identityKey}`
  const req: SpeakerNameAccept = {
    noteId: t.noteId,
    identityKey: t.identityKey,
    name: pick.name.trim(),
    edited: pick.edited ?? false,
    chosenFromList: pick.fromList,
    ...(pick.personId ? { personId: pick.personId } : pick.email ? { email: pick.email } : pick.self ? { self: true } : pick.newName ? { newName: pick.newName.trim() } : {}),
    remember: opts.turnChunkIds ? false : opts.remember,
    scope: opts.turnChunkIds ? 'turn' : 'speaker',
    ...(opts.turnChunkIds ? { turnChunkIds: opts.turnChunkIds } : {}),
    passId: t.passId
  }
  let r: SpeakerNameAcceptResult
  try {
    r = await acceptOnce(req)
  } catch (err) {
    errorToast(toastId, err)
    return false
  }
  const tokens = r.undoToken ? [r.undoToken] : []
  undoToast(toastId, toastNamed(r.chunksNamed, req.name), tokens)
  if (!r.needsAgreement) return true
  const personId = await personIdFor(t.noteId, pick).catch(() => null)
  // The speaker is already named, so asking first no longer applies here.
  const sheet = personId ? await openAgreementSheet({ personId, name: req.name, noteId: t.noteId, identityKey: t.identityKey, canAskFirst: false }) : null
  const recorded = sheet?.outcome === 'recorded'
  // Without a record, the same naming goes again with Remember voice off, so main deletes the
  // named cluster's vector instead of keeping it for a sheet that never recorded. A
  // person the first naming created is sent by id, never created twice.
  const ident: Partial<SpeakerNameAccept> = personId ? { personId, email: undefined, newName: undefined } : { newName: undefined }
  try {
    const again = await acceptOnce({ ...req, ...ident, remember: recorded } as SpeakerNameAccept)
    if (again.undoToken) tokens.push(again.undoToken)
    undoToast(toastId, toastNamed(r.chunksNamed, req.name), tokens)
  } catch (err) {
    errorToast(toastId, err)
  }
  return true
}

/** Not <name>: a negative, the machine name or the guess cleared, and an Undo toast. */
export async function notPerson(noteId: string, identityKey: string, personId: string, name: string): Promise<boolean> {
  const toastId = `speaker-not:${identityKey}`
  try {
    const r = await window.notula.speakerNames.notPerson({ noteId, identityKey, personId })
    undoToast(toastId, toastNot(name), r.undoToken ? [r.undoToken] : [])
    return true
  } catch (err) {
    errorToast(toastId, err)
    return false
  }
}

/** Skip (the sheet only): the row goes, the cluster vector after the Undo window. */
export async function skipSpeaker(noteId: string, identityKey: string, letterLabel: string): Promise<boolean> {
  const toastId = `speaker-skip:${identityKey}`
  try {
    const r = await window.notula.speakerNames.reject({ noteId, identityKey })
    undoToast(toastId, toastSkipped(letterLabel.replace(/^Speaker /, '')), r.undoToken ? [r.undoToken] : [])
    return true
  } catch (err) {
    errorToast(toastId, err)
    return false
  }
}

/** "Name <name>" on a pending row once the agreement exists. */
export async function namePending(noteId: string, identityKey: string, person: PendingPerson): Promise<boolean> {
  const toastId = `speaker-name:${identityKey}`
  try {
    const r = await window.notula.speakerNames.namePending({ noteId, identityKey, personId: person.personId })
    undoToast(toastId, toastNamed(r.chunksNamed, person.name), r.undoToken ? [r.undoToken] : [])
    return true
  } catch (err) {
    errorToast(toastId, err)
    return false
  }
}

// ---------- the clip ----------

/** Plays a speaker's clip from memory; resolves false when there is no audio (show the lines instead). */
export async function playClip(noteId: string, identityKey: string, onEnd: () => void): Promise<{ ok: boolean; stop(): void }> {
  let r: { wav: Uint8Array | null }
  try {
    r = await window.notula.speakerNames.clip({ noteId, identityKey })
  } catch {
    return { ok: false, stop: () => undefined }
  }
  if (!r.wav) return { ok: false, stop: () => undefined }
  // An object URL over the bytes in memory; revoked when playback ends. Nothing is stored.
  const url = URL.createObjectURL(new Blob([r.wav as BlobPart], { type: 'audio/wav' }))
  const audio = new Audio(url)
  let done = false
  const end = (): void => {
    if (done) return
    done = true
    audio.pause()
    audio.removeAttribute('src')
    URL.revokeObjectURL(url)
    onEnd()
  }
  audio.addEventListener('ended', end)
  audio.addEventListener('error', end)
  try {
    await audio.play()
  } catch {
    end()
    return { ok: false, stop: () => undefined }
  }
  return { ok: true, stop: end }
}
