// SPDX-License-Identifier: Apache-2.0
// The transcript-footer language menu.
// It changes the stored preference; during a meeting, capture asks main to restart
// the session in place in the new language (`TranscriptionControl.reconfigure`).
// On-device transcription covers what its installed models cover: Multi-language
// and Brazilian Portuguese need a multilingual model, and the menu says so.

import { useEffect, useRef, useState, type JSX } from 'react'
import { TRANSCRIPTION_LANGUAGE_NAMES } from '@shared/types/languages'
import type { TranscriptionLanguage } from '@shared/types/settings'
import { SpeechDialog } from './SpeechDialog'
import {
  localLanguageInstalled,
  multiLanguageCodes,
  multiLanguageCount,
  setSpeechPrefs,
  useLocalAsrStates,
  useSpeechPrefs
} from './speech-state'
import './speech.css'

export function LanguageMenu(): JSX.Element | null {
  const prefs = useSpeechPrefs()
  const states = useLocalAsrStates()
  const [open, setOpen] = useState(false)
  const [learn, setLearn] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!prefs) return null
  const local = prefs['asr.provider'] === 'local'
  // On-device covers what an installed model covers.
  const localMulti = localLanguageInstalled(states, 'multi')
  const ptBr = localLanguageInstalled(states, 'pt-BR')
  const stored = prefs['asr.language']
  const value: TranscriptionLanguage =
    stored === 'pt-BR' && !ptBr ? (local ? 'en' : 'multi') : local && stored === 'multi' && !localMulti ? 'en' : stored
  const count = multiLanguageCount(prefs)

  const pick = (language: TranscriptionLanguage): void => {
    setOpen(false)
    if (language === value) return
    // Auto summaries need multi-language transcription, so English resets them (as Preferences does).
    setSpeechPrefs(language === 'en' ? { 'asr.language': 'en', 'enhance.summaryLanguage': 'en' } : { 'asr.language': language })
  }

  const names = multiLanguageCodes(prefs)
    .map((c) => TRANSCRIPTION_LANGUAGE_NAMES[c] ?? c.toUpperCase())
    .sort((a, b) => a.localeCompare(b))

  return (
    <div className="nt-lang" ref={ref}>
      <button
        type="button"
        className="nt-lang__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Transcription language"
        onClick={() => setOpen((v) => !v)}
      >
        {value === 'multi' ? 'Multi' : value === 'pt-BR' ? 'Português (BR)' : 'English'}
        <span aria-hidden="true" className="nt-lang__chevron">
          ▾
        </span>
      </button>
      {open && (
        <div className="nt-lang__menu" role="menu" aria-label="Transcription language">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={value === 'en'}
            className="nt-lang__item"
            onClick={() => pick('en')}
          >
            <span className="nt-lang__check">{value === 'en' ? '✓' : ''}</span>
            <span className="nt-lang__text">
              <span className="nt-lang__label">English only</span>
              <span className="nt-lang__sub">Highest quality</span>
            </span>
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={value === 'multi'}
            aria-disabled={local && !localMulti}
            disabled={local && !localMulti}
            className="nt-lang__item"
            onClick={() => pick('multi')}
          >
            <span className="nt-lang__check">{value === 'multi' ? '✓' : ''}</span>
            <span className="nt-lang__text">
              <span className="nt-lang__label">Multi-language</span>
              <span className="nt-lang__sub">{local ? 'Detected by the on-device model.' : `${count} languages supported.`}</span>
            </span>
          </button>
          {ptBr ? (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={value === 'pt-BR'}
              className="nt-lang__item"
              onClick={() => pick('pt-BR')}
            >
              <span className="nt-lang__check">{value === 'pt-BR' ? '✓' : ''}</span>
              <span className="nt-lang__text">
                <span className="nt-lang__label">Português (Brasil)</span>
                <span className="nt-lang__sub">{local ? 'On-device' : 'On-device, or multi-language in the cloud'}</span>
              </span>
            </button>
          ) : null}
          {local && !localMulti ? (
            <p className="nt-lang__note">
              On-device transcription is English only with the English model. To transcribe other languages, download
              Whisper or Parakeet v3 in Settings ▸ AI, or choose a cloud provider.
            </p>
          ) : (
            <button
              type="button"
              className="nt-sp-link nt-lang__learn"
              onClick={() => {
                setOpen(false)
                setLearn(true)
              }}
            >
              Learn more
            </button>
          )}
        </div>
      )}
      {learn && (
        <SpeechDialog
          title="Multi-language"
          onClose={() => setLearn(false)}
          footer={
            <button type="button" className="n-btn n-btn--primary" onClick={() => setLearn(false)}>
              Got it
            </button>
          }
        >
          <p>
            Multi-language transcribes meetings where people speak, or switch between, these {count} languages. English
            only gives the best quality for English meetings.
          </p>
          <p className="nt-sp-fine">{names.join(', ')}</p>
        </SpeechDialog>
      )}
    </div>
  )
}
