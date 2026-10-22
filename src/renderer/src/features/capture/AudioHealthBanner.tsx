// SPDX-License-Identifier: Apache-2.0
// The transcript panel's warning banner. At most
// one warning, in this order: W1 offline (cloud ASR only), W3 transcription error
// (W2 when antivirus is suspected), W6 silent microphone, W4 system-audio dropout,
// W5 macOS system-audio permission. Each names its reason. Notula has no help pages yet, so the
// actions are the ones that fix something: settings, sound settings, permissions.
//
// A system-only note (a source note) has no microphone: no microphone warning, and the
// system-audio ones don't promise that the microphone is still transcribed.

import { useEffect, useState, type JSX } from 'react'
import type { AsrProviderId } from '@shared/types/transcript'
import { useLiveSignals } from './live'
import { useCaptureSnapshot, type CaptureSnapshot } from './store'
import './prompts.css'

interface Warning {
  id: 'W1' | 'W2' | 'W3' | 'W4' | 'W5' | 'W6'
  tone: 'warn' | 'error'
  title: string
  reason: string
  action?: { label: string; run(): void }
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const on = (): void => setOnline(true)
    const off = (): void => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
}

function useAsrProvider(): AsrProviderId | null {
  const [provider, setProvider] = useState<AsrProviderId | null>(null)
  useEffect(() => {
    let alive = true
    void window.notula.prefs
      .get()
      .then((s) => alive && setProvider(s['asr.provider']))
      .catch(() => undefined)
    const off = window.notula.prefs.onChanged(({ settings }) => setProvider(settings['asr.provider']))
    return () => {
      alive = false
      off()
    }
  }, [])
  return provider
}

/** macOS only: system-audio (screen recording) permission denied. */
function useSystemAudioDenied(): boolean {
  const [denied, setDenied] = useState(false)
  useEffect(() => {
    let alive = true
    const apply = (s: { platform: NodeJS.Platform; systemAudio: string }): void => {
      if (alive) setDenied(s.platform === 'darwin' && s.systemAudio === 'denied')
    }
    void window.notula.permissions
      .getState()
      .then(apply)
      .catch(() => undefined)
    const off = window.notula.permissions.onChanged(apply)
    return () => {
      alive = false
      off()
    }
  }, [])
  return denied
}

const openAiSettings = (): void => window.notula.settings.open({ section: 'ai' })
const openAudioSettings = (): void => window.notula.system.openAudioSettings()

/** The microphone has sent only digital silence for a minute. */
export function micSilentReason(device: string | null, whileSystemSound: boolean): string {
  const who = device ? `“${device}”` : 'Your microphone'
  return whileSystemSound
    ? `${who} has sent no sound for a minute while others were talking, so your voice may be missing from the transcript. Check that it isn’t muted, or choose another microphone.`
    : `${who} has sent no sound for a minute. If you’re speaking, check that it isn’t muted, or choose another microphone.`
}

export const MIC_SILENT_TITLE = 'Your microphone isn’t sending any sound'

/** Why the combined state is an error, in the user's terms. */
function errorReason(s: CaptureSnapshot): Pick<Warning, 'reason' | 'action'> {
  const st = s.system
  if (isSystemOnly(s) && st.systemCapture === 'error') {
    return { reason: 'This computer’s audio can’t be captured, so the video isn’t being transcribed.', action: { label: 'Sound settings', run: openAudioSettings } }
  }
  const mic = st.microphoneCapture === 'error'
  const sys = st.systemCapture === 'error'
  if (mic && sys) {
    return { reason: 'Notula can’t capture your microphone or this computer’s audio.', action: { label: 'Sound settings', run: openAudioSettings } }
  }
  if (mic) {
    return {
      reason: 'Notula can’t capture your microphone. Check that it’s connected and selected.',
      action: { label: 'Sound settings', run: openAudioSettings }
    }
  }
  if (sys) return { reason: 'This computer’s audio can’t be captured, so other people’s voices aren’t transcribed.' }
  if (st.microphoneTranscription === 'error' || st.systemTranscription === 'error') {
    return {
      reason: 'The transcription service isn’t accepting audio. Check your provider and key.',
      action: { label: 'AI settings', run: openAiSettings }
    }
  }
  return { reason: 'Transcription didn’t start.', action: { label: 'AI settings', run: openAiSettings } }
}

/** The capture opened system audio alone (a source note). */
export function isSystemOnly(s: Pick<CaptureSnapshot, 'audioSources'>): boolean {
  return !s.audioSources.includes('microphone')
}

export function AudioHealthBanner({ noteId }: { noteId: string }): JSX.Element | null {
  const s = useCaptureSnapshot()
  const live = useLiveSignals()
  const online = useOnline()
  const provider = useAsrProvider()
  const systemAudioDenied = useSystemAudioDenied()
  if (s.transcribingNoteId !== noteId) return null
  const health = live.health.noteId === noteId ? live.health : null
  const systemOnly = isSystemOnly(s)

  let w: Warning | null = null
  if (!online && provider !== null && provider !== 'local' && s.ui !== 'inactive') {
    w = {
      id: 'W1',
      tone: 'warn',
      title: 'You’re offline, so transcription is paused.',
      reason: 'Notula keeps up to two minutes of audio and transcribes it once you’re back online.'
    }
  } else if (s.ui === 'error') {
    w = health?.antivirusSuspected
      ? {
          id: 'W2',
          tone: 'error',
          title: 'Your antivirus may be blocking Notula from the microphone.',
          reason: 'Kaspersky is running and Windows refused Notula the microphone. Allow Notula in your antivirus, then select Retry.'
        }
      : { id: 'W3', tone: 'error', title: 'Audio capture isn’t working.', ...errorReason(s) }
  } else if (health?.micSilent && !systemOnly) {
    w = {
      id: 'W6',
      tone: 'warn',
      title: MIC_SILENT_TITLE,
      reason: micSilentReason(health.micSilentDevice, health.micSilentWhileSystemSound),
      action: { label: 'Sound settings', run: openAudioSettings }
    }
  } else if (health?.systemDropout) {
    const n = health.restartsThisStreak
    w = {
      id: 'W4',
      tone: 'warn',
      title: systemOnly ? 'We’re not receiving this computer’s audio.' : `We’re not receiving audio from ${health.dropoutApp ?? 'other apps'}.`,
      reason: systemOnly
        ? n > 0
          ? `Notula restarted system audio ${n === 1 ? 'once' : `${n} times`} and keeps listening. Check that the video is playing.`
          : 'Notula is restarting system audio. Check that the video is playing.'
        : n > 0
          ? `Notula restarted system audio ${n === 1 ? 'once' : `${n} times`} and keeps listening. Your microphone is still transcribed.`
          : 'Notula is restarting system audio. Your microphone is still transcribed.'
    }
  } else if (systemAudioDenied) {
    w = {
      id: 'W5',
      tone: 'warn',
      title: 'Notula needs permission to capture this computer’s audio.',
      reason: 'Without it, only your microphone is transcribed.',
      action: { label: 'Grant permission', run: () => window.notula.system.openPrivacySettings({ target: 'screen-recording' }) }
    }
  }
  if (!w) return null

  return (
    <div className={`nt-health nt-health--${w.tone}`} role={w.tone === 'error' ? 'alert' : 'status'} data-warning={w.id}>
      <span className="nt-health__icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3.5 2.8 19.5h18.4L12 3.5Z" />
          <path d="M12 10v4M12 17h.01" />
        </svg>
      </span>
      <div className="nt-health__text">
        <div className="nt-health__title">{w.title}</div>
        <div className="nt-health__reason">{w.reason}</div>
      </div>
      {w.action ? (
        <button type="button" className="n-btn n-btn--sm nt-health__action" onClick={w.action.run}>
          {w.action.label}
        </button>
      ) : null}
    </div>
  )
}
