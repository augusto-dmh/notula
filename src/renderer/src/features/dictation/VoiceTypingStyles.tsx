// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Voice typing ▸ Styles (`voice-typing-styles`, a hidden sub-page): one menu per
// `dictation.styles` key, Automatic plus the tones that key allows, each with an example line.
// The style follows the app in front, so it works with screen context off. AI chat and documents
// follow "Other apps"; code editors and terminals keep their text exact.

import type { JSX } from 'react'
import { DICTATION_STYLE_KEYS, DICTATION_STYLE_TONES, type DictationStyleKey, type DictationTone } from '@shared/types/dictation'
import { Select, type SelectOption } from '../settings/controls'
import { setPrefs, usePrefs } from '../settings/prefs-store'
import './voice-typing.css'

const KEYS: Record<DictationStyleKey, { label: string; apps: string }> = {
  email: { label: 'Email', apps: 'Email apps and webmail' },
  'work-chat': { label: 'Work chat', apps: 'Workplace chat apps' },
  'personal-chat': { label: 'Personal chat', apps: 'Messaging apps for friends and family' },
  other: { label: 'Other apps', apps: 'Documents, AI chats and every other app' }
}

const TONE_LABEL: Record<DictationTone, string> = {
  formal: 'Formal',
  casual: 'Casual',
  relaxed: 'Relaxed',
  excited: 'Excited'
}

/** One sentence per key: the tones differ only in capitals and punctuation, never in words. */
const SAMPLES: Record<DictationStyleKey, { auto: string } & Partial<Record<DictationTone, string>>> = {
  email: {
    auto: 'Hi Sam, the budget review is done. I’ll send the numbers by Friday.',
    formal: 'Hi Sam, the budget review is done. I’ll send the numbers by Friday.',
    casual: 'Hi Sam, the budget review is done. I’ll send the numbers by Friday',
    excited: 'Hi Sam, the budget review is done! I’ll send the numbers by Friday!'
  },
  'work-chat': {
    auto: 'Are we still on for the design sync at three?',
    formal: 'Are we still on for the design sync at three?',
    casual: 'Are we still on for the design sync at three?',
    excited: 'Are we still on for the design sync at three?!'
  },
  'personal-chat': {
    auto: 'Dinner at eight sounds good. Should I book a table?',
    formal: 'Dinner at eight sounds good. Should I book a table?',
    casual: 'Dinner at eight sounds good, should I book a table?',
    relaxed: 'dinner at eight sounds good should i book a table'
  },
  other: {
    auto: 'Looking forward to seeing everyone next week.',
    formal: 'Looking forward to seeing everyone next week.',
    casual: 'Looking forward to seeing everyone next week',
    excited: 'Looking forward to seeing everyone next week!'
  }
}

export function VoiceTypingStylesView(): JSX.Element | null {
  const prefs = usePrefs()
  if (!prefs) return null
  const styles = prefs['dictation.styles']
  return (
    <div className="vt-page">
      <section className="settings-group">
        <p className="settings-group__description">
          Notula picks the style from the app you’re typing in. A style changes capitals and punctuation, never your words. Code editors and terminals
          always get your words exactly.
        </p>
        <div className="settings-card">
          {DICTATION_STYLE_KEYS.map((key) => {
            const allowed = DICTATION_STYLE_TONES[key]
            const stored = styles[key]
            // A tone this key doesn't allow reads as automatic.
            const tone = stored && allowed.includes(stored) ? stored : null
            const options: SelectOption<'auto' | DictationTone>[] = [
              { value: 'auto', label: 'Automatic' },
              ...allowed.map((t) => ({ value: t, label: TONE_LABEL[t] }))
            ]
            const sample = (tone && SAMPLES[key][tone]) || SAMPLES[key].auto
            return (
              <div key={key} className="settings-row vt-style">
                <div className="settings-row__text">
                  <div className="settings-row__label">{KEYS[key].label}</div>
                  <div className="settings-row__hint">{KEYS[key].apps}</div>
                  <div className="vt-style__sample">“{sample}”</div>
                </div>
                <div className="settings-row__control">
                  <Select
                    label={`${KEYS[key].label} style`}
                    value={tone ?? 'auto'}
                    options={options}
                    onChange={(v) => setPrefs({ 'dictation.styles': { ...styles, [key]: v === 'auto' ? null : v } })}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
