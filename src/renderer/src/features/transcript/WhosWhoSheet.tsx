// SPDX-License-Identifier: Apache-2.0
// The who's-who sheet: one row per unnamed speaker, by speech time.
//
// Each row: Play when the note has audio (else the speaker's two longest lines), the letter and
// the channel ("on the call" / "in the room"), Skip with an Undo toast, then one primary chip
// and a compact menu. The chip is the guess ("Ana?", or both for a tie) or, on a pending row,
// "Waiting for Ana’s reply" in its place ("Name Ana" once the agreement is recorded). The menu
// holds the attendees and Someone else… (the popover's list). A Remember voice switch takes the
// pill's default. A tap names at once (Undo toast); the sheet stays open on the remaining rows
// and closes when none are left.
//
// Very short speakers and mic echo of the call fold under "N more" at the end. The header button
// says Done once nothing is left to name, Later otherwise. Disabled while the job runs. Opened
// from the card's Name them / Name all speakers.

import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { sameSpeakerName, suggestionDisplay, type IdentityTurn, type SpeakerDisplay } from '@shared/lib/speakers'
import type { SpeakerRosterRow } from '@shared/types/speakers'
import { useSpeechPrefs } from './speech-state'
import { colourClass, PlayGlyph, SpeakerPopover, StopGlyph, type SpeakerNoteView } from './SpeakerPill'
import {
  nameSpeaker,
  namePending,
  pendingPeople,
  pendingPersonFor,
  playClip,
  skipSpeaker,
  useClipAvailable,
  useRoster,
  type NamePick,
  type PendingPerson,
  type UnnamedSpeaker
} from './speaker-state'
import * as S from '../speaker-profiles/strings'

/** A speaker with less speech than this folds under "N more". */
const SHORT_MS = 8_000
/** A mic speaker whose speech overlaps the call's this much is echo of it. */
const ECHO_SHARE = 0.5

type Fold = 'short' | 'echo' | null

/** Each turn's time overlapping any of `others`, over the turns' total time. */
function overlapShare(turns: readonly IdentityTurn[], others: readonly IdentityTurn[]): number {
  let total = 0
  let shared = 0
  for (const t of turns) {
    const len = Math.max(0, t.endMs - t.startMs)
    total += len
    let covered = 0
    for (const o of others) covered += Math.max(0, Math.min(t.endMs, o.endMs) - Math.max(t.startMs, o.startMs))
    shared += Math.min(len, covered)
  }
  return total > 0 ? shared / total : 0
}

/** Why a speaker folds under "N more": very little speech, or the call's voices picked up by the mic. */
function foldOf(view: SpeakerNoteView, s: UnnamedSpeaker, callTurns: readonly IdentityTurn[]): Fold {
  if (s.row.pending || (s.row.candidates.length > 0 && s.row.band !== 'none')) return null
  if (s.identity.channel === 'microphone' && callTurns.length && overlapShare(view.turns.get(s.identity.key) ?? [], callTurns) >= ECHO_SHARE) return 'echo'
  return s.identity.speechMs < SHORT_MS ? 'short' : null
}

export function WhosWhoSheet({ view, speakers, onClose }: { view: SpeakerNoteView; speakers: UnnamedSpeaker[]; onClose(): void }): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const roster = useRoster(view.noteId, '', true)
  const clip = useClipAvailable(view.noteId)
  const [pending, setPending] = useState<PendingPerson[]>([])
  const [more, setMore] = useState(false)
  const hadRows = useRef(speakers.length > 0)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const anyPending = speakers.some((s) => s.row?.pending)

  useEffect(() => {
    ref.current?.focus()
  }, [])

  // The sheet closes once every speaker is named or skipped.
  useEffect(() => {
    if (speakers.length) hadRows.current = true
    else if (hadRows.current) closeRef.current()
  }, [speakers.length])

  useEffect(() => {
    if (!anyPending) return
    let alive = true
    const load = (): void => {
      void pendingPeople(view.noteId)
        .then((p) => {
          if (alive) setPending(p)
        })
        .catch(() => undefined)
    }
    load()
    const off = window.notula.speakerPeople.onChanged(load)
    return () => {
      alive = false
      off()
    }
  }, [anyPending, view.noteId])

  const { main, folded } = useMemo(() => {
    const call = [...view.identities.values()].filter((i) => i.channel !== 'microphone').flatMap((i) => view.turns.get(i.key) ?? [])
    const withFold = speakers.map((s) => ({ s, fold: foldOf(view, s, call) }))
    // Rows with a guess lead, as the likeliest to name in one tap; speech time orders the rest.
    const guessed = (x: { s: UnnamedSpeaker }): number => (!x.s.row.pending && x.s.row.band !== 'none' && x.s.row.candidates.length > 0 ? 1 : 0)
    const main = withFold.filter((x) => !x.fold).sort((a, b) => guessed(b) - guessed(a))
    return { main, folded: withFold.filter((x) => x.fold) }
  }, [speakers, view])
  // Done only when nothing is left to name: a row waiting for a reply asks nothing of the user.
  const left = speakers.filter((s) => !s.row.pending).length

  const row = (x: { s: UnnamedSpeaker; fold: Fold }): JSX.Element => (
    <SheetRow key={x.s.identity.key} view={view} speaker={x.s} roster={roster} clip={clip} fold={x.fold} pending={pendingPersonFor(x.s.row, pending)} />
  )

  return createPortal(
    <div className="nt-spk-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className="nt-spk-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={S.speakersToName(speakers.length)}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !e.defaultPrevented) {
            e.preventDefault()
            onClose()
          }
        }}
      >
        <header className="nt-spk-sheet__head">
          <h2 className="nt-spk-sheet__title">{S.speakersToName(speakers.length)}</h2>
          <button type="button" className={`n-btn n-btn--sm${left ? '' : ' n-btn--primary'}`} onClick={onClose}>
            {left ? S.sheetLater() : S.sheetDone()}
          </button>
        </header>
        {view.busy && <div className="nt-spk-quiet">{S.namingSpeakers()}</div>}
        <ul className="nt-spk-rows" aria-disabled={view.busy || undefined}>
          {main.map(row)}
          {folded.length > 0 && (
            <li className="nt-spk-more">
              <button type="button" className="nt-spk-more__toggle" aria-expanded={more} onClick={() => setMore((v) => !v)}>
                {more ? S.sheetFewer() : S.sheetMore(folded.length)}
              </button>
            </li>
          )}
          {more && folded.map(row)}
        </ul>
      </div>
    </div>,
    document.body
  )
}

function SheetRow({
  view,
  speaker,
  roster,
  clip,
  fold,
  pending
}: {
  view: SpeakerNoteView
  speaker: UnnamedSpeaker
  roster: readonly SpeakerRosterRow[]
  clip: boolean | null
  fold: Fold
  pending: PendingPerson | null
}): JSX.Element {
  const prefs = useSpeechPrefs()
  const { identity, row } = speaker
  const letter = identity.letterLabel ?? ''
  const display: SpeakerDisplay = row ? suggestionDisplay({ ...row, label: letter }) : { text: letter, band: 'none', soft: false, guesses: [] }
  const otherRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLSpanElement>(null)
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null)
  const [other, setOther] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [linesShown, setLinesShown] = useState(false)
  const lines = linesShown || clip === false
  const stopRef = useRef<() => void>(() => undefined)
  const disabled = view.busy
  const target = { noteId: view.noteId, identityKey: identity.key, passId: view.passId }
  const voicesOn = prefs?.['speakers.voices'] === true

  useEffect(() => () => stopRef.current(), [])

  // The menu closes on an outside click or Esc, back to its button.
  useEffect(() => {
    if (!menu) return
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const onDown = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [menu])

  // The guess chips: one for suggest, both for a tie, each with its person when known.
  const guesses = useMemo((): NamePick[] => {
    if (!row || row.pending || !display.soft) return []
    return display.guesses.map((name) => {
      const c = row.candidates.find((x) => sameSpeakerName(x.name, name))
      const r = roster.find((x) => !x.isSelf && (c?.personId ? x.personId === c.personId : sameSpeakerName(x.name, name)))
      const personId = c?.personId ?? r?.personId
      return personId ? { name, personId, fromList: true } : r?.email ? { name, email: r.email, fromList: true } : { name, newName: name, fromList: true }
    })
  }, [row, display, roster])
  const attendees = useMemo(
    () =>
      roster.filter(
        (r) =>
          r.attendee &&
          !guesses.some((g) => (g.personId && r.personId ? g.personId === r.personId : sameSpeakerName(g.name, r.name))) &&
          !(pending && r.personId === pending.personId)
      ),
    [roster, guesses, pending]
  )
  // Remember voice per row: on by default when the top guess's person has a voice.
  const topVoice = guesses[0]?.personId ? roster.some((r) => r.personId === guesses[0]?.personId && r.hasVoice) : false
  const [remember, setRemember] = useState<boolean | null>(null)
  const rememberOn = remember ?? topVoice

  const name = (pick: NamePick): void => {
    if (disabled) return
    setMenu(null)
    void nameSpeaker(target, pick, { remember: voicesOn && rememberOn, ...(row.hasVoiceSample !== undefined ? { hasVoiceSample: row.hasVoiceSample } : {}) })
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

  const onMenuKey = (e: KeyboardEvent<HTMLElement>): void => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setMenu(null)
      otherRef.current?.focus()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const d = e.key === 'ArrowDown' ? 1 : -1
      items[(i + d + items.length) % items.length]?.focus()
    }
  }

  const longest = [...(view.turns.get(identity.key) ?? [])].sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs)).slice(0, 2)
  const channel = identity.channel === 'microphone' ? S.channelInTheRoom() : S.channelOnTheCall()
  const why = fold === 'echo' ? S.sheetEchoSpeaker() : fold === 'short' ? S.sheetShortSpeaker() : null

  return (
    <li className={`nt-spk-row${fold ? ' is-folded' : ''}`}>
      <div className="nt-spk-row__head">
        {clip === true && !lines && (
          <button type="button" className="nt-spk-play nt-spk-play--round" aria-label={playing ? S.popoverStop() : S.popoverPlay()} aria-pressed={playing} onClick={() => void play()}>
            {playing ? <StopGlyph /> : <PlayGlyph />}
          </button>
        )}
        <span className={`nt-spk-pill nt-spk-pill--static ${colourClass(view, identity.key)}`}>{letter}</span>
        <span className="nt-spk-row__channel">{why ? `${channel} · ${why}` : channel}</span>
        <button type="button" className="nt-spk-row__skip" disabled={disabled} onClick={() => void skipSpeaker(view.noteId, identity.key, letter)}>
          {S.skip()}
        </button>
      </div>
      {lines && longest.length > 0 && (
        <ul className="nt-spk-lines">
          {longest.map((t, i) => (
            <li key={i}>{t.text}</li>
          ))}
        </ul>
      )}
      <div className="nt-spk-chips">
        {row?.pending && pending ? (
          pending.canName ? (
            <button type="button" className="nt-spk-chip is-guess" disabled={disabled} onClick={() => void namePending(view.noteId, identity.key, pending)}>
              {S.nameChip(pending.name)}
            </button>
          ) : (
            <span className="nt-spk-waiting">{S.waitingForReply(pending.name)}</span>
          )
        ) : (
          guesses.map((g) => (
            <button key={g.name} type="button" className="nt-spk-chip is-guess" disabled={disabled} onClick={() => name(g)}>
              {S.pillSuggest(g.name)}
            </button>
          ))
        )}
        <span className="nt-spk-menu" ref={menuRef} onKeyDown={onMenuKey}>
          <button
            ref={otherRef}
            type="button"
            className="nt-spk-chip is-other"
            disabled={disabled}
            aria-haspopup="menu"
            aria-expanded={!!menu || other}
            onClick={() => {
              // Fixed, so the sheet's scrolling list doesn't clip it.
              const r = otherRef.current?.getBoundingClientRect()
              setMenu((m) => (m || !r ? null : { left: r.left, top: r.bottom + 4 }))
            }}
          >
            {S.sheetChooseName()}
            <svg className="nt-spk-menu__chev" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
              <path d="M1.5 3 4 5.5 6.5 3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {menu && !disabled && (
            <span className="nt-spk-menu__list" role="menu" aria-label={S.sheetChooseName()} style={{ left: menu.left, top: menu.top }}>
              {attendees.map((r) => (
                <button
                  key={r.personId ?? r.email ?? r.name}
                  type="button"
                  role="menuitem"
                  title={r.email}
                  onClick={() => name(r.personId ? { name: r.name, personId: r.personId, fromList: true } : r.email ? { name: r.name, email: r.email, fromList: true } : { name: r.name, newName: r.name, fromList: true })}
                >
                  {r.name}
                </button>
              ))}
              <button
                type="button"
                role="menuitem"
                className="is-other"
                onClick={() => {
                  setMenu(null)
                  setOther(true)
                }}
              >
                {S.someoneElse()}
              </button>
            </span>
          )}
        </span>
        {other && !disabled && <SpeakerPopover view={view} identity={identity} display={display} turn={null} anchor={otherRef} onClose={() => setOther(false)} />}
        {voicesOn && !row?.pending && (
          <label className="nt-spk-remember nt-spk-remember--row">
            <button type="button" role="switch" aria-checked={rememberOn} className="nt-spk-switch" disabled={disabled} onClick={() => setRemember(!rememberOn)}>
              <span className="nt-spk-switch__thumb" />
            </button>
            <span>{S.popoverRememberVoice()}</span>
          </label>
        )}
      </div>
    </li>
  )
}
