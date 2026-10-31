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
import { currentPassId, identityPassId, type SpeakerIdentity } from '@shared/lib/speakers'
import {
  SPEAKER_JOB_BUSY,
  SPEAKER_PROFILE_LIMITS,
  type SpeakerJobState,
  type SpeakerPendingSpeaker,
  type SpeakerRosterRow,
  type SpeakersStatus
} from '@shared/types/speakers'
import type { SpeakerNameAccept, SpeakerNameAcceptResult, SpeakerNameSuggestion, TranscriptChunk } from '@shared/types/transcript'
import { showToast } from '../../app/toast'
import { openAgreementSheet } from '../speaker-profiles'
import { couldntName, toastNamed, toastNot, toastSkipped, toastUndo } from '../speaker-profiles/strings'

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
    // A request cancelled or a person forgotten on the person page clears a row's pending flag.
    const offPeople = window.notula.speakerPeople.onChanged(load)
    return () => {
      alive = false
      off()
      offPeople()
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

/** A request waiting in the note, with the speaker main resolves its span to now. */
export type PendingPerson = SpeakerPendingSpeaker

/** The note's requests (`speaker-names:pending`). */
export function pendingPeople(noteId: string): Promise<PendingPerson[]> {
  return window.notula.speakerNames.pending({ noteId })
}

/**
 * The person a pending row waits for: the request whose span picks this speaker, whatever its
 * guess was (an Ask first on a speaker with no guess has no candidates).
 */
export function pendingPersonFor(row: SpeakerNameSuggestion | undefined, people: readonly PendingPerson[]): PendingPerson | null {
  if (!row?.pending || !people.length) return null
  return people.find((p) => p.identityKey === row.identityKey) ?? null
}

/** Whether a clip can play for the note's speakers: without audio, the two longest lines show instead of Play. */
export function useClipAvailable(noteId: string): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    setAvailable(null)
    void window.notula.speakerNames
      .hasClip({ noteId })
      .then((r) => {
        if (alive) setAvailable(r.available)
      })
      .catch(() => {
        if (alive) setAvailable(false)
      })
    return () => {
      alive = false
    }
  }, [noteId])
  return available
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
  showToast({ id, kind: 'error', title: message || couldntName() })
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

/**
 * The person a pick names, created when Notula doesn't know it yet (an attendee by email, a
 * meeting-app or typed name), so a sheet or a Not <name> has a person. Null for Me.
 */
export async function ensurePersonFor(pick: Pick<NamePick, 'name' | 'personId' | 'email' | 'self' | 'newName'>): Promise<string | null> {
  if (pick.personId) return pick.personId
  if (pick.self) return null
  const r = await window.notula.speakerPeople.ensure({ name: (pick.newName ?? pick.name).trim(), ...(pick.email ? { email: pick.email } : {}) })
  return r.personId
}

async function hasActiveAgreement(personId: string): Promise<boolean> {
  const v = await window.notula.speakerPeople.get({ personId }).catch(() => null)
  return !!v?.agreement && !v.agreement.revokedAt
}

/**
 * Consent before naming: Remember voice for anyone without an active agreement opens the sheet
 * while nothing is named yet. Recorded names with Remember voice on, Name without remembering
 * (or Esc on an untouched sheet) names with it off, and Ask first names nothing. Resolves the
 * pick to send, by person id, or null when nothing is to be named.
 */
async function agreementFirst(t: NameTarget, pick: NamePick, hasVoiceSample: boolean | undefined): Promise<{ pick: NamePick; remember: boolean } | null> {
  const personId = await ensurePersonFor(pick)
  if (!personId) return { pick, remember: true }
  const byId: NamePick = { name: pick.name, personId, fromList: pick.fromList, ...(pick.edited ? { edited: true } : {}) }
  if (await hasActiveAgreement(personId)) return { pick: byId, remember: true }
  const r = await openAgreementSheet({
    personId,
    name: pick.name,
    noteId: t.noteId,
    identityKey: t.identityKey,
    // Ask first keeps the speaker's voice sample for later: not offered when it's known to have none.
    canAskFirst: hasVoiceSample !== false,
    naming: true
  })
  if (r.outcome === 'ask-first') return null
  return { pick: byId, remember: r.outcome === 'recorded' }
}

export interface NameOptions {
  remember: boolean
  /** Only this turn: never remembers. */
  turnChunkIds?: string[]
  /** `speaker-names:list`'s flag for the speaker; false hides Ask first on the sheet. */
  hasVoiceSample?: boolean
}

/**
 * Names a speaker (or Only this turn) and shows "Named <n> passages as <name>" with Undo. With
 * Remember voice on for a person without an agreement, the consent sheet comes first and the
 * naming waits for it, so the Undo window starts only once the sheet has closed. Resolves false
 * when nothing was named (a failure, or Ask first).
 */
export async function nameSpeaker(t: NameTarget, given: NamePick, opts: NameOptions): Promise<boolean> {
  const toastId = `speaker-name:${t.identityKey}`
  let pick = given
  let remember = opts.remember && !opts.turnChunkIds
  if (remember && !pick.self) {
    let gate: Awaited<ReturnType<typeof agreementFirst>>
    try {
      gate = await agreementFirst(t, pick, opts.hasVoiceSample)
    } catch (err) {
      errorToast(toastId, err)
      return false
    }
    if (!gate) return false
    pick = gate.pick
    remember = gate.remember
  }
  const req: SpeakerNameAccept = {
    noteId: t.noteId,
    identityKey: t.identityKey,
    name: pick.name.trim(),
    edited: pick.edited ?? false,
    chosenFromList: pick.fromList,
    ...(pick.personId ? { personId: pick.personId } : pick.email ? { email: pick.email } : pick.self ? { self: true } : pick.newName ? { newName: pick.newName.trim() } : {}),
    remember,
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
  if (r.needsAgreement) {
    // The agreement ended between the sheet and the naming. Main keeps the vector for a sheet;
    // the same naming again with Remember voice off lets it go. Sent by id, so nobody is created twice.
    const personId = pick.personId ?? (await ensurePersonFor(pick).catch(() => null))
    const ident: Partial<SpeakerNameAccept> = personId ? { personId, email: undefined, newName: undefined } : { newName: undefined }
    try {
      const again = await acceptOnce({ ...req, ...ident, remember: false } as SpeakerNameAccept)
      if (again.undoToken) tokens.push(again.undoToken)
    } catch (err) {
      errorToast(toastId, err)
    }
  }
  undoToast(toastId, toastNamed(r.chunksNamed, req.name), tokens)
  return true
}

/** Who a Not <name> is about: a person, or a meeting-app or attendee name that gets its person first. */
export interface NotTarget {
  personId?: string
  name: string
  email?: string
}

/** Not <name>: a negative, the machine name or the guess cleared, and an Undo toast. */
export async function notPerson(noteId: string, identityKey: string, who: NotTarget): Promise<boolean> {
  const toastId = `speaker-not:${identityKey}`
  try {
    // A negative needs a person; a name from a meeting app gets one, so a re-run keeps it out.
    const personId = (await ensurePersonFor(who)) as string
    const r = await window.notula.speakerNames.notPerson({ noteId, identityKey, personId })
    undoToast(toastId, toastNot(who.name), r.undoToken ? [r.undoToken] : [])
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
