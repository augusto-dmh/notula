// SPDX-License-Identifier: Apache-2.0
// The chat composer's voice input: Start dictation,
// Send dictation (Enter, Ctrl/⌘+T) and Cancel dictation (Esc), auto-stop at 10 min. The audio
// goes to main on `dictation:audio` with this session's id; the text comes back unformatted and is
// placed in the composer. Shown while voice typing is on in Labs.

import { useEffect, useRef, useState, type JSX } from 'react'
import { DICTATION_LIMITS } from '@shared/types/dictation'
import { parseError } from '@shared/errors'
import { isMac } from '../../app/platform'
import { showToast } from '../../app/toast'
import { usePrefs } from '../settings/prefs-store'
import { MicCapture, micErrorOf } from './mic'
import './voice-typing.css'

const MIC_ERRORS: Record<string, string> = {
  mic_denied: 'Can’t use your mic',
  mic_missing: 'No microphone found',
  mic_busy: 'Mic didn’t start. Try closing other audio apps',
  mic_lost: 'Your mic cut out'
}

function MicIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5V14.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

export function ChatVoiceButton({ onText, disabled }: { onText(text: string): void; disabled?: boolean }): JSX.Element | null {
  const prefs = usePrefs()
  const [phase, setPhase] = useState<'idle' | 'starting' | 'live' | 'sending'>('idle')
  const [elapsed, setElapsed] = useState(0)
  const live = useRef<{ id: string; mic: MicCapture; started: number } | null>(null)
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  const cancel = (): void => {
    const cur = live.current
    live.current = null
    setPhase('idle')
    if (!cur) return
    cur.mic.release()
    window.notula.dictation.chatCancel({ sessionId: cur.id })
  }

  const send = async (): Promise<void> => {
    const cur = live.current
    if (!cur) return
    live.current = null
    setPhase('sending')
    await cur.mic.stop(100)
    try {
      const { text } = await window.notula.dictation.chatStop({ sessionId: cur.id })
      if (text) onTextRef.current(text)
    } catch (err) {
      showToast({ kind: 'error', title: parseError(err).message || 'Couldn’t transcribe that. Try again' })
    }
    setPhase('idle')
  }

  const start = async (): Promise<void> => {
    if (phase !== 'idle') return
    setPhase('starting')
    let sessionId: string
    try {
      sessionId = (await window.notula.dictation.chatStart({})).sessionId
    } catch (err) {
      setPhase('idle')
      showToast({ kind: 'error', title: parseError(err).message || 'Couldn’t start. Try again' })
      return
    }
    const mic = new MicCapture(
      (pcm) => window.notula.dictation.sendAudio({ sessionId, pcm }),
      () => undefined,
      (e) => {
        showToast({ kind: 'error', title: MIC_ERRORS[e] ?? 'Couldn’t start. Try again' })
        cancel()
      }
    )
    live.current = { id: sessionId, mic, started: Date.now() }
    try {
      await mic.start(prefs?.['dictation.microphone'] ?? null)
      setElapsed(0)
      setPhase('live')
    } catch (err) {
      const e = micErrorOf(err)
      showToast({ kind: 'error', title: MIC_ERRORS[e] ?? 'Couldn’t start. Try again' })
      cancel()
    }
  }

  // The timer and the 10 min auto-stop.
  useEffect(() => {
    if (phase !== 'live') return
    const t = setInterval(() => {
      const cur = live.current
      if (!cur) return
      const ms = Date.now() - cur.started
      setElapsed(ms)
      if (ms >= DICTATION_LIMITS.chatAutoStopMs) void send()
    }, 250)
    return () => clearInterval(t)
  }, [phase])

  // Enter or Ctrl/⌘+T sends; Esc cancels (while recording only).
  useEffect(() => {
    if (phase !== 'live') return
    const onKey = (e: KeyboardEvent): void => {
      const mod = isMac ? e.metaKey : e.ctrlKey
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        cancel()
      } else if (e.key === 'Enter' || (mod && e.key.toLowerCase() === 't')) {
        e.preventDefault()
        e.stopPropagation()
        void send()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [phase])

  useEffect(() => () => cancel(), [])

  if (!prefs?.['voiceTyping.enabled']) return null
  const mmss = `${Math.floor(elapsed / 60_000)}:${String(Math.floor((elapsed % 60_000) / 1_000)).padStart(2, '0')}`
  if (phase === 'live' || phase === 'sending') {
    return (
      <span className="chat-voice">
        <span className="chat-voice__time" aria-live="off">
          {mmss}
        </span>
        <button type="button" className="chat-voice__btn" aria-label="Cancel voice typing" title="Cancel voice typing (Esc)" disabled={phase === 'sending'} onClick={cancel}>
          ✕
        </button>
        <button
          type="button"
          className="chat-voice__btn chat-voice__btn--live"
          aria-label="Send dictation"
          title={`Send dictation (Enter, ${isMac ? '⌘ T' : 'Ctrl T'})`}
          disabled={phase === 'sending'}
          onClick={() => void send()}
        >
          ✓
        </button>
      </span>
    )
  }
  return (
    <button
      type="button"
      className="chat-voice__btn"
      aria-label="Start voice typing"
      title="Start voice typing"
      disabled={disabled || phase === 'starting'}
      onClick={() => void start()}
    >
      <MicIcon />
    </button>
  )
}
