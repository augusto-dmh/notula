// SPDX-License-Identifier: Apache-2.0
// The voice typing overlay: a full-window dialog in the main window, hosted once at the
// app shell. The steps:
//
// - intro (only from `notula://try-voice-typing`): a short pitch, Try it and Close;
// - setup: microphone access (the onboarding permission flow), the microphone picker with a live
//   level meter, and on macOS the Accessibility row, checked again whenever the window gets
//   focus. Next waits for the microphone;
// - try: the hold shortcut and two practice boxes, an AI prompt and a short email, which voice
//   typing formats as those destinations (main reads their labels, `PRACTICE_LABELS`);
// - hands-free: the hands-free shortcuts, with a practice box;
// - done: a short recap.
// When the shortcut can't be armed, the practice steps show the neutral conflict note.
//
// Done turns voice typing on and sets `dictation.onboardingCompleted`. Close and Escape only
// close: if a practice step turned voice typing on so the boxes work, Close turns it off
// again. Step changes go to the local debug log; nothing is sent.

import { useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { DICTATION_DEFAULT_SHORTCUT, PRACTICE_LABELS, type DictationMicrophone, type DictationStatus } from '@shared/types/dictation'
import type { HookEntry } from '@shared/types/dictation-bar'
import { debugLog, isMac } from '../../app/platform'
import { Modal } from '../folders/Modal'
import { CONFLICT_NOTE, EntryChips, KeyChips } from '../keyboard-shortcuts/KeyboardShortcutsSettings'
import { requestMicrophone, usePermissions } from '../onboarding/permissions-store'
import { getPrefs, setPrefs, usePrefs } from '../settings/prefs-store'
import { MicrophoneSelect } from './VoiceTypingSettings'
import './voice-typing-onboarding.css'

export type VoiceTypingOnboardingStep = 'intro' | 'setup' | 'try' | 'hands-free' | 'done'

// ---------- the store ----------

let current: { step: VoiceTypingOnboardingStep; nonce: number } | null = null
let nonce = 0
const listeners = new Set<() => void>()
const emit = (): void => {
  for (const l of listeners) l()
}
const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Opens the overlay (`intro` from the deep link, `setup` from the settings page). */
export function openVoiceTypingOnboarding(step: VoiceTypingOnboardingStep): void {
  current = { step, nonce: ++nonce }
  debugLog('voice-typing-onboarding:opened', { step })
  emit()
}

function closeOnboarding(): void {
  current = null
  emit()
}

/** `notula://try-voice-typing`: only while Labs ▸ Voice typing is on, on a supported platform. */
export function tryVoiceTypingFromLink(): void {
  void window.notula.dictation.getStatus().then(
    (st) => {
      if (!st.labsEnabled || !st.platformSupported) {
        debugLog('deeplink:try-voice-typing-gated')
        return
      }
      setPrefs({ 'dictation.enabled': true })
      openVoiceTypingOnboarding('intro')
    },
    () => debugLog('deeplink:try-voice-typing-gated')
  )
}

export function VoiceTypingOnboardingHost(): JSX.Element | null {
  const state = useSyncExternalStore(subscribe, () => current)
  if (!state) return null
  return <Onboarding key={state.nonce} first={state.step} />
}

// ---------- the overlay ----------

const SAMPLE_PROMPT = 'Summarize this thread in three bullet points and suggest a reply.'
const SAMPLE_EMAIL = 'Hi Alex, thanks for the notes. I’ll send the slides before lunch tomorrow. Best, Sam.'
const SAMPLE_HANDS_FREE = 'Remind me to book the team offsite for next month.'

function useStatus(): DictationStatus | null {
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
    window.addEventListener('focus', read)
    return () => {
      live = false
      window.removeEventListener('focus', read)
    }
  }, [])
  return status
}

/** The hold and hands-free entries that apply now. */
function useEntries(): { hold: HookEntry[]; handsFree: HookEntry[] } | null {
  const [entries, setEntries] = useState<{ hold: HookEntry[]; handsFree: HookEntry[] } | null>(null)
  useEffect(() => {
    let live = true
    const read = (): void => {
      void window.notula.shortcuts
        .list()
        .then((rows) => {
          if (!live) return
          const of = (id: string): HookEntry[] => rows.find((r) => r.id === id)?.entries ?? []
          setEntries({ hold: of('dictationHold'), handsFree: of('dictationHandsFree') })
        })
        .catch(() => undefined)
    }
    read()
    const off = window.notula.shortcuts.onChanged(read)
    return () => {
      live = false
      off()
    }
  }, [])
  return entries
}

/** A live input level for the chosen microphone, while the setup step shows. */
function LevelMeter({ microphone }: { microphone: DictationMicrophone | null }): JSX.Element {
  const bar = useRef<HTMLSpanElement>(null)
  const deviceId = microphone && typeof microphone === 'object' ? microphone.deviceId : null
  useEffect(() => {
    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    let frame = 0
    let live = true
    void navigator.mediaDevices
      .getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true, video: false })
      .then((s) => {
        if (!live) return s.getTracks().forEach((t) => t.stop())
        stream = s
        ctx = new AudioContext()
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 512
        ctx.createMediaStreamSource(s).connect(analyser)
        const data = new Float32Array(analyser.fftSize)
        const tick = (): void => {
          analyser.getFloatTimeDomainData(data)
          let sum = 0
          for (const v of data) sum += v * v
          const level = Math.min(1, Math.sqrt(sum / data.length) * 6)
          if (bar.current) bar.current.style.transform = `scaleX(${level})`
          frame = requestAnimationFrame(tick)
        }
        tick()
      })
      .catch(() => undefined)
    return () => {
      live = false
      cancelAnimationFrame(frame)
      stream?.getTracks().forEach((t) => t.stop())
      void ctx?.close().catch(() => undefined)
    }
  }, [deviceId])
  return (
    <div className="vto-meter" role="img" aria-label="Microphone level">
      <span ref={bar} className="vto-meter__bar" />
    </div>
  )
}

/** The pill while it listens: a small dark bar with moving levels. */
function PillIllustration(): JSX.Element {
  return (
    <div className="vto-visual" aria-hidden="true">
      <div className="vto-field">
        <span className="vto-field__line" />
        <span className="vto-field__line vto-field__line--short" />
        <span className="vto-field__caret" />
      </div>
      <div className="vto-pill">
        <span className="vto-pill__dot" />
        <span className="vto-pill__wave">
          {Array.from({ length: 12 }, (_, i) => (
            <span key={i} style={{ animationDelay: `${(i * 97) % 600}ms` }} />
          ))}
        </span>
      </div>
    </div>
  )
}

function Onboarding({ first }: { first: VoiceTypingOnboardingStep }): JSX.Element {
  const [step, setStep] = useState<VoiceTypingOnboardingStep>(first)
  const [asking, setAsking] = useState(false)
  const permissions = usePermissions()
  const prefs = usePrefs()
  const status = useStatus()
  const entries = useEntries()
  const enabledHere = useRef(false)
  const practice = useRef<HTMLTextAreaElement>(null)
  const mic = permissions?.microphone ?? 'unknown'
  const hookOn = !!status?.hook.available
  // The shortcut can't be armed: no helper chord and no toggle, or another app may answer it.
  const unarmed = !!status && status.armed && ((!hookOn && !status.shortcutRegistered) || status.conflict !== null)

  useEffect(() => debugLog('voice-typing-onboarding:step', { step }), [step])

  // The practice boxes need voice typing armed.
  useEffect(() => {
    if (step !== 'try' && step !== 'hands-free') return
    if (getPrefs()?.['dictation.enabled'] === false) {
      enabledHere.current = true
      setPrefs({ 'dictation.enabled': true })
    }
    practice.current?.focus()
  }, [step])

  const close = (): void => {
    if (enabledHere.current) setPrefs({ 'dictation.enabled': false })
    debugLog('voice-typing-onboarding:closed', { step })
    closeOnboarding()
  }
  const done = (): void => {
    setPrefs({ 'dictation.enabled': true, 'dictation.onboardingCompleted': true })
    debugLog('voice-typing-onboarding:done')
    closeOnboarding()
  }
  const allowMic = (): void => {
    setAsking(true)
    void requestMicrophone()
      .catch(() => undefined)
      .finally(() => setAsking(false))
  }
  const toggleKeys = <KeyChips accelerator={status?.shortcut ?? DICTATION_DEFAULT_SHORTCUT} />

  let body: JSX.Element
  if (step === 'intro') {
    body = (
      <>
        <h2 className="vto-title">Type with your voice in any app</h2>
        <p className="vto-text">Press your shortcut, say what you want to write, and Notula types it where your cursor is.</p>
        <div className="vto-actions">
          <button type="button" className="n-btn" onClick={close}>
            Close
          </button>
          <button type="button" className="n-btn n-btn--primary" data-autofocus onClick={() => setStep('setup')}>
            Try it
          </button>
        </div>
      </>
    )
  } else if (step === 'setup') {
    body = (
      <>
        <h2 className="vto-title">Set up your microphone</h2>
        <p className="vto-text">Notula listens only while you dictate.</p>
        <div className="vto-rows">
          <div className="vto-row">
            <div className="vto-row__text">
              <div className="vto-row__label">Microphone access</div>
              <div className="vto-row__hint">
                {mic === 'granted' ? 'Notula can use your microphone.' : mic === 'denied' ? 'Notula can’t use your microphone.' : 'Notula needs microphone access for voice typing.'}
              </div>
            </div>
            {mic === 'granted' ? (
              <span className="vto-ok">Allowed</span>
            ) : mic === 'denied' ? (
              <button type="button" className="n-btn n-btn--sm" onClick={() => window.notula.system.openPrivacySettings({ target: 'microphone' })}>
                Open settings
              </button>
            ) : (
              <button type="button" className="n-btn n-btn--sm" data-autofocus disabled={asking} onClick={allowMic}>
                {asking ? 'Asking…' : 'Allow microphone'}
              </button>
            )}
          </div>
          <div className="vto-row vto-row--stack">
            <div className="vto-row__text">
              <div className="vto-row__label">Microphone</div>
              <div className="vto-row__hint">Speak to check the level moves.</div>
            </div>
            <MicrophoneSelect value={prefs?.['dictation.microphone'] ?? null} disabled={false} />
            {mic === 'granted' ? <LevelMeter microphone={prefs?.['dictation.microphone'] ?? null} /> : null}
          </div>
          {isMac ? (
            <div className="vto-row">
              <div className="vto-row__text">
                <div className="vto-row__label">Accessibility</div>
                <div className="vto-row__hint">Lets Notula paste the text into other apps.</div>
              </div>
              {status?.accessibility === 'granted' ? (
                <span className="vto-ok">Allowed</span>
              ) : (
                <button type="button" className="n-btn n-btn--sm" onClick={() => window.notula.system.openPrivacySettings({ target: 'accessibility' })}>
                  Open settings
                </button>
              )}
            </div>
          ) : null}
        </div>
        <div className="vto-actions">
          <button type="button" className="n-btn" onClick={close}>
            Close
          </button>
          <button type="button" className="n-btn n-btn--primary" disabled={mic !== 'granted'} onClick={() => setStep('try')}>
            Next
          </button>
        </div>
      </>
    )
  } else if (step === 'try') {
    const hold = hookOn ? entries?.hold[0] : undefined
    body = (
      <>
        <h2 className="vto-title">Try it</h2>
        <div className="vto-keys">{hold ? <EntryChips entry={hold} /> : toggleKeys}</div>
        <p className="vto-text">
          {hold ? 'Click a box, hold your shortcut while you speak, then let go.' : 'Click a box, press your shortcut, speak, then press it again.'} Notula
          formats each one for where it goes.
        </p>
        {unarmed ? <p className="vto-note">{CONFLICT_NOTE}</p> : null}
        <label className="vto-label">
          An AI prompt. Try: “{SAMPLE_PROMPT}”
          <textarea ref={practice} className="vto-practice" aria-label={PRACTICE_LABELS.aiChat} placeholder="Your prompt appears here" rows={2} />
        </label>
        <label className="vto-label">
          A short email. Try: “{SAMPLE_EMAIL}”
          <textarea className="vto-practice" aria-label={PRACTICE_LABELS.email} placeholder="Your email appears here" rows={4} />
        </label>
        <button type="button" className="vt-link vto-change" onClick={() => setStep('setup')}>
          Change microphone
        </button>
        <div className="vto-actions">
          <button type="button" className="n-btn" onClick={close}>
            Close
          </button>
          <button type="button" className="n-btn n-btn--primary" onClick={() => setStep('hands-free')}>
            Next
          </button>
        </div>
      </>
    )
  } else if (step === 'hands-free') {
    const list = hookOn ? (entries?.handsFree ?? []) : []
    body = (
      <>
        <h2 className="vto-title">Keep talking hands-free</h2>
        <p className="vto-text">For longer text, start hands-free and press your shortcut again when you’re done. Esc cancels.</p>
        <div className="vto-keys vto-keys--list">{list.length ? list.map((e) => <EntryChips key={`${e.keys}:${e.doubleTap}`} entry={e} />) : toggleKeys}</div>
        {unarmed ? <p className="vto-note">{CONFLICT_NOTE}</p> : null}
        <label className="vto-label">
          Try: “{SAMPLE_HANDS_FREE}”
          <textarea ref={practice} className="vto-practice" aria-label="Practice box" placeholder="Your words appear here" rows={3} />
        </label>
        <div className="vto-actions">
          <button type="button" className="n-btn" onClick={() => setStep('try')}>
            Back
          </button>
          <button type="button" className="n-btn n-btn--primary" onClick={() => setStep('done')}>
            Next
          </button>
        </div>
      </>
    )
  } else {
    body = (
      <>
        <h2 className="vto-title">You’re ready</h2>
        <p className="vto-text">Voice typing works in any app. Change shortcuts, styles and your dictionary in Settings ▸ Voice typing.</p>
        <div className="vto-actions">
          <button type="button" className="n-btn n-btn--primary" data-autofocus onClick={done}>
            Done
          </button>
        </div>
      </>
    )
  }

  return (
    <Modal label="Voice typing" className="vto" onClose={close}>
      <div className="vto-panel">
        <PillIllustration />
        <div className="vto-body">{body}</div>
      </div>
    </Modal>
  )
}
