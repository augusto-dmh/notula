// SPDX-License-Identifier: Apache-2.0
// The speaker pill and its popover.
//
// - The pill is every word-level turn's label, a button in the speaker's colour. It shows the
//   band of the turn's cluster through the shared label layer (`turnDisplay`): a name, a softer
//   "Ana?", "Ana or Bruno?", "Speaker B", or a pending speaker's letter. It opens only while
//   viewing: not while the note is capturing, and not while the job runs. Then every pill stays
//   a disabled button, turns without a speaker yet included, with "Naming speakers…" as its
//   tooltip, and the panel shows the quiet line. When the job writes, a pill's new label fades
//   in; a speaker that isn't automatic or named by the user shows its letter, never a live name.
// - The popover leads with its guess (both for a tie), pre-selected so Enter accepts it, with
//   where it came from under the name. Then the attendees, Me for a mic speaker and recent
//   people, and "Search or add a name". Above the list: the label, Play (only when the note has
//   audio; otherwise the speaker's two longest lines) and "Not <name>"; below it, Remember
//   voice and Only this turn.
// - Keyboard: Enter opens the pill; arrows move through the list (focus stays in the search
//   field, `aria-activedescendant`); Enter picks; Esc closes and returns focus to the pill.
// - No score, percentage or probability appears anywhere.

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { sameSpeakerName, turnDisplay, type IdentityTurn, type SpeakerDisplay, type SpeakerIdentity } from '@shared/lib/speakers'
import type { SpeakerCandidate, SpeakerRosterRow } from '@shared/types/speakers'
import { SPEAKER_LABEL_ME, SPEAKER_UNATTRIBUTED, type SpeakerNameSuggestion } from '@shared/types/transcript'
import { useSpeechPrefs } from './speech-state'
import {
  nameSpeaker,
  notPerson,
  pendingPeople,
  pendingPersonFor,
  playClip,
  useClipAvailable,
  useRoster,
  useSpeakersStatus,
  type NamePick,
  type NotTarget,
  type PendingPerson
} from './speaker-state'
import * as S from '../speaker-profiles/strings'
import './speaker-pill.css'

/** The colours the pills cycle through (`.nt-spk--c<n>`); the owner (Me) takes the accent. */
export const SPEAKER_COLOURS = 8
const GAP = 6
const MARGIN = 8

/** What every pill of one note shares, computed once by the panel. */
export interface SpeakerNoteView {
  noteId: string
  identities: ReadonlyMap<string, SpeakerIdentity>
  /** A colour index per identity, in order of first appearance; -1 for the owner. */
  colours: ReadonlyMap<string, number>
  /** Each identity's turns, for the lines shown without audio. */
  turns: ReadonlyMap<string, IdentityTurn[]>
  rows: ReadonlyMap<string, SpeakerNameSuggestion>
  passId: string | null
  /** The meeting app that stamped tile names ("Google Meet", "Zoom", "Teams"). */
  app: string | null
  /** False while capturing: the pill shows names but doesn't open. */
  viewing: boolean
  /** The job runs: the pill shows names but doesn't open. */
  busy: boolean
}

export function colourClass(view: SpeakerNoteView, identityKey: string | null): string {
  const c = identityKey ? view.colours.get(identityKey) : undefined
  return c === undefined ? 'nt-spk--plain' : c < 0 ? 'nt-spk--me' : `nt-spk--c${c % SPEAKER_COLOURS}`
}

/** The pill's label; a turn with no known speaker reads "Unknown speaker". */
function pillText(turn: IdentityTurn, display: SpeakerDisplay): string {
  return turn.label === SPEAKER_UNATTRIBUTED && display.band === 'none' ? S.pillUnattributed() : display.text
}

/** The label; the panel fades it in when the job's write lands (`.nt-tr--settling`). */
function PillText({ text }: { text: string }): JSX.Element {
  return <span className="nt-spk-pill__text">{text}</span>
}

export function SpeakerPill({ view, turn }: { view: SpeakerNoteView; turn: IdentityTurn }): JSX.Element {
  const key = turn.identityKey
  const identity = key ? view.identities.get(key) : undefined
  const row = key ? view.rows.get(key) : undefined
  const display = turnDisplay(turn, identity, row)
  const text = pillText(turn, display)
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const cls = `nt-spk-pill ${colourClass(view, key)}${display.soft ? ' is-soft' : ''}${text === S.pillUnattributed() ? ' is-unknown' : ''}`
  // While capturing nothing opens; a turn without an identity (no word labels) can't be named.
  if (!view.viewing || (!identity && !view.busy)) {
    return (
      <span className={cls}>
        <PillText text={text} />
      </span>
    )
  }
  // While the job runs, every pill is a disabled button that says why.
  if (view.busy || !identity) {
    return (
      <button type="button" className={`${cls} is-busy`} aria-disabled="true" title={S.namingSpeakers()}>
        <PillText text={text} />
      </button>
    )
  }
  return (
    <>
      <button ref={ref} type="button" className={cls} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <PillText text={text} />
        <Chevron />
      </button>
      {open && <SpeakerPopover view={view} identity={identity} display={display} turn={turn} anchor={ref} onClose={() => setOpen(false)} />}
    </>
  )
}

// ---------- the popover ----------

interface Option {
  key: string
  name: string
  /** The secondary text: where a guess came from, the user's name for Me, or an email that tells two people apart. */
  detail: string | null
  /** The email, shown on hover when it isn't the detail. */
  email: string | null
  /** The guess (or a tie's two), leading the list. */
  guess: boolean
  pick: NamePick
  /** A person or Me: Remember voice applies. */
  person: boolean
  hasVoice: boolean
}

/** Where a guess came from, under its name in the list. */
function guessSource(c: SpeakerCandidate, app: string | null): string {
  if (c.source === 'voice') return S.guessByVoice()
  if (c.source === 'app') return app ? S.guessTileIn(app) : S.guessFromApp()
  if (c.source === 'elimination') return S.guessFromGuestList()
  return S.guessFromConversation()
}

/** The source line under the label of an automatic name: where it came from. A guess's source is in the list. */
function sourceLines(view: SpeakerNoteView, identity: SpeakerIdentity, turn: IdentityTurn | null, display: SpeakerDisplay): string[] {
  const app = view.app
  if (display.band !== 'auto') return []
  // A kept `att` inside an auto cluster: that name, from the meeting app.
  if (turn?.nameSource === 'attribution') return app ? [S.sourceFromApp(app)] : []
  const src = identity.autoSource
  if (src === 'voice') return [S.sourceRecognizedByVoice()]
  if (src === 'app+voice') return app ? [S.sourceFromAppAndVoice(app)] : [S.sourceRecognizedByVoice()]
  if (src === 'app' && app) return [S.sourceFromApp(app)]
  return []
}

/** The roster's person or attendee behind a name, so a name from a meeting app gets the right person. */
function whoIs(name: string, personId: string | null | undefined, roster: readonly SpeakerRosterRow[]): NotTarget {
  if (personId) return { personId, name }
  const r = roster.find((x) => !x.isSelf && sameSpeakerName(x.name, name))
  return r?.personId ? { personId: r.personId, name } : r?.email ? { name, email: r.email } : { name }
}

/** The names "Not <name>" can clear: an auto name, or the guesses, with or without a person yet. */
function notTargets(identity: SpeakerIdentity, display: SpeakerDisplay, row: SpeakerNameSuggestion | undefined, roster: readonly SpeakerRosterRow[]): NotTarget[] {
  if (display.band === 'auto' && identity.state === 'auto' && identity.name) return [whoIs(identity.name, identity.personId, roster)]
  if (!display.soft || !row) return []
  return row.candidates.slice(0, 2).map((c) => whoIs(c.name, c.personId, roster))
}

function optionKey(personId: string | undefined, email: string | undefined, name: string): string {
  return personId ? `p:${personId}` : email ? `e:${email.toLowerCase()}` : `n:${name.toLowerCase()}`
}

function pickOf(name: string, personId: string | undefined, email: string | undefined): NamePick {
  return personId ? { name, personId, fromList: true } : email ? { name, email, fromList: true } : { name, newName: name, fromList: true }
}

function buildOptions(
  identity: SpeakerIdentity,
  row: SpeakerNameSuggestion | undefined,
  roster: readonly SpeakerRosterRow[],
  query: string,
  app: string | null,
  pending: PendingPerson | null
): Option[] {
  const q = query.trim()
  const ql = q.toLowerCase()
  const match = (name: string, email?: string): boolean => !ql || name.toLowerCase().includes(ql) || (email ?? '').toLowerCase().includes(ql)
  const out: Option[] = []
  const seen = new Set<string>()
  const push = (o: Option): void => {
    if (seen.has(o.key)) return
    seen.add(o.key)
    out.push(o)
  }
  // The guess first, so Enter accepts it: the waiting person, or the row's candidates (both for a tie).
  if (row?.pending && pending && match(pending.name)) {
    const r = roster.find((x) => x.personId === pending.personId)
    push({
      key: optionKey(pending.personId, undefined, pending.name),
      name: pending.name,
      detail: null,
      email: r?.email ?? null,
      guess: true,
      pick: { name: pending.name, personId: pending.personId, fromList: true },
      person: true,
      hasVoice: r?.hasVoice ?? false
    })
  }
  for (const c of row && !row.pending ? row.candidates : []) {
    const r = roster.find((x) => !x.isSelf && (c.personId ? x.personId === c.personId : sameSpeakerName(x.name, c.name)))
    const personId = c.personId ?? r?.personId
    if (!match(c.name, r?.email)) continue
    push({
      key: optionKey(personId, r?.email, c.name),
      name: c.name,
      detail: guessSource(c, app),
      email: r?.email ?? null,
      guess: true,
      pick: pickOf(c.name, personId, r?.email),
      person: true,
      hasVoice: r?.hasVoice ?? false
    })
  }
  const mic = identity.channel === 'microphone'
  const add = (r: SpeakerRosterRow): void => {
    if (r.isSelf && !mic) return
    push({
      key: optionKey(r.personId, r.email, r.name),
      name: r.isSelf ? SPEAKER_LABEL_ME : r.name,
      detail: r.isSelf ? r.name : null,
      email: r.isSelf ? null : (r.email ?? null),
      guess: false,
      pick: r.isSelf ? { name: SPEAKER_LABEL_ME, self: true, fromList: true } : pickOf(r.name, r.personId, r.email),
      person: true,
      hasVoice: r.hasVoice
    })
  }
  // Attendees, then Me (mic speakers only), then recent people (the roster's own order).
  for (const r of roster) if (r.attendee) add(r)
  for (const r of roster) if (r.isSelf && match(SPEAKER_LABEL_ME)) add(r)
  for (const r of roster) if (!r.attendee && !r.isSelf) add(r)
  // A typed name nobody has: a new person.
  if (q && !out.some((o) => sameSpeakerName(o.name, q))) {
    out.push({ key: `new:${ql}`, name: q, detail: null, email: null, guess: false, pick: { name: q, newName: q, fromList: false, edited: true }, person: true, hasVoice: false })
  }
  // The name gets the width: an email shows only to tell two people of one name apart.
  for (const o of out) {
    if (!o.detail && o.email && out.some((x) => x !== o && sameSpeakerName(x.name, o.name))) o.detail = o.email
  }
  return out
}

/** Fixed placement under (or over) the anchor, inside the window. */
function usePlacement(anchor: RefObject<HTMLElement | null>, el: RefObject<HTMLElement | null>, deps: unknown[]): { left: number; top: number } | null {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const place = (): void => {
      const a = anchor.current?.getBoundingClientRect()
      const p = el.current
      if (!a || !p) return
      const w = p.offsetWidth
      const h = p.offsetHeight
      const left = Math.max(MARGIN, Math.min(a.left, window.innerWidth - w - MARGIN))
      let top = a.bottom + GAP
      if (top + h > window.innerHeight - MARGIN) top = Math.max(MARGIN, a.top - h - GAP)
      setPos({ left, top })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps
  return pos
}

export interface SpeakerPopoverProps {
  view: SpeakerNoteView
  identity: SpeakerIdentity
  display: SpeakerDisplay
  /** The pill's turn; null from the who's-who sheet ("Someone else…"), which has no Only this turn. */
  turn: IdentityTurn | null
  anchor: RefObject<HTMLElement | null>
  onClose(): void
}

export function SpeakerPopover({ view, identity, display, turn, anchor, onClose }: SpeakerPopoverProps): JSX.Element {
  const prefs = useSpeechPrefs()
  const status = useSpeakersStatus()
  const row = view.rows.get(identity.key)
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [onlyTurn, setOnlyTurn] = useState(false)
  const [remember, setRemember] = useState<ReadonlyMap<string, boolean>>(new Map())
  const [agreements, setAgreements] = useState<ReadonlyMap<string, boolean>>(new Map())
  const [playing, setPlaying] = useState(false)
  const [linesShown, setLinesShown] = useState(false)
  const [pending, setPending] = useState<PendingPerson | null>(null)
  const clip = useClipAvailable(view.noteId)
  // Without audio there's nothing to play: the lines show at once.
  const lines = linesShown || clip === false
  const stopRef = useRef<() => void>(() => undefined)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const roster = useRoster(view.noteId, query, true)
  const options = useMemo(() => buildOptions(identity, row, roster, query, view.app, pending), [identity, row, roster, query, view.app, pending])
  const current = options[Math.min(active, options.length - 1)]
  const pos = usePlacement(anchor, ref, [options.length, lines, pending])
  const target = { noteId: view.noteId, identityKey: identity.key, passId: view.passId }

  const voicesOn = prefs?.['speakers.voices'] === true
  const selfVoiceOn = prefs?.['speakers.selfVoice'] === true

  useEffect(() => {
    inputRef.current?.focus()
    return () => stopRef.current()
  }, [])

  // A pending row's person, from the note's requests.
  useEffect(() => {
    if (!row?.pending) return
    let alive = true
    void pendingPeople(view.noteId)
      .then((people) => {
        if (alive) setPending(pendingPersonFor(row, people))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [row, view.noteId])

  // Remember voice defaults on when the person has an agreement record: read when they become the active choice.
  const activePerson = current?.pick.personId
  useEffect(() => {
    if (!voicesOn || !activePerson || agreements.has(activePerson)) return
    let alive = true
    void window.notula.speakerPeople
      .get({ personId: activePerson })
      .then((v) => {
        if (alive) setAgreements((m) => new Map(m).set(activePerson, !!v.agreement && !v.agreement.revokedAt))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [voicesOn, activePerson, agreements])

  // Esc and an outside click close; focus goes back to the pill.
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return
      closeRef.current()
    }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [anchor])

  const close = (): void => {
    onClose()
    anchor.current?.focus()
  }

  /** Remember voice for an option: shown for a person or Me while the layers are on. */
  const rememberShown = (o: Option | undefined): boolean => {
    if (!o?.person || onlyTurn || !voicesOn) return false
    return o.pick.self ? selfVoiceOn : true
  }
  const rememberDefault = (o: Option): boolean => {
    if (o.pick.self) return status?.self.present === true
    if (o.hasVoice) return true
    return o.pick.personId ? agreements.get(o.pick.personId) === true : false
  }
  const rememberOf = (o: Option | undefined): boolean => (o && rememberShown(o) ? (remember.get(o.key) ?? rememberDefault(o)) : false)

  const pick = (o: Option | undefined, rememberIt = rememberOf(o)): void => {
    if (!o) return
    stopRef.current()
    onClose()
    void nameSpeaker(target, o.pick, {
      remember: rememberIt,
      ...(row?.hasVoiceSample !== undefined ? { hasVoiceSample: row.hasVoiceSample } : {}),
      ...(onlyTurn && turn ? { turnChunkIds: turn.chunkIds } : {})
    })
  }

  const toggleRemember = (o: Option): void => {
    const next = !rememberOf(o)
    setRemember((m) => new Map(m).set(o.key, next))
    // Turned on for someone without an agreement: the naming goes ahead now, and the agreement
    // sheet comes first, before any name is written. Its outcome decides the rest.
    const personId = o.pick.personId
    if (next && !o.pick.self && !o.hasVoice && !(personId && agreements.get(personId) === true)) pick(o, true)
  }

  const play = async (): Promise<void> => {
    if (playing) {
      stopRef.current()
      return
    }
    setPlaying(true)
    const r = await playClip(view.noteId, identity.key, () => setPlaying(false))
    if (r.ok) stopRef.current = r.stop
    else {
      setPlaying(false)
      setLinesShown(true)
    }
  }

  const onKey = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!options.length) return
      e.preventDefault()
      const d = e.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (Math.min(i, options.length - 1) + d + options.length) % options.length)
    } else if (e.key === 'Enter' && e.target === inputRef.current) {
      e.preventDefault()
      pick(current)
    }
  }

  const longest = useMemo(
    () =>
      [...(view.turns.get(identity.key) ?? [])]
        .sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs))
        .slice(0, 2)
        .map((t) => t.text),
    [view.turns, identity.key]
  )
  const nots = notTargets(identity, display, row, roster)
  const sources = sourceLines(view, identity, turn, display)
  const activeId = current ? `${listId}-${options.indexOf(current)}` : undefined
  const guesses = options.filter((o) => o.guess).length

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={display.text}
      className="nt-spk-pop"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
      onKeyDown={onKey}
    >
      <div className="nt-spk-pop__head">
        <span className={`nt-spk-pop__label ${colourClass(view, identity.key)}${display.soft ? ' is-soft' : ''}`}>{display.text}</span>
        {row?.pending && pending ? (
          <span className="nt-spk-pop__source">{S.waitingForReply(pending.name)}</span>
        ) : (
          sources.map((s) => (
            <span key={s} className="nt-spk-pop__source">
              {s}
            </span>
          ))
        )}
      </div>

      {(clip === true && !lines) || nots.length > 0 ? (
        <div className="nt-spk-pop__tools">
          {clip === true && !lines && (
            <button type="button" className="nt-spk-play" aria-pressed={playing} onClick={() => void play()}>
              {playing ? <StopGlyph /> : <PlayGlyph />}
              {playing ? S.popoverStop() : S.popoverPlay()}
            </button>
          )}
          {nots.map((n) => (
            <button
              key={n.personId ?? n.email ?? n.name}
              type="button"
              className="nt-spk-not"
              onClick={() => {
                // The popover stays open on the list.
                void notPerson(view.noteId, identity.key, n)
                inputRef.current?.focus()
              }}
            >
              {S.popoverNot(n.name)}
            </button>
          ))}
        </div>
      ) : null}
      {lines && longest.length > 0 && (
        <ul className="nt-spk-lines">
          {longest.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      )}

      <div className="nt-spk-list" role="listbox" id={listId} aria-label={display.text}>
        {options.map((o, i) => (
          <div
            key={o.key}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={o === current}
            title={o.email && o.detail !== o.email ? o.email : undefined}
            className={`nt-spk-opt${o === current ? ' is-active' : ''}${o.guess ? ' is-guess' : ''}${o.guess && i === guesses - 1 ? ' is-last-guess' : ''}`}
            onMouseMove={() => {
              if (o !== current) setActive(i)
            }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(o)}
          >
            <span className="nt-spk-opt__avatar" aria-hidden="true">
              {o.key.startsWith('new:') ? '+' : initials(o.name)}
            </span>
            <span className="nt-spk-opt__text">
              <span className="nt-spk-opt__name">{o.name}</span>
              {o.detail && <span className={`nt-spk-opt__detail${o.guess ? ' is-suggested' : ''}`}>{o.detail}</span>}
            </span>
          </div>
        ))}
      </div>
      <input
        ref={inputRef}
        className="nt-spk-search"
        placeholder={S.popoverSearch()}
        aria-label={S.popoverSearch()}
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={activeId}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setActive(0)
        }}
      />

      {(rememberShown(current) || turn) && (
        <div className="nt-spk-pop__foot">
          {rememberShown(current) && current && (
            <label className="nt-spk-remember">
              <button type="button" role="switch" aria-checked={rememberOf(current)} className="nt-spk-switch" onClick={() => toggleRemember(current)}>
                <span className="nt-spk-switch__thumb" />
              </button>
              <span>{S.popoverRememberVoice()}</span>
            </label>
          )}
          {turn && (
            <button type="button" className="nt-spk-only" aria-pressed={onlyTurn} onClick={() => setOnlyTurn((v) => !v)}>
              {S.popoverOnlyThisTurn()}
            </button>
          )}
        </div>
      )}
    </div>,
    document.body
  )
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase() || '·'
}

function Chevron(): JSX.Element {
  return (
    <svg className="nt-spk-pill__chev" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
      <path d="M1.5 3 4 5.5 6.5 3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function PlayGlyph(): JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2.5 1.5v7l6-3.5z" fill="currentColor" />
    </svg>
  )
}

export function StopGlyph(): JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="2" y="2" width="6" height="6" rx="1" fill="currentColor" />
    </svg>
  )
}
