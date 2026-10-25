// SPDX-License-Identifier: Apache-2.0
// The voice typing overlay: a full-window dialog in the main window, hosted once at the
// app shell. Three steps:
//
// - intro (only from `notula://try-voice-typing`): a short pitch, Try it and Close;
// - setup: microphone access (the onboarding permission flow), the microphone picker, and on
//   macOS the Accessibility row, checked again whenever the window gets focus. Next waits for
//   the microphone;
// - try: the current shortcut, a sample sentence and a focused practice box that receives the
//   dictation.
//
// Done turns voice typing on and sets `dictation.onboardingCompleted`. Close and Escape only
// close: if the try step turned voice typing on so the practice box works, Close turns it off
// again. Step changes go to the local debug log; nothing is sent.

import { useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { DICTATION_DEFAULT_SHORTCUT, type DictationStatus } from '@shared/types/dictation'
import { debugLog, isMac } from '../../app/platform'
import { Modal } from '../folders/Modal'
import { KeyChips } from '../keyboard-shortcuts/KeyboardShortcutsSettings'
import { requestMicrophone, usePermissions } from '../onboarding/permissions-store'
import { getPrefs, setPrefs, usePrefs } from '../settings/prefs-store'
import { MicrophoneSelect } from './VoiceTypingSettings'
import './voice-typing-onboarding.css'

export type VoiceTypingOnboardingStep = 'intro' | 'setup' | 'try'

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

const SAMPLE = 'Remind me to send the slides to Alex before lunch tomorrow.'

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
  const enabledHere = useRef(false)
  const practice = useRef<HTMLTextAreaElement>(null)
  const mic = permissions?.microphone ?? 'unknown'

  useEffect(() => debugLog('voice-typing-onboarding:step', { step }), [step])

  // The practice box needs voice typing armed.
  useEffect(() => {
    if (step !== 'try') return
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
              <div className="vto-row__hint">The microphone to use for voice typing</div>
            </div>
            <MicrophoneSelect value={prefs?.['dictation.microphone'] ?? null} disabled={false} />
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
  } else {
    body = (
      <>
        <h2 className="vto-title">Try it</h2>
        <div className="vto-keys">
          <KeyChips accelerator={status?.shortcut ?? DICTATION_DEFAULT_SHORTCUT} />
        </div>
        <p className="vto-text">
          Press your shortcut and say: “{SAMPLE}” Then press it again to finish.
        </p>
        <textarea ref={practice} className="vto-practice" aria-label="Practice box" placeholder="Your words appear here" rows={4} />
        <button type="button" className="vt-link vto-change" onClick={() => setStep('setup')}>
          Change microphone
        </button>
        <div className="vto-actions">
          <button type="button" className="n-btn" onClick={close}>
            Close
          </button>
          <button type="button" className="n-btn n-btn--primary" onClick={done}>
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
