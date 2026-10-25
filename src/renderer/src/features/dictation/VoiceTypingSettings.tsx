// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Voice typing (shown while Labs
// `voiceTyping.enabled` is on): the enable row, General (shortcut, language, microphone,
// transcription), Dictation bar (the bar switch and its three shortcuts),
// Personalization (dictionary, screen context), Data & Privacy (failed-audio retention), Styles
// and the History row, which opens the `voice-typing-history` sub-page.
//
// Until the onboarding is done, and while no dictation has text or a word count, a "Try
// voice typing" card takes the enable row's place; its Try now opens the overlay at Set up.
// Turning voice typing on here before the onboarding is done opens it too.

import { useCallback, useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import {
  DICTATION_DEFAULT_SHORTCUT,
  DICTATION_LANGUAGE_LISTS,
  DICTATION_LIMITS,
  type DictationAsrChoice,
  type DictationCategory,
  type DictationMicrophone,
  type DictationRetention,
  type DictationStatus,
  type DictationTone
} from '@shared/types/dictation'
import { navigateToSettings } from '../../app/navigation'
import { isMac } from '../../app/platform'
import { KeyChips, StandaloneShortcut } from '../keyboard-shortcuts/KeyboardShortcutsSettings'
import { readKey } from '../keyboard-shortcuts/keys'
import { Select, Switch, type SelectOption } from '../settings/controls'
import { SettingsCard, SettingsRow } from '../settings/primitives'
import { setPrefs, usePrefs } from '../settings/prefs-store'
import { useDictationHistory } from './VoiceTypingHistory'
import { openVoiceTypingOnboarding } from './VoiceTypingOnboarding'
import './voice-typing.css'

// ---------- styles ----------

const CATEGORIES: { key: DictationCategory; label: string; apps: string }[] = [
  { key: 'email', label: 'Email', apps: 'Outlook, Mail, Thunderbird and other email apps' },
  { key: 'work', label: 'Work apps', apps: 'Slack, Microsoft Teams and other workplace chat' },
  { key: 'casual', label: 'Messaging', apps: 'WhatsApp, Messages, Signal, Telegram and Discord' },
  { key: 'other', label: 'Other apps', apps: 'Terminals, editors and every other app' }
]

const TONES: SelectOption<'auto' | DictationTone>[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'formal', label: 'Formal' },
  { value: 'casual', label: 'Casual' },
  { value: 'relaxed', label: 'Very casual' },
  { value: 'excited', label: 'Excited' }
]

/** One sentence per category, differing per tone only in casing and final punctuation. */
const SAMPLES: Record<DictationCategory, Record<DictationTone, string>> = {
  email: {
    formal: 'Hi Sam, the budget review is done. I’ll send the numbers by Friday.',
    casual: 'Hi Sam, the budget review is done. I’ll send the numbers by Friday',
    'relaxed': 'hi sam, the budget review is done, i’ll send the numbers by friday',
    excited: 'Hi Sam, the budget review is done! I’ll send the numbers by Friday!'
  },
  work: {
    formal: 'Quick check-in: are we still on for the design sync at three?',
    casual: 'Quick check-in, are we still on for the design sync at three?',
    'relaxed': 'quick check in, are we still on for the design sync at three',
    excited: 'Quick check-in: are we still on for the design sync at three?!'
  },
  casual: {
    formal: 'Dinner at eight sounds good. Should I book a table?',
    casual: 'Dinner at eight sounds good, should I book a table?',
    'relaxed': 'dinner at eight sounds good should i book a table',
    excited: 'Dinner at eight sounds good! Should I book a table?!'
  },
  other: {
    formal: 'Looking forward to seeing everyone next week.',
    casual: 'Looking forward to seeing everyone next week',
    'relaxed': 'looking forward to seeing everyone next week',
    excited: 'Looking forward to seeing everyone next week!'
  }
}

const RETENTION: SelectOption<DictationRetention>[] = [
  { value: 'off', label: 'Never' },
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '14d', label: '14 days' }
]

const ASR: SelectOption<DictationAsrChoice>[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'local', label: 'On this device' },
  { value: 'deepgram', label: 'Deepgram' },
  { value: 'assemblyai', label: 'AssemblyAI' }
]

// ---------- language ----------

const displayNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' })
  } catch {
    return null
  }
})()

function languageName(code: string): string {
  try {
    return displayNames?.of(code) ?? code
  } catch {
    return code
  }
}

/** Until each provider's list is pinned: AssemblyAI list A, Deepgram list B, local English. */
function languageCodes(provider: DictationStatus['asr']): readonly string[] {
  if (provider === 'local') return ['en']
  if (provider === 'assemblyai') return DICTATION_LANGUAGE_LISTS.a
  return DICTATION_LANGUAGE_LISTS.b
}

// ---------- dictionary ----------

function termProblem(term: string, list: readonly string[]): string | null {
  if (list.length >= DICTATION_LIMITS.dictionaryMax) return 'Up to 30 terms'
  if (term.length > 50) return 'Keep terms to 50 characters or fewer'
  if (term.split(/\s+/).length > 6) return 'Keep terms to 6 words or fewer'
  if (term.length < 2) return 'Terms need at least 2 characters'
  if (list.some((t) => t.toLowerCase() === term.toLowerCase())) return 'That term is already added'
  return null
}

function Dictionary({ terms, removed }: { terms: string[]; removed: string[] }): JSX.Element {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const save = (next: string[]): void => {
    const dropped = terms.filter((t) => !next.includes(t))
    const readded = next.filter((t) => removed.includes(t))
    setPrefs({
      'dictation.dictionary': next,
      'dictation.dictionaryRemoved': [...removed.filter((t) => !readded.includes(t)), ...dropped.filter((t) => !removed.includes(t))]
    })
  }
  const add = (): void => {
    const term = draft.trim().replace(/\s+/g, ' ')
    if (!term) return
    const problem = termProblem(term, terms)
    if (problem) return setError(problem)
    save([...terms, term])
    setDraft('')
    setError(null)
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      add()
    } else if (e.key === 'Backspace' && !draft && terms.length) {
      save(terms.slice(0, -1))
    }
  }
  const suggestion = draft.trim()
  return (
    <div className="vt-dict">
      <div className="vt-dict__box">
        {terms.map((t) => (
          <span key={t} className="vt-chip">
            {t}
            <button type="button" aria-label={`Remove ${t}`} onClick={() => save(terms.filter((x) => x !== t))}>
              ×
            </button>
          </span>
        ))}
        <input
          className="vt-dict__input"
          value={draft}
          placeholder={terms.length ? '' : 'Add names, jargon or acronyms'}
          aria-label="Add a dictionary term"
          onChange={(e) => {
            setDraft(e.target.value)
            setError(null)
          }}
          onKeyDown={onKey}
        />
      </div>
      {suggestion && !error ? (
        <button type="button" className="vt-dict__add" onClick={add}>
          Add “{suggestion}”
        </button>
      ) : null}
      {error ? (
        <p className="vt-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

// ---------- shortcut ----------

function ShortcutButton({ status, disabled }: { status: DictationStatus | null; disabled: boolean }): JSX.Element {
  const prefs = usePrefs()
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const current = prefs?.['dictation.shortcut'] ?? DICTATION_DEFAULT_SHORTCUT

  const stop = useCallback((): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setRecording(false)
    window.notula.dictation.suspendShortcut({ suspended: false })
  }, [])

  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current)
      window.notula.dictation.suspendShortcut({ suspended: false })
    }
  }, [])

  const apply = (accelerator: string | null): void => {
    void window.notula.dictation.setShortcut({ accelerator }).then(
      (r) => setError(r.ok ? null : (r.error ?? 'Couldn’t record shortcut. Try again.')),
      () => setError('Couldn’t record shortcut. Try again.')
    )
  }

  const begin = (): void => {
    setError(null)
    setRecording(true)
    window.notula.dictation.suspendShortcut({ suspended: true })
    timer.current = setTimeout(() => {
      stop()
      setError('Shortcut recording timed out')
    }, DICTATION_LIMITS.shortcutRecordMs)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (!recording) return
    e.preventDefault()
    e.stopPropagation()
    const r = readKey(e.nativeEvent)
    if (r.kind === 'escape') return stop()
    if (r.kind === 'modifiers' || r.kind === 'reserved' || r.kind === 'unsupported') return
    if (r.kind === 'needs-modifier') {
      setError('Add a letter, number or function key.')
      return
    }
    if (/^(Alt|Option)\+Space$/.test(r.accelerator)) return
    stop()
    apply(r.accelerator === DICTATION_DEFAULT_SHORTCUT ? null : r.accelerator)
  }

  const onKeyUp = (e: KeyboardEvent<HTMLButtonElement>): void => {
    // A modifier-only combination is complete when the last modifier comes up.
    if (!recording) return
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      setError('Add a letter, number or function key.')
    }
  }

  const failed = !recording && !error && status?.armed && !status.shortcutRegistered ? status.shortcutError : null
  return (
    <div className="vt-shortcut">
      <div className="vt-shortcut__row">
        <button
          type="button"
          className={`vt-shortcut__btn${recording ? ' is-recording' : ''}`}
          aria-label={recording ? 'Recording shortcut' : 'Change voice typing shortcut'}
          disabled={disabled}
          onClick={() => (recording ? stop() : begin())}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onBlur={() => recording && stop()}
        >
          {recording ? 'Press the keys you want' : <KeyChips accelerator={current} />}
        </button>
        {prefs?.['dictation.shortcut'] && !recording ? (
          <button type="button" className="n-btn n-btn--ghost n-btn--sm" disabled={disabled} onClick={() => apply(null)}>
            Reset
          </button>
        ) : null}
      </div>
      {error || failed ? (
        <p className="vt-error" role="alert">
          {error ?? failed}
        </p>
      ) : null}
    </div>
  )
}

// ---------- microphone ----------

function useInputs(): MediaDeviceInfo[] {
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([])
  useEffect(() => {
    let live = true
    const read = (): void => {
      void navigator.mediaDevices
        .enumerateDevices()
        .then((all) => live && setInputs(all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')))
        .catch(() => undefined)
    }
    read()
    navigator.mediaDevices.addEventListener('devicechange', read)
    return () => {
      live = false
      navigator.mediaDevices.removeEventListener('devicechange', read)
    }
  }, [])
  return inputs
}

export function MicrophoneSelect({ value, disabled }: { value: DictationMicrophone | null; disabled: boolean }): JSX.Element {
  const inputs = useInputs()
  const builtIn = inputs.find((d) => /built-?in|internal|integrated|array/i.test(d.label))
  const options: SelectOption<string>[] = [{ value: 'system-default', label: 'System default' }]
  if (builtIn) options.push({ value: `id:${builtIn.deviceId}`, label: 'Built-in microphone (Recommended)' })
  for (const d of inputs) {
    if (d === builtIn) continue
    options.push({ value: `id:${d.deviceId}`, label: d.label || `Microphone (${d.deviceId.slice(0, 8)})` })
  }
  let current = value === null ? (builtIn ? `id:${builtIn.deviceId}` : 'system-default') : value === 'system-default' ? 'system-default' : `id:${value.deviceId}`
  if (value && typeof value === 'object' && !inputs.some((d) => d.deviceId === value.deviceId)) {
    options.push({ value: `id:${value.deviceId}`, label: `${value.label || 'Microphone'} (disconnected)` })
    current = `id:${value.deviceId}`
  }
  return (
    <Select
      label="Microphone"
      value={current}
      options={options}
      disabled={disabled}
      onChange={(v) => {
        if (v === 'system-default') return setPrefs({ 'dictation.microphone': 'system-default' })
        const id = v.slice(3)
        const d = inputs.find((x) => x.deviceId === id)
        setPrefs({ 'dictation.microphone': { deviceId: id, label: d?.label ?? '' } })
      }}
    />
  )
}

// ---------- the page ----------

export function VoiceTypingSettingsView(): JSX.Element | null {
  const prefs = usePrefs()
  const [status, setStatus] = useState<DictationStatus | null>(null)
  const history = useDictationHistory()

  useEffect(() => {
    let live = true
    const read = (): void => {
      void window.notula.dictation
        .getStatus()
        .then((s) => live && setStatus(s))
        .catch(() => undefined)
    }
    read()
    const t = setTimeout(read, 300)
    window.addEventListener('focus', read)
    return () => {
      live = false
      clearTimeout(t)
      window.removeEventListener('focus', read)
    }
  }, [prefs?.['dictation.enabled'], prefs?.['dictation.shortcut'], prefs?.['dictation.asr'], prefs?.['voiceTyping.enabled']])

  if (!prefs) return null
  if (status && !status.platformSupported) {
    return <p className="settings-group__description">Voice typing works on Windows and macOS.</p>
  }
  const enabled = prefs['dictation.enabled']
  const off = !enabled
  const storedLang = prefs['dictation.language']
  const asrLang = prefs['asr.language']
  const shownLang = storedLang ?? (asrLang === 'multi' ? 'auto' : asrLang === 'pt-BR' ? 'pt' : 'en')
  const codes = languageCodes(status?.asr ?? null)
  const langOptions: SelectOption<string>[] = [
    { value: 'auto', label: 'Auto-detect' },
    { value: 'en', label: 'English' },
    ...codes
      .filter((c) => c !== 'en')
      .map((c) => ({ value: c, label: languageName(c) }))
      .sort((a, b) => a.label.localeCompare(b.label))
  ]
  if (!langOptions.some((o) => o.value === shownLang)) langOptions.push({ value: shownLang, label: languageName(shownLang) })
  const cloudLlm = prefs['llm.provider'] !== 'local'
  const styles = prefs['dictation.styles']
  const onboarded = prefs['dictation.onboardingCompleted']
  const used = history?.some((a) => !!a.text || a.word_count !== null) ?? true
  const offerTry = !onboarded && !used && status?.platformSupported === true

  return (
    <div className="vt-page">
      <SettingsCard>
        {offerTry ? (
          <div className="vt-try">
            <div>
              <p className="vt-try__title">Try voice typing</p>
              <p className="vt-try__text">Speak in any app and Notula types it for you. Setup takes a minute.</p>
            </div>
            <button type="button" className="n-btn n-btn--primary n-btn--sm" onClick={() => openVoiceTypingOnboarding('setup')}>
              Try now
            </button>
          </div>
        ) : (
          <SettingsRow
            title="Voice typing"
            description="Type with your voice in any app"
            control={
              <Switch
                checked={enabled}
                label="Voice typing"
                onChange={(on) => {
                  setPrefs({ 'dictation.enabled': on })
                  if (on && !onboarded) openVoiceTypingOnboarding('setup')
                }}
              />
            }
          />
        )}
      </SettingsCard>

      {isMac && enabled && status?.accessibility === 'missing' ? (
        <div className="vt-notice" role="status">
          <span>Allow accessibility access so voice typing can paste</span>
          <button type="button" className="n-btn n-btn--sm" onClick={() => window.notula.system.openPrivacySettings({ target: 'accessibility' })}>
            Open settings
          </button>
        </div>
      ) : null}

      <SettingsCard title="General">
        <SettingsRow
          title="Shortcut"
          description={status?.holdMode === false ? 'Press it once to start voice typing and again to stop.' : 'Hold it while you speak. Press it twice quickly to keep listening hands-free.'}
          control={<ShortcutButton status={status} disabled={off} />}
        />
        <SettingsRow
          title="Language"
          description="Which language voice typing listens for"
          control={<Select label="Language" value={shownLang} options={langOptions} disabled={off} onChange={(v) => setPrefs({ 'dictation.language': v })} />}
        />
        <SettingsRow title="Microphone" description="The microphone to use for voice typing" control={<MicrophoneSelect value={prefs['dictation.microphone']} disabled={off} />} />
        <SettingsRow
          title="Transcription"
          description="Automatic uses on-device transcription when it’s installed."
          control={<Select label="Transcription" value={prefs['dictation.asr']} options={ASR} disabled={off} onChange={(v) => setPrefs({ 'dictation.asr': v })} />}
        />
        {status?.asrError === 'no-provider' && enabled ? (
          <p className="vt-row-note">
            This provider has no API key yet.{' '}
            <button type="button" className="vt-link" onClick={() => navigateToSettings('ai')}>
              Open AI settings
            </button>
          </p>
        ) : null}
      </SettingsCard>

      <SettingsCard title="Dictation bar">
        <SettingsRow
          title="Show the dictation bar"
          description="Keeps a small bar on screen so you can start voice typing with one click."
          control={<Switch checked={prefs['dictationBar.enabled']} label="Show the dictation bar" disabled={off} onChange={(on) => setPrefs({ 'dictationBar.enabled': on })} />}
        />
        <SettingsRow title="Hold to talk" description="Hold to dictate, release to paste. Add Space to keep going hands-free." control={<StandaloneShortcut id="dictationHold" />} />
        <SettingsRow title="Hands-free" description="Press to start, press again to finish. Esc cancels." control={<StandaloneShortcut id="dictationHandsFree" />} />
        <SettingsRow title="Start or stop recording" description="Records a meeting into a new note" control={<StandaloneShortcut id="recordToggle" />} />
      </SettingsCard>

      <SettingsCard title="Personalization">
        <div className="settings-row vt-row--stack">
          <div className="settings-row__text">
            <div className="settings-row__label">Dictionary</div>
            <div className="settings-row__hint">Words Notula should always spell your way</div>
          </div>
          <Dictionary terms={prefs['dictation.dictionary']} removed={prefs['dictation.dictionaryRemoved']} />
        </div>
        {prefs['voiceTyping.screenContext'] ? (
          <SettingsRow
            title="Screen context"
            description={`Reads text near your cursor to spell names correctly.${cloudLlm ? ' That text is sent to your AI provider.' : ''}`}
            control={
              <Switch checked={prefs['dictation.screenContext']} label="Screen context" disabled={off} onChange={(on) => setPrefs({ 'dictation.screenContext': on })} />
            }
          />
        ) : null}
      </SettingsCard>

      <SettingsCard title="Data and privacy">
        <SettingsRow
          title="Store audio from failed dictations"
          description="Keeps the audio when voice typing fails, so you can retry it later."
          control={
            <Select
              label="Store audio from failed dictations"
              value={prefs['dictation.failedAudioRetention'] ?? '24h'}
              options={RETENTION}
              onChange={(v) => setPrefs({ 'dictation.failedAudioRetention': v })}
            />
          }
        />
      </SettingsCard>

      <SettingsCard title="Styles">
        {CATEGORIES.map((c) => {
          const tone = styles[c.key]
          const shown = tone ?? (c.key === 'email' ? styles.work : null)
          return (
            <div key={c.key} className="settings-row vt-style">
              <div className="settings-row__text">
                <div className="settings-row__label">{c.label}</div>
                <div className="settings-row__hint">{c.apps}</div>
                {shown ? <div className="vt-style__sample">“{SAMPLES[c.key][shown]}”</div> : null}
              </div>
              <div className="settings-row__control">
                <Select
                  label={`${c.label} style`}
                  value={tone ?? 'auto'}
                  options={TONES}
                  onChange={(v) => setPrefs({ 'dictation.styles': { ...styles, [c.key]: v === 'auto' ? null : v } })}
                />
              </div>
            </div>
          )
        })}
      </SettingsCard>

      <SettingsCard>
        <SettingsRow
          title="History"
          description="Your recent dictations, to copy, delete or retry"
          control={<span className="vt-chevron" aria-hidden="true">›</span>}
          onClick={() => navigateToSettings('voice-typing-history')}
        />
      </SettingsCard>
    </div>
  )
}
