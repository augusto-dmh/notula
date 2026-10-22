// SPDX-License-Identifier: Apache-2.0
// The speaker-name suggestion card,
// in two places: the banner at the top of the note page and the top of the transcript panel.
//
// - The first stored row with a name becomes the card; its label is recomputed from the current
//   transcript (the identity's name or `Speaker <letter>`), and a row whose identity is gone or
//   already named is hidden.
// - Verdict: "<label> seems to be <name>", `Not them` / `Confirm` (`Saving…`), the excerpts as
//   quotes with their time; the label and the quotes open the transcript at that passage.
// - `Not them` opens "Who was <label>?": a name field with the roster (Attendees, You, People,
//   In this transcript), `Use this` / `Confirm`, and × (`Not this speaker`).
// No card while the setting is off or the note is transcribing.

import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { speakerIdentities } from '@shared/lib/speakers'
import type { Note } from '@shared/types/notes'
import type { SpeakerNameSuggestion } from '@shared/types/transcript'
import { navigate } from '../../app/navigation'
import { showToast } from '../../app/toast'
import { useCaptureSnapshot } from '../capture/store'
import { useSpeechPrefs } from './speech-state'
import { useLiveTranscript } from './live-transcript'
import './speaker-names.css'

interface RosterOption {
  name: string
  group: 'Attendees' | 'You' | 'People' | 'In this transcript'
  note: string | null
  used: boolean
}

function hhmm(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function useSuggestions(noteId: string): SpeakerNameSuggestion[] {
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

export function SpeakerNameCard({ noteId, variant }: { noteId: string; variant: 'banner' | 'panel' }): JSX.Element | null {
  const prefs = useSpeechPrefs()
  const cap = useCaptureSnapshot()
  const rows = useSuggestions(noteId)
  const { chunks, loaded } = useLiveTranscript(noteId)
  const note = useNote(noteId)
  const [mode, setMode] = useState<'verdict' | 'edit'>('verdict')
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [picked, setPicked] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const analysis = useMemo(() => speakerIdentities(chunks, { live: false }), [chunks])
  const card = useMemo(() => {
    for (const r of rows) {
      if (!r.name) continue
      const id = analysis.identities.find((i) => i.key === r.identityKey)
      // A row whose identity is no longer visible, or already named, is hidden.
      if (loaded && (!id || (id.name && !id.sharedName))) continue
      const turns = analysis.turns.filter((t) => t.identityKey === r.identityKey)
      return { row: r, label: id?.letterLabel ?? r.label, turns }
    }
    return null
  }, [rows, analysis, loaded])

  // A new card starts as a verdict.
  const cardKey = card?.row.identityKey ?? ''
  useEffect(() => {
    setMode('verdict')
    setDraft(card?.row.name ?? '')
    setPicked(false)
  }, [cardKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const roster = useMemo((): RosterOption[] => {
    const out: RosterOption[] = []
    const seen = new Set<string>()
    const named = new Set(analysis.identities.filter((i) => i.name).map((i) => i.name as string))
    const attributed = new Set(analysis.turns.filter((t) => t.name).map((t) => t.name as string))
    const add = (name: string | undefined, group: RosterOption['group'], note: string | null): void => {
      const n = name?.trim()
      if (!n || seen.has(n.toLowerCase())) return
      seen.add(n.toLowerCase())
      const status = named.has(n) ? 'Already named' : attributed.has(n) ? 'Already attributed' : null
      out.push({ name: n, group, note: [note, status].filter(Boolean).join(' · ') || null, used: status !== null })
    }
    const myEmail = prefs?.['profile.email']?.trim().toLowerCase() ?? ''
    for (const a of note?.linked_event?.attendees ?? []) {
      if (a.self || a.resource || (myEmail && a.email?.toLowerCase() === myEmail)) continue
      add(a.displayName ?? a.email?.split('@')[0], 'Attendees', a.email ?? null)
    }
    const me = prefs?.['profile.name']?.trim()
    if (me) add(me, 'You', `${prefs?.['profile.email'] ? `${prefs['profile.email']} ` : ''}(you)`.trim())
    for (const p of note?.people?.attendees ?? []) add(p.name ?? p.email?.split('@')[0], 'People', p.email ?? null)
    for (const n of [...named, ...attributed]) add(n, 'In this transcript', null)
    return out
  }, [analysis, note, prefs])

  if (!prefs?.['speakerNames.suggestions'] || cap.transcribingNoteId === noteId || !card || note?.deleted_at) return null
  const { row, label, turns } = card

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

  const accept = async (name: string, edited: boolean, chosenFromList: boolean): Promise<void> => {
    const n = name.trim()
    if (!n || busy) return
    setBusy(true)
    try {
      const { chunksNamed } = await window.notula.speakerNames.accept({ noteId, identityKey: row.identityKey, name: n, edited, chosenFromList })
      showToast({
        id: 'speaker-names-accept',
        kind: 'success',
        title: chunksNamed > 0 ? `Named ${chunksNamed} ${chunksNamed === 1 ? 'passage' : 'passages'} as ${n}` : `Nothing to name as ${n}`
      })
    } catch (err) {
      showToast({ id: 'speaker-names-accept', kind: 'error', title: err instanceof Error ? err.message.replace(/^.*?: /, '') : 'Could not name this speaker' })
    } finally {
      setBusy(false)
    }
  }

  const reject = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await window.notula.speakerNames.reject({ noteId, identityKey: row.identityKey })
    } catch {
      // The card stays; nothing changed.
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
          <button type="button" className="n-btn n-btn--sm" disabled={busy} onClick={() => setMode('edit')}>
            Not them
          </button>
          <button type="button" className="n-btn n-btn--sm n-btn--primary" disabled={busy} onClick={() => void accept(row.name ?? '', false, false)}>
            {busy ? 'Saving…' : 'Confirm'}
          </button>
        </div>
      </div>
    )
  }

  const filtered = roster.filter((o) => !draft.trim() || o.name.toLowerCase().includes(draft.trim().toLowerCase()))
  const edited = draft.trim() !== (row.name ?? '').trim()
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void accept(draft, edited, picked)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (pickerOpen) setPickerOpen(false)
      else void reject()
    }
  }
  const groups: RosterOption['group'][] = ['Attendees', 'You', 'People', 'In this transcript']
  return (
    <div className={`nt-sn nt-sn--${variant} nt-sn--edit`} role="region" aria-label="Name this speaker">
      <div className="nt-sn__head">
        <span className="nt-sn__line">Who was {label}?</span>
        <button type="button" className="n-icon-btn n-icon-btn--sm" aria-label="Not this speaker" title="Not this speaker" disabled={busy} onClick={() => void reject()}>
          ×
        </button>
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
            setPicked(false)
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
                      setPicked(true)
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
        <button type="button" className="n-btn n-btn--sm n-btn--primary" disabled={busy || !draft.trim()} onClick={() => void accept(draft, edited, picked)}>
          {busy ? 'Saving…' : edited ? 'Use this' : 'Confirm'}
        </button>
      </div>
    </div>
  )
}
