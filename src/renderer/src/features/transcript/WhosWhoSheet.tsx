// SPDX-License-Identifier: Apache-2.0
// The who's-who sheet: one row per unnamed speaker, by speech time.
//
// Each row: Play (or the speaker's two longest lines without audio), the letter and the channel
// ("on the call" / "in the room"), the guess as a one-tap chip ("Ana?", or both for a tie), the
// attendees as chips, Someone else… (the popover's list), Skip with an Undo toast, and a
// Remember voice switch with the pill's default. A pending row says "Waiting for Ana's reply"
// and, once the agreement is recorded, offers "Name Ana". A tap names at once (Undo toast);
// the sheet stays open on the remaining rows and closes when none are left. Disabled while the
// job runs. Opened from the card's Name them / Name all speakers.

import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { sameSpeakerName, suggestionDisplay, type SpeakerDisplay } from '@shared/lib/speakers'
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
  useRoster,
  type NamePick,
  type PendingPerson,
  type UnnamedSpeaker
} from './speaker-state'
import * as S from '../speaker-profiles/strings'

export function WhosWhoSheet({ view, speakers, onClose }: { view: SpeakerNoteView; speakers: UnnamedSpeaker[]; onClose(): void }): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const roster = useRoster(view.noteId, '', true)
  const [pending, setPending] = useState<PendingPerson[]>([])
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
          <button type="button" className="n-btn n-btn--sm n-btn--primary" onClick={onClose}>
            {S.sheetDone()}
          </button>
        </header>
        {view.busy && <div className="nt-spk-quiet">{S.namingSpeakers()}</div>}
        <ul className="nt-spk-rows" aria-disabled={view.busy || undefined}>
          {speakers.map((s) => (
            <SheetRow key={s.identity.key} view={view} speaker={s} roster={roster} pending={pendingPersonFor(s.row, pending)} />
          ))}
        </ul>
      </div>
    </div>,
    document.body
  )
}

function SheetRow({ view, speaker, roster, pending }: { view: SpeakerNoteView; speaker: UnnamedSpeaker; roster: readonly SpeakerRosterRow[]; pending: PendingPerson | null }): JSX.Element {
  const prefs = useSpeechPrefs()
  const { identity, row } = speaker
  const letter = identity.letterLabel ?? ''
  const display: SpeakerDisplay = row ? suggestionDisplay({ ...row, label: letter }) : { text: letter, band: 'none', soft: false, guesses: [] }
  const otherRef = useRef<HTMLButtonElement>(null)
  const [other, setOther] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [lines, setLines] = useState(false)
  const stopRef = useRef<() => void>(() => undefined)
  const disabled = view.busy
  const target = { noteId: view.noteId, identityKey: identity.key, passId: view.passId }
  const voicesOn = prefs?.['speakers.voices'] === true

  useEffect(() => () => stopRef.current(), [])

  // The guess chips: one for suggest, both for a tie, each with its person when known.
  const guesses = useMemo((): NamePick[] => {
    if (!row || row.pending || !display.soft) return []
    return display.guesses.map((name) => {
      const c = row.candidates.find((x) => sameSpeakerName(x.name, name))
      return c?.personId ? { name, personId: c.personId, fromList: true } : { name, newName: name, fromList: true }
    })
  }, [row, display])
  const attendees = useMemo(
    () => roster.filter((r) => r.attendee && !guesses.some((g) => (g.personId && r.personId ? g.personId === r.personId : sameSpeakerName(g.name, r.name)))),
    [roster, guesses]
  )
  // Remember voice per row: on by default when the top guess's person has a voice.
  const topVoice = guesses[0]?.personId ? roster.some((r) => r.personId === guesses[0]?.personId && r.hasVoice) : false
  const [remember, setRemember] = useState<boolean | null>(null)
  const rememberOn = remember ?? topVoice

  const name = (pick: NamePick): void => {
    if (disabled) return
    void nameSpeaker(target, pick, { remember: voicesOn && rememberOn })
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
      setLines(true)
    }
  }

  const longest = [...(view.turns.get(identity.key) ?? [])].sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs)).slice(0, 2)

  return (
    <li className="nt-spk-row">
      <div className="nt-spk-row__head">
        {!lines && (
          <button type="button" className="nt-spk-play nt-spk-play--round" aria-label={playing ? S.popoverStop() : S.popoverPlay()} aria-pressed={playing} onClick={() => void play()}>
            {playing ? <StopGlyph /> : <PlayGlyph />}
          </button>
        )}
        <span className={`nt-spk-pill nt-spk-pill--static ${colourClass(view, identity.key)}`}>{letter}</span>
        <span className="nt-spk-row__channel">{identity.channel === 'microphone' ? S.channelInTheRoom() : S.channelOnTheCall()}</span>
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
        {attendees.map((r) => (
          <button
            key={r.personId ?? r.email ?? r.name}
            type="button"
            className="nt-spk-chip"
            disabled={disabled}
            onClick={() => name(r.personId ? { name: r.name, personId: r.personId, fromList: true } : r.email ? { name: r.name, email: r.email, fromList: true } : { name: r.name, newName: r.name, fromList: true })}
          >
            {r.name}
          </button>
        ))}
        <button ref={otherRef} type="button" className="nt-spk-chip is-other" disabled={disabled} aria-haspopup="dialog" aria-expanded={other} onClick={() => setOther((v) => !v)}>
          {S.someoneElse()}
        </button>
        {other && !disabled && <SpeakerPopover view={view} identity={identity} display={display} turn={null} anchor={otherRef} onClose={() => setOther(false)} />}
      </div>
      {voicesOn && (
        <label className="nt-spk-remember nt-spk-remember--row">
          <button type="button" role="switch" aria-checked={rememberOn} className="nt-spk-switch" disabled={disabled} onClick={() => setRemember(!rememberOn)}>
            <span className="nt-spk-switch__thumb" />
          </button>
          <span>{S.popoverRememberVoice()}</span>
        </label>
      )}
    </li>
  )
}
