// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Voice typing (shown while Labs
// `voiceTyping.enabled` is on): the enable row, General (languages, with a line that says what
// the engine in use can hear, microphone, transcription), Shortcuts (the hold list, the
// hands-free list, which holds every start-and-stop shortcut, with the toggle's note while the
// keyboard helper is down or another app may answer it, the bar switch, Start or stop
// recording), Personalization (rows to the
// `voice-typing-styles` and `voice-typing-dictionary` sub-pages, screen context), Sound
// (sounds, muting other audio), Data and privacy (local retention), and the History and
// Feedback rows.
//
// Until the onboarding is done, and while no dictation has text or a word count, a "Try
// voice typing" card takes the enable row's place; its Try now opens the overlay at Set up.
// Turning voice typing on here before the onboarding is done opens it too. While main reports
// the neutral conflict note, the page opens scrolled to the shortcut rows.

import { useEffect, useRef, useState, type JSX } from 'react'
import {
  DICTATION_LANGUAGE_LISTS,
  DICTATION_LIMITS,
  type DictationAsrChoice,
  type DictationLocalRetention,
  type DictationMicrophone,
  type DictationStatus
} from '@shared/types/dictation'
import { shortcutLabel } from '@shared/types/dictation-bar'
import { localAsrModelInfo } from '@shared/types/transcript'
import { navigateToSettings } from '../../app/navigation'
import { isMac } from '../../app/platform'
import { StandaloneShortcut, useHookStatus } from '../keyboard-shortcuts/KeyboardShortcutsSettings'
import { Select, Switch, type SelectOption } from '../settings/controls'
import { SettingsCard, SettingsRow } from '../settings/primitives'
import { setPrefs, usePrefs } from '../settings/prefs-store'
import { useDictationHistory } from './VoiceTypingHistory'
import { openVoiceTypingOnboarding } from './VoiceTypingOnboarding'
import './voice-typing.css'

const RETENTION: SelectOption<DictationLocalRetention>[] = [
  { value: 'keep', label: 'Keep text' },
  { value: '24h', label: '24 hours' },
  { value: 'never', label: 'Don’t keep' }
]

const RETENTION_NOTE: Record<DictationLocalRetention, string> = {
  keep: 'Your dictations stay in your history. Audio for retrying a failed one is kept for 24 hours.',
  '24h': 'Text and audio are removed 24 hours after each dictation.',
  never: 'Notula keeps no text or audio, only word counts and durations for your usage.'
}

const ASR: SelectOption<DictationAsrChoice>[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'local', label: 'On this device' },
  { value: 'deepgram', label: 'Deepgram' },
  { value: 'assemblyai', label: 'AssemblyAI' }
]

// ---------- languages ----------

const displayNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' })
  } catch {
    return null
  }
})()

export function languageName(code: string): string {
  try {
    return displayNames?.of(code) ?? code
  } catch {
    return code
  }
}

/** The on-device model's own languages; until each cloud provider's list is pinned: AssemblyAI list A, Deepgram list B. */
function languageCodes(status: DictationStatus | null): readonly string[] {
  if (status?.localModel) return localAsrModelInfo(status.localModel).languages.filter((c) => c !== 'multi')
  if (status?.asr === 'assemblyai') return DICTATION_LANGUAGE_LISTS.a
  return DICTATION_LANGUAGE_LISTS.b
}

const PICK_HINT = 'Add the languages you speak, up to 5. With none or several, Notula detects the language.'

/** The on-device model hears English only: the one installed, or the only one for these languages. */
const englishModel = (status: DictationStatus | null): boolean =>
  !!status?.englishOnly || (!!status?.localModel && !localAsrModelInfo(status.localModel).languages.includes('multi'))

/** What the engine in use can hear. A cloud engine gets the plain line. */
function languagesHint(status: DictationStatus | null): string {
  if (englishModel(status)) return 'The on-device model knows English only. For other languages, download Whisper in Settings ▸ AI.'
  if (status?.localModel === 'whisper-large-v3-turbo-int8') return `Whisper, the on-device model, knows 99 languages. ${PICK_HINT}`
  if (status?.localModel === 'parakeet-tdt-0.6b-v3-int8') return `Parakeet, the on-device model, knows 25 European languages. ${PICK_HINT}`
  return PICK_HINT
}

/** Up to 5 language chips; none = automatic. The system languages are suggested first. */
function Languages({ value, status, disabled, addable }: { value: string[]; status: DictationStatus | null; disabled: boolean; addable: boolean }): JSX.Element {
  const codes = languageCodes(status)
  const system = (status?.systemLanguages ?? []).filter((c) => codes.includes(c) && !value.includes(c))
  const rest = codes
    .filter((c) => !value.includes(c) && !system.includes(c))
    .map((c) => ({ value: c, label: languageName(c) }))
    .sort((a, b) => a.label.localeCompare(b.label))
  const options: SelectOption<string>[] = [
    { value: '', label: 'Add a language' },
    ...system.map((c) => ({ value: c, label: `${languageName(c)} (on this computer)` })),
    ...rest
  ]
  const full = value.length >= DICTATION_LIMITS.maxLanguages
  return (
    <div className="vt-langs">
      <div className="vt-langs__chips">
        {value.length === 0 ? <span className="vt-langs__auto">Automatic</span> : null}
        {value.map((c) => (
          <span key={c} className="vt-chip">
            {languageName(c)}
            <button
              type="button"
              aria-label={`Remove ${languageName(c)}`}
              disabled={disabled}
              onClick={() => setPrefs({ 'dictation.languages': value.filter((x) => x !== c) })}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      {!full ? (
        <Select
          label="Add a language"
          value=""
          options={options}
          disabled={disabled || !addable}
          onChange={(v) => {
            if (v) setPrefs({ 'dictation.languages': [...value, v] })
          }}
        />
      ) : null}
    </div>
  )
}

// ---------- microphone ----------

const BUILT_IN = /built-?in|internal|integrated|array/i
/** Bluetooth and hands-free devices, known by label: lower quality while the mic is open. */
const WIRELESS = /bluetooth|hands-?free|headset|airpods|buds|\bbt\b|wireless/i

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

/** The picker: the built-in microphone first and recommended, then wired devices, Bluetooth and hands-free devices last. */
export function MicrophoneSelect({ value, disabled }: { value: DictationMicrophone | null; disabled: boolean }): JSX.Element {
  const inputs = useInputs()
  const builtIn = inputs.find((d) => BUILT_IN.test(d.label))
  const rank = (d: MediaDeviceInfo): number => (d === builtIn ? 0 : WIRELESS.test(d.label) ? 2 : 1)
  const sorted = [...inputs].sort((a, b) => rank(a) - rank(b))
  const options: SelectOption<string>[] = [{ value: 'system-default', label: 'System default' }]
  for (const d of sorted) {
    const name = d === builtIn ? 'Built-in microphone' : d.label || `Microphone (${d.deviceId.slice(0, 8)})`
    options.push({ value: `id:${d.deviceId}`, label: d === builtIn ? `${name} (Recommended)` : name })
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

export function useDictationStatus(deps: readonly unknown[] = []): DictationStatus | null {
  const [status, setStatus] = useState<DictationStatus | null>(null)
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
    const off = window.notula.shortcuts.onChanged(read)
    return () => {
      live = false
      clearTimeout(t)
      window.removeEventListener('focus', read)
      off()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return status
}

export function VoiceTypingSettingsView(): JSX.Element | null {
  const prefs = usePrefs()
  const status = useDictationStatus([prefs?.['dictation.enabled'], prefs?.['dictation.shortcut'], prefs?.['dictation.asr'], prefs?.['voiceTyping.enabled']])
  const hook = useHookStatus()
  const history = useDictationHistory()
  const shortcuts = useRef<HTMLDivElement>(null)
  const scrolled = useRef(false)

  // Opened from the conflict card: start at the shortcut rows.
  useEffect(() => {
    if (!status?.conflict || scrolled.current || !shortcuts.current) return
    scrolled.current = true
    shortcuts.current.scrollIntoView({ block: 'start' })
  }, [status?.conflict])

  if (!prefs) return null
  if (status && !status.platformSupported) {
    return <p className="settings-group__description">Voice typing works on Windows and macOS.</p>
  }
  const enabled = prefs['dictation.enabled']
  const off = !enabled
  const cloudLlm = prefs['llm.provider'] !== 'local'
  const onboarded = prefs['dictation.onboardingCompleted']
  const used = history?.some((a) => !!a.text || a.word_count !== null) ?? true
  const offerTry = !onboarded && !used && status?.platformSupported === true
  // The toggle is the fallback: it shows only while the keyboard helper can't run.
  const helperDown = !!hook && !hook.available && (!!hook.reason || !!hook.lost)
  // The toggle (the fallback while the helper is down), named on its note.
  const toggle = status ? shortcutLabel(status.shortcut, isMac ? 'darwin' : 'win32') : ''
  const retention = prefs['dictation.localRetention']

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
        <div className="settings-row vt-row--stack">
          <div className="settings-row__text">
            <div className="settings-row__label">Languages</div>
            <div className="settings-row__hint">{languagesHint(status)}</div>
          </div>
          <Languages value={prefs['dictation.languages']} status={status} disabled={off} addable={!englishModel(status)} />
        </div>
        <SettingsRow title="Microphone" description="Built-in and wired microphones work best. Bluetooth headsets sound worse while their microphone is on." control={<MicrophoneSelect value={prefs['dictation.microphone']} disabled={off} />} />
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

      <div ref={shortcuts}>
        <SettingsCard title="Shortcuts">
          <SettingsRow title="Hold to talk" description="Hold to dictate, release to paste. Add Space to keep going hands-free." control={<StandaloneShortcut id="dictationHold" />} />
          <SettingsRow title="Hands-free" description="Press to start, press again to finish. Esc cancels." control={<StandaloneShortcut id="dictationHandsFree" />} />
          {enabled && (helperDown || status?.conflict === 'dictation') ? (
            <p className="vt-row-note" role="status">
              {helperDown
                ? `The keyboard helper isn’t running, so ${toggle} starts and stops voice typing for now.`
                : `Another app may also answer ${toggle}. If voice typing starts twice or not at all, change it in Keyboard shortcuts.`}{' '}
              {helperDown ? null : (
                <button type="button" className="vt-link" onClick={() => navigateToSettings('keyboard-shortcuts')}>
                  Open keyboard shortcuts
                </button>
              )}
            </p>
          ) : null}
          <SettingsRow
            title="Show the dictation bar"
            description="Keeps a small bar on screen so you can start voice typing with one click."
            control={<Switch checked={prefs['dictationBar.enabled']} label="Show the dictation bar" disabled={off} onChange={(on) => setPrefs({ 'dictationBar.enabled': on })} />}
          />
          <SettingsRow title="Start or stop recording" description="Records a meeting into a new note" control={<StandaloneShortcut id="recordToggle" />} />
        </SettingsCard>
      </div>

      <SettingsCard title="Personalization">
        <SettingsRow
          title="Styles"
          description="How formal your text is in email, chat and other apps"
          control={<span className="vt-chevron" aria-hidden="true">›</span>}
          onClick={() => navigateToSettings('voice-typing-styles')}
        />
        <SettingsRow
          title="Dictionary"
          description="Names and terms Notula should spell your way"
          control={<span className="vt-chevron" aria-hidden="true">›</span>}
          onClick={() => navigateToSettings('voice-typing-dictionary')}
        />
        {prefs['voiceTyping.screenContext'] ? (
          <SettingsRow
            title="Screen context"
            description={`Reads text near your cursor to spell names correctly and to learn your corrections.${cloudLlm ? ' That text is sent to your AI provider.' : ''}`}
            control={
              <Switch checked={prefs['dictation.screenContext']} label="Screen context" disabled={off} onChange={(on) => setPrefs({ 'dictation.screenContext': on })} />
            }
          />
        ) : null}
      </SettingsCard>

      <SettingsCard title="Sound">
        <SettingsRow
          title="Play sounds"
          description="Short sounds when voice typing starts, goes hands-free, finishes or needs your attention."
          control={<Switch checked={prefs['dictation.sounds']} label="Play sounds" disabled={off} onChange={(on) => setPrefs({ 'dictation.sounds': on })} />}
        />
        {!isMac ? (
          <SettingsRow
            title="Lower other audio while dictating"
            description="Other apps get quieter while you speak, on every speaker or headset, and come back up when Notula starts typing. A meeting Notula is recording is never lowered."
            control={
              <Switch
                checked={prefs['dictation.muteOtherAudio']}
                label="Lower other audio while dictating"
                disabled={off}
                onChange={(on) => setPrefs({ 'dictation.muteOtherAudio': on })}
              />
            }
          />
        ) : null}
      </SettingsCard>

      <SettingsCard title="Data and privacy">
        <SettingsRow
          title="Keep dictations on this computer"
          description={RETENTION_NOTE[retention]}
          control={<Select label="Keep dictations on this computer" value={retention} options={RETENTION} onChange={(v) => setPrefs({ 'dictation.localRetention': v })} />}
        />
      </SettingsCard>

      <SettingsCard>
        <SettingsRow
          title="History"
          description="Your recent dictations, to copy, delete or retry"
          control={<span className="vt-chevron" aria-hidden="true">›</span>}
          onClick={() => navigateToSettings('voice-typing-history')}
        />
        <SettingsRow
          title="Send feedback"
          description="Tell the Notula team what works and what doesn’t in voice typing"
          control={<span className="vt-chevron" aria-hidden="true">›</span>}
          onClick={() => navigateToSettings('feedback?topic=voice-typing')}
        />
      </SettingsCard>
    </div>
  )
}
