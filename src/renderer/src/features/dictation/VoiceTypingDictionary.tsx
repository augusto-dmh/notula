// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Voice typing ▸ Dictionary (`voice-typing-dictionary`, a hidden sub-page). The
// dictionary lives in the encrypted database (`dictation:terms-*`); its usage counts never
// leave this computer.
//
// - One field both filters the list and, on Enter, adds what it holds.
// - Each row has star, edit and delete. Delete removes the term (it is never learned back) with
//   an Undo toast. Learned rows say so.
// - The limits (300 terms, 20 starred) answer inline.
// - The learn switch (`dictation.learnWords`), with a note that it needs screen context and an
//   AI provider.

import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { parseError } from '@shared/errors'
import { DICTATION_TERM_LIMITS, normaliseTerm, type DictationTerm, type DictationTermError, type DictationTermResult } from '@shared/types/dictation'
import { debugLog } from '../../app/platform'
import { showToast } from '../../app/toast'
import { Switch } from '../settings/controls'
import { SettingsRow } from '../settings/primitives'
import { setPrefs, usePrefs } from '../settings/prefs-store'
import './voice-typing.css'

const ERRORS: Record<DictationTermError, string> = {
  invalid: 'Use 1–50 characters and up to 6 words, without commas.',
  full: 'You can keep up to 300 terms. Delete one to add another.',
  'starred-full': 'You can star up to 20 terms. Unstar one to star another.',
  'not-found': 'That term was already deleted.'
}

const countLabel = (n: number): string => `${n} ${n === 1 ? 'term' : 'terms'}`

function useTerms(): DictationTerm[] | null {
  const [terms, setTerms] = useState<DictationTerm[] | null>(null)
  useEffect(() => {
    let live = true
    const read = (): void => {
      void window.notula.dictation.terms
        .list()
        .then((t) => live && setTerms(t))
        .catch((err: unknown) => {
          debugLog('dictation:terms-list-failed', { code: parseError(err).code })
          if (live) setTerms([])
        })
    }
    read()
    const off = window.notula.dictation.terms.onChanged(read)
    return () => {
      live = false
      off()
    }
  }, [])
  return terms
}

function TermRow({ t, onError }: { t: DictationTerm; onError(e: string | null): void }): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(t.term)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])

  const answer = (r: DictationTermResult): boolean => {
    onError(r.ok ? null : ERRORS[r.error])
    return r.ok
  }
  const failed = (): void => onError('Couldn’t save the change. Try again.')

  const save = (): void => {
    const next = draft.trim()
    if (!next || next === t.term) return setEditing(false)
    void window.notula.dictation.terms.update({ id: t.id, term: next }).then((r) => answer(r) && setEditing(false), failed)
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      save()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setDraft(t.term)
      setEditing(false)
    }
  }
  const remove = (): void => {
    void window.notula.dictation.terms.remove({ id: t.id }).then((r) => {
      if (!answer(r)) return
      showToast({
        id: 'dictation-term-removed',
        title: `Deleted “${t.term}”`,
        action: {
          label: 'Undo',
          onClick: () => void window.notula.dictation.terms.restore({ id: t.id }).then(answer, failed)
        }
      })
    }, failed)
  }

  return (
    <li className="vt-term">
      <button
        type="button"
        className={`vt-term__star${t.starred ? ' is-on' : ''}`}
        aria-label={t.starred ? `Unstar ${t.term}` : `Star ${t.term}`}
        aria-pressed={t.starred}
        onClick={() => void window.notula.dictation.terms.update({ id: t.id, starred: !t.starred }).then(answer, failed)}
      >
        {t.starred ? '★' : '☆'}
      </button>
      <div className="vt-term__text">
        {editing ? (
          <input
            ref={input}
            className="vt-term__input"
            value={draft}
            aria-label={`Edit ${t.term}`}
            maxLength={DICTATION_TERM_LIMITS.maxChars}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            onBlur={save}
          />
        ) : (
          <span className="vt-term__label">{t.term}</span>
        )}
        {t.source === 'learned' ? <span className="vt-term__note">Learned from your edits</span> : null}
      </div>
      <span className="vt-term__actions">
        {!editing ? (
          <button
            type="button"
            className="n-btn n-btn--ghost n-btn--sm"
            aria-label={`Edit ${t.term}`}
            onClick={() => {
              setDraft(t.term)
              setEditing(true)
            }}
          >
            Edit
          </button>
        ) : null}
        <button type="button" className="n-btn n-btn--ghost n-btn--sm" aria-label={`Delete ${t.term}`} onClick={remove}>
          Delete
        </button>
      </span>
    </li>
  )
}

export function VoiceTypingDictionaryView(): JSX.Element | null {
  const prefs = usePrefs()
  const terms = useTerms()
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const live = useMemo(() => (terms ?? []).filter((t) => t.deleted_at === null), [terms])
  const shown = useMemo(() => {
    const q = normaliseTerm(query)
    return q ? live.filter((t) => t.id.includes(q)) : live
  }, [live, query])

  if (!prefs) return null
  const screenOn = prefs['voiceTyping.screenContext'] && prefs['dictation.screenContext']

  const add = (): void => {
    const term = query.trim()
    if (!term) return
    void window.notula.dictation.terms.add({ term }).then(
      (r) => {
        if (!r.ok) return setError(ERRORS[r.error])
        setError(null)
        setQuery('')
      },
      () => setError('Couldn’t add the term. Try again.')
    )
  }

  return (
    <div className="vt-page">
      <section className="settings-group">
        <p className="settings-group__description">
          Notula listens for these names and terms and spells them your way. How often you use each one stays on this computer.
        </p>
        <div className="settings-card vt-dictpage">
          <div className="vt-dictpage__field">
            <input
              className="vt-dictpage__input"
              value={query}
              placeholder="Find or add a name or term"
              aria-label="Find or add a term"
              aria-describedby={error ? 'vt-dict-error' : undefined}
              maxLength={DICTATION_TERM_LIMITS.maxChars + 20}
              onChange={(e) => {
                setQuery(e.target.value)
                setError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  add()
                }
              }}
            />
            <span className="vt-dictpage__count">
              {countLabel(live.length)} of {DICTATION_TERM_LIMITS.maxTerms}
            </span>
          </div>
          {error ? (
            <p id="vt-dict-error" className="vt-error vt-dictpage__error" role="alert">
              {error}
            </p>
          ) : query.trim() && !shown.some((t) => t.id === normaliseTerm(query)) ? (
            <p className="vt-dictpage__hint">Press Enter to add “{query.trim()}”</p>
          ) : null}
          {terms === null ? null : live.length === 0 ? (
            <p className="vt-hist__empty">No terms yet. Add names, jargon or acronyms Notula should spell your way.</p>
          ) : shown.length === 0 ? null : (
            <ul className="vt-terms" aria-label="Dictionary">
              {shown.map((t) => (
                <TermRow key={t.id} t={t} onError={setError} />
              ))}
            </ul>
          )}
        </div>
      </section>
      <section className="settings-group">
        <div className="settings-card">
          <SettingsRow
            title="Learn from my corrections"
            description={
              screenOn
                ? 'When you fix a name Notula typed and press Enter or Tab, Notula adds the new spelling. Needs an AI provider.'
                : 'Needs screen context and an AI provider. Turn on screen context on the Voice typing page.'
            }
            control={<Switch checked={prefs['dictation.learnWords']} label="Learn from my corrections" onChange={(on) => setPrefs({ 'dictation.learnWords': on })} />}
          />
        </div>
      </section>
    </div>
  )
}
