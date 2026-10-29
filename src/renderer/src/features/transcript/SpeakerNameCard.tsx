// SPDX-License-Identifier: Apache-2.0
// The speaker-name suggestion card, the one entry point of who's who,
// in two places: the banner at the top of the note page and the top of the transcript panel.
//
// - It covers every unnamed speaker (neither confirmed nor auto; live `att` doesn't hide one).
//   The first one with the conversation's verdict becomes "<label> seems to be <name>" with
//   `Not them` / `Confirm` (`Saving…`), the excerpts as quotes with their time (the label and
//   the quotes open the transcript at that passage), and "Name all speakers (<n>)". Without a
//   verdict it says "<n> speakers to name" with Name them. Both open the who's-who sheet. It
//   disappears when nobody is left.
// - `Not them` opens "Who was <label>?": a name field with the roster (Attendees, You, People,
//   In this transcript), `Use this` / `Confirm`, and × ("Not <name>"), which stores `not-person`
//   for the name shown; Skip lives only in the sheet. Accept sends the roster's person id or
//   email, and names with an Undo toast. Confirm and Use this can add a sample: with no
//   Remember switch on the card, Remember voice takes the pill's default, on only when the person already has a voice or an active agreement.
// No card while the note is transcribing or its job runs; the verdict only while
// `speakerNames.suggestions` is on.

import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { sameSpeakerName } from '@shared/lib/speakers'
import type { Note } from '@shared/types/notes'
import type { SpeakerRosterRow } from '@shared/types/speakers'
import { SPEAKER_LABEL_ME, type SpeakerNameSuggestion } from '@shared/types/transcript'
import { navigate } from '../../app/navigation'
import { showToast } from '../../app/toast'
import { useCaptureSnapshot } from '../capture/store'
import { useSpeechPrefs } from './speech-state'
import { useLiveTranscript } from './live-transcript'
import { useSpeakerNote } from './speaker-note'
import { nameSpeaker, notPerson, useRoster, useSpeakersStatus, type NamePick } from './speaker-state'
import * as S from '../speaker-profiles/strings'
import { WhosWhoSheet } from './WhosWhoSheet'
import './speaker-names.css'

interface RosterOption {
  name: string
  group: 'Attendees' | 'You' | 'People' | 'In this transcript'
  note: string | null
  used: boolean
  pick: NamePick
}

function hhmm(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function useNote(noteId: string): Note | null {
  const [note, setNote] = useState<Note | null>(null)
  useEffect(() => {
    let alive = true
    void window.notula.notes
      .get({ id: noteId })
      .then((n) => {
        if (alive) setNote(n)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [noteId])
  return note
}

/** The person behind a name: the row's candidate, else a roster entry of that name. */
function pickFor(name: string, row: SpeakerNameSuggestion, roster: readonly SpeakerRosterRow[], fromList: boolean): NamePick {
  const c = row.candidates.find((x) => x.personId && sameSpeakerName(x.name, name))
  if (c?.personId) return { name, personId: c.personId, fromList }
  const r = roster.find((x) => !x.isSelf && sameSpeakerName(x.name, name))
  if (r?.personId) return { name, personId: r.personId, fromList }
  if (r?.email) return { name, email: r.email, fromList }
  return { name, newName: name, fromList }
}

export function SpeakerNameCard({ noteId, variant }: { noteId: string; variant: 'banner' | 'panel' }): JSX.Element | null {
  const prefs = useSpeechPrefs()
  const cap = useCaptureSnapshot()
  const { chunks, loaded } = useLiveTranscript(noteId)
  const capturing = cap.transcribingNoteId === noteId
  const { view, identityTurns, unnamed } = useSpeakerNote(noteId, chunks, capturing)
  const note = useNote(noteId)
  const [mode, setMode] = useState<'verdict' | 'edit'>('verdict')
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [picked, setPicked] = useState<NamePick | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [sheet, setSheet] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const suggestionsOn = prefs?.['speakerNames.suggestions'] === true
  const voicesOn = prefs?.['speakers.voices'] === true
  const selfVoiceOn = prefs?.['speakers.selfVoice'] === true
  const status = useSpeakersStatus()
  const roster = useRoster(noteId, '', !capturing && unnamed.length > 0)

  const card = useMemo(() => {
    if (!suggestionsOn) return null
    const hit = unnamed.find((u) => !!u.row.name && !u.row.pending)
    if (!hit) return null
    const turns = identityTurns.filter((t) => t.identityKey === hit.identity.key)
    return { row: hit.row, label: hit.identity.letterLabel ?? hit.row.label, turns }
  }, [suggestionsOn, unnamed, identityTurns])

  // A new card starts as a verdict.
  const cardKey = card?.row.identityKey ?? ''
  useEffect(() => {
    setMode('verdict')
    setDraft(card?.row.name ?? '')
    setPicked(null)
  }, [cardKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const options = useMemo((): RosterOption[] => {
    const out: RosterOption[] = []
    const seen = new Set<string>()
    const named = new Set([...view.identities.values()].filter((i) => i.name).map((i) => i.name as string))
    const attributed = new Set(identityTurns.filter((t) => t.name).map((t) => t.name as string))
    const add = (name: string | undefined, group: RosterOption['group'], note: string | null, pick: NamePick): void => {
      const n = name?.trim()
      if (!n || seen.has(n.toLowerCase())) return
      seen.add(n.toLowerCase())
      const status = named.has(n) ? 'Already named' : attributed.has(n) ? 'Already attributed' : null
      out.push({ name: n, group, note: [note, status].filter(Boolean).join(' · ') || null, used: status !== null, pick })
    }
    for (const r of roster) {
      if (r.isSelf) {
        if (card && view.identities.get(card.row.identityKey)?.channel === 'microphone') {
          add(SPEAKER_LABEL_ME, 'You', `${r.name} (you)`, { name: SPEAKER_LABEL_ME, self: true, fromList: true })
        }
        continue
      }
      const pick: NamePick = r.personId ? { name: r.name, personId: r.personId, fromList: true } : r.email ? { name: r.name, email: r.email, fromList: true } : { name: r.name, newName: r.name, fromList: true }
      add(r.name, r.attendee ? 'Attendees' : 'People', r.email ?? null, pick)
    }
    for (const n of [...named, ...attributed]) add(n, 'In this transcript', null, { name: n, newName: n, fromList: true })
    return out
  }, [roster, view.identities, identityTurns, card])

  const ready = loaded && !capturing && !view.busy && !note?.deleted_at && unnamed.length > 0
  const sheetEl = sheet && <WhosWhoSheet view={view} speakers={unnamed} onClose={() => setSheet(false)} />
  if (!ready) return sheetEl || null

  if (!card) {
    return (
      <>
        <div className={`nt-sn nt-sn--${variant} nt-sn--count`} role="region" aria-label={S.speakersToName(unnamed.length)}>
          <span className="nt-sn__line">{S.speakersToName(unnamed.length)}</span>
          <button type="button" className="n-btn n-btn--sm n-btn--primary" onClick={() => setSheet(true)}>
            {S.nameThem()}
          </button>
        </div>
        {sheetEl}
      </>
    )
  }

  const { row, label, turns } = card
  const target = { noteId, identityKey: row.identityKey, passId: view.passId }

  const reveal = (quote: string, missing: string): void => {
    const q = quote.trim().toLowerCase()
    const hit = turns.find((t) => t.text.toLowerCase().includes(q))
    if (!q || !hit) {
      showToast({ id: 'speaker-names-reveal', kind: 'info', title: missing })
      return
    }
    navigate(`/meeting/${noteId}?reveal=${encodeURIComponent(quote.trim().slice(0, 200))}`, { replace: true })
  }

  const revealSpeaker = (): void => {
    const first = turns[0]?.text.split(/\s+/).slice(0, 8).join(' ') ?? ''
    reveal(first, "Couldn’t find this speaker’s words in the transcript")
  }

  /** Remember voice as the pill defaults it: Me with a self voice, a person with a voice or an active record. */
  const rememberFor = async (pick: NamePick): Promise<boolean> => {
    if (!voicesOn) return false
    if (pick.self) return selfVoiceOn && status?.self.present === true
    const r = roster.find((x) => !x.isSelf && (pick.personId ? x.personId === pick.personId : !!pick.email && x.email === pick.email))
    if (r?.hasVoice) return true
    if (!pick.personId) return false
    const v = await window.notula.speakerPeople.get({ personId: pick.personId }).catch(() => null)
    return !!v?.agreement && !v.agreement.revokedAt
  }

  const accept = async (pick: NamePick): Promise<void> => {
    if (!pick.name.trim() || busy) return
    setBusy(true)
    try {
      // A record withdrawn since makes main answer `needsAgreement`, and nameSpeaker opens the consent sheet.
      await nameSpeaker(target, pick, { remember: await rememberFor(pick) })
    } finally {
      setBusy(false)
    }
  }

  // × is "Not <name>" for the name shown: it needs that name's person.
  const shownName = row.name ?? ''
  const notId = (() => {
    const p = pickFor(shownName, row, roster, false)
    return p.personId ?? null
  })()
  const notThem = async (): Promise<void> => {
    if (!notId || busy) return
    setBusy(true)
    try {
      await notPerson(noteId, row.identityKey, notId, shownName)
    } finally {
      setBusy(false)
    }
  }

  const excerpts = row.transcriptExcerpts.map((text) => {
    const hit = turns.find((t) => t.text.toLowerCase().includes(text.replace(/…$/, '').toLowerCase()))
    return { text, at: hit ? hhmm(hit.startMs) : null }
  })

  if (mode === 'verdict') {
    return (
      <>
        <div className={`nt-sn nt-sn--${variant}`} role="region" aria-label="Speaker name suggestion">
          <div className="nt-sn__line">
            <button type="button" className="nt-sn__label" onClick={revealSpeaker}>
              {label}
            </button>{' '}
            seems to be <span className="nt-sn__name">{row.name}</span>
          </div>
          {excerpts.length > 0 && (
            <ul className="nt-sn__quotes">
              {excerpts.map((e, i) => (
                <li key={i}>
                  <button type="button" className="nt-sn__quote" onClick={() => reveal(e.text.replace(/…$/, ''), "Couldn’t find that quote in the transcript")}>
                    {e.at && <span className="nt-sn__time">{e.at}</span>}
                    <span className="nt-sn__text">{e.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="nt-sn__actions">
            {unnamed.length > 1 && (
              <button type="button" className="n-btn n-btn--sm n-btn--ghost nt-sn__all" onClick={() => setSheet(true)}>
                {S.nameAllSpeakers(unnamed.length)}
              </button>
            )}
            <button type="button" className="n-btn n-btn--sm" disabled={busy} onClick={() => setMode('edit')}>
              Not them
            </button>
            <button type="button" className="n-btn n-btn--sm n-btn--primary" disabled={busy} onClick={() => void accept(pickFor(shownName, row, roster, false))}>
              {busy ? 'Saving…' : 'Confirm'}
            </button>
          </div>
        </div>
        {sheetEl}
      </>
    )
  }

  const filtered = options.filter((o) => !draft.trim() || o.name.toLowerCase().includes(draft.trim().toLowerCase()))
  const edited = draft.trim() !== shownName.trim()
  const draftPick = (): NamePick => {
    const n = draft.trim()
    if (picked && sameSpeakerName(picked.name, n)) return { ...picked, edited }
    const exact = options.find((o) => sameSpeakerName(o.name, n))
    return exact ? { ...exact.pick, fromList: false, edited } : { name: n, newName: n, fromList: false, edited }
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void accept(draftPick())
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (pickerOpen) setPickerOpen(false)
      else setMode('verdict')
    }
  }
  const groups: RosterOption['group'][] = ['Attendees', 'You', 'People', 'In this transcript']
  return (
    <>
      <div className={`nt-sn nt-sn--${variant} nt-sn--edit`} role="region" aria-label="Name this speaker">
        <div className="nt-sn__head">
          <span className="nt-sn__line">Who was {label}?</span>
          {notId && (
            <button type="button" className="n-icon-btn n-icon-btn--sm" aria-label={S.popoverNot(shownName)} title={S.popoverNot(shownName)} disabled={busy} onClick={() => void notThem()}>
              ×
            </button>
          )}
        </div>
        <label className="nt-sn__field">
          <span className="nt-sn__field-label">Speaker name</span>
          <input
            ref={inputRef}
            className="n-input"
            placeholder="Type or pick a name"
            value={draft}
            autoFocus
            onFocus={() => setPickerOpen(true)}
            onBlur={() => setTimeout(() => setPickerOpen(false), 150)}
            onChange={(e) => {
              setDraft(e.target.value)
              setPicked(null)
              setPickerOpen(true)
            }}
            onKeyDown={onKeyDown}
          />
        </label>
        {pickerOpen && filtered.length > 0 && (
          <div className="nt-sn__picker" role="listbox" aria-label="Names">
            {groups.map((g) => {
              const items = filtered.filter((o) => o.group === g)
              if (!items.length) return null
              return (
                <div key={g} className="nt-sn__group">
                  <div className="nt-sn__group-title">{g}</div>
                  {items.map((o) => (
                    <button
                      key={`${g}:${o.name}`}
                      type="button"
                      role="option"
                      aria-selected={draft === o.name}
                      className={`nt-sn__option${o.used ? ' nt-sn__option--used' : ''}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setDraft(o.name)
                        setPicked(o.pick)
                        setPickerOpen(false)
                        inputRef.current?.focus()
                      }}
                    >
                      <span>{o.name}</span>
                      {o.note && <span className="nt-sn__option-note">{o.note}</span>}
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
        )}
        <div className="nt-sn__actions">
          <button type="button" className="n-btn n-btn--sm n-btn--primary" disabled={busy || !draft.trim()} onClick={() => void accept(draftPick())}>
            {busy ? 'Saving…' : edited ? 'Use this' : 'Confirm'}
          </button>
        </div>
      </div>
      {sheetEl}
    </>
  )
}
