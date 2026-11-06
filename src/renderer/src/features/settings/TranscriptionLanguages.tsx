// SPDX-License-Identifier: Apache-2.0
// Labs: the languages the user names for multi-language transcription's hints
// (`transcription.languages`). Offered from the active provider's multilingual model;
// while nothing is saved, the OS languages are shown and nothing is written.

import { useEffect, useId, useState, type JSX } from 'react'
import {
  byDisplayName,
  languageDisplayName,
  MAX_TRANSCRIPTION_LANGUAGES,
  MULTI_LANGUAGE_SETS,
  normalizeLanguageList
} from '@shared/types/languages'
import type { Settings } from '@shared/types/settings'
import { assemblyMultiModel, deepgramMultiModel, languageHints, type MultiModel } from '../../../../main/transcription/languages'
import { Row } from './controls'
import { IconX } from './icons'
import { setPrefs } from './prefs-store'
import './transcription-languages.css'

/** The multilingual model `multi` uses; on-device transcription sends no hints, so it shows the default cloud model's set. */
function modelFor(prefs: Settings): MultiModel {
  if (prefs['asr.provider'] === 'assemblyai') return assemblyMultiModel(prefs['asr.assemblyai.multilingualModel'])
  if (prefs['asr.provider'] === 'deepgram') return deepgramMultiModel(prefs['asr.deepgram.multilingualVersion'])
  return deepgramMultiModel('default')
}

function useSystemLanguages(needed: boolean): string[] {
  const [tags, setTags] = useState<string[]>([])
  useEffect(() => {
    if (!needed) return
    let live = true
    window.notula.system
      .getLanguages()
      .then((t) => live && setTags(t))
      .catch(() => live && setTags([]))
    return () => {
      live = false
    }
  }, [needed])
  return tags
}

export function TranscriptionLanguagesRow({ prefs }: { prefs: Settings }): JSX.Element {
  const inputId = useId()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const stored = prefs['transcription.languages']
  const offered = byDisplayName(MULTI_LANGUAGE_SETS[modelFor(prefs)])
  const system = useSystemLanguages(stored === null)
  // Never saved: the OS languages, shown only.
  const chosen = stored ?? byDisplayName(languageHints(system, offered))

  const query = draft.trim().toLocaleLowerCase()
  const matches = offered.filter((c) => !chosen.includes(c) && languageDisplayName(c).toLocaleLowerCase().includes(query))

  function add(code: string): void {
    if (chosen.length >= MAX_TRANSCRIPTION_LANGUAGES) {
      setError(`The list holds ${MAX_TRANSCRIPTION_LANGUAGES} languages at most. To add this one, take another off first.`)
      return
    }
    setPrefs({ 'transcription.languages': normalizeLanguageList([...chosen, code]) })
    setDraft('')
    setError(null)
  }

  function remove(code: string): void {
    setPrefs({ 'transcription.languages': normalizeLanguageList(chosen.filter((c) => c !== code)) })
    setError(null)
  }

  return (
    <Row
      label="Your languages"
      hint="List the languages spoken in your meetings for more accurate transcripts. Notula goes on working out which one is spoken either way."
      htmlFor={inputId}
      stacked
    >
      <div className="jargon tx-langs">
        {chosen.length ? (
          <ul className="jargon__terms" aria-label="Your languages">
            {chosen.map((c) => (
              <li key={c} className="jargon__term">
                <span>{languageDisplayName(c)}</span>
                <button
                  type="button"
                  className="jargon__remove"
                  aria-label={`Remove ${languageDisplayName(c)}`}
                  onClick={() => remove(c)}
                >
                  <IconX size={12} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {stored === null && chosen.length ? <p className="jargon__count">From your computer’s language settings</p> : null}
        <input
          id={inputId}
          className="n-input jargon__input"
          value={draft}
          placeholder="Find a language"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${inputId}-error` : undefined}
          onChange={(e) => {
            setDraft(e.target.value)
            if (error) setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && query && matches[0]) {
              e.preventDefault()
              add(matches[0])
            }
          }}
        />
        {error ? (
          <p className="jargon__error" id={`${inputId}-error`} role="alert">
            {error}
          </p>
        ) : null}
        {matches.length ? (
          <ul className="tx-langs__options" aria-label="Languages to add">
            {matches.map((c) => (
              <li key={c}>
                <button type="button" className="tx-langs__option" onClick={() => add(c)}>
                  {languageDisplayName(c)}
                </button>
              </li>
            ))}
          </ul>
        ) : query ? (
          <p className="jargon__count">No language matches “{draft.trim()}”</p>
        ) : null}
        <p className="jargon__count">
          {chosen.length} of {MAX_TRANSCRIPTION_LANGUAGES}
        </p>
      </div>
    </Row>
  )
}
