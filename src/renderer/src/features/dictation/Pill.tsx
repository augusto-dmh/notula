// SPDX-License-Identifier: Apache-2.0
// The dictation pill (`#/dictation-pill`): a small
// floating bar at the bottom of the screen that never takes focus. It shows the state main
// pushes (`dictation:state`) and does the microphone capture main asks for
// (`dictation:capture` → `dictation:audio`, `dictation:capture-event`).
//
// - recording: a live waveform; hands-free adds Cancel and Finish;
// - processing: animated bars; pasted, copied, empty and the errors: one short line;
// - saved: the retry card (Retry, Open history, Dismiss), which fits the 320 × 180 window;
// - cards (`state.card`): the neutral conflict card (Change shortcut, Keep going), learned words
//   (Undo), check-your-mic while recording is silent, and "the text is in your history";
// - sounds (`state.sound`, only sent while `dictation.sounds` is on): start, lock, finish, notice.
// Hovering makes the window clickable (`dictation:pill-action` `hover`); a click finishes a recording,
// opens the microphone settings on `mic_denied`, or starts a hands-free dictation.
// With the dictation bar on (`dictation-bar:state`), the same content is the bar's wide
// layout and ./DictationBar.tsx draws the rest.

import { useEffect, useRef, useState, type JSX } from 'react'
import type { DictationCaptureCommand, DictationCard, DictationSound, DictationState } from '@shared/types/dictation'
import type { DictationBarState } from '@shared/types/dictation-bar'
import { DictationBarView } from './DictationBar'
import { MicCapture, micErrorOf } from './mic'
import finishSound from './sounds/finish.wav'
import lockSound from './sounds/lock.wav'
import noticeSound from './sounds/notice.wav'
import startSound from './sounds/start.wav'
import './pill.css'

const SOUNDS: Record<DictationSound, string> = { start: startSound, lock: lockSound, finish: finishSound, notice: noticeSound }

function play(sound: DictationSound): void {
  const a = new Audio(SOUNDS[sound])
  a.volume = 0.5
  void a.play().catch(() => undefined)
}

const BARS = 18

const ERRORS: Record<string, string> = {
  mic_denied: 'Can’t use your mic',
  mic_missing: 'No microphone found',
  mic_busy: 'Mic didn’t start. Try closing other audio apps',
  mic_lost: 'Your mic cut out',
  connection: 'Lost the connection',
  connection_timeout: 'Can’t reach the transcription service',
  offline: 'You’re offline',
  transcription_start: 'Couldn’t start. Try again',
  processing_failed: 'Couldn’t process that. Try again',
  clipboard_failed: 'Couldn’t paste or copy the text'
}

/** A card button: the action goes to main, never to the pill's own click. */
const pillAction =
  (action: 'retry' | 'open-history' | 'dismiss' | 'undo-learned' | 'change-shortcut' | 'keep-going') =>
  (e: { stopPropagation(): void }): void => {
    e.stopPropagation()
    window.notula.dictation.pillAction({ action })
  }

const learnedLine = (words: string[]): string =>
  words.length === 1 ? `Notula will spell “${words[0]}” your way.` : `Notula will spell ${words.map((w) => `“${w}”`).join(', ')} your way.`

/** A card over the pill's line. Buttons send their action to main, never the pill's own click. */
function Card({ card }: { card: DictationCard }): JSX.Element {
  switch (card.kind) {
    case 'conflict':
      return (
        <div className="dict-card" role="status">
          <div className="dict-card__head">
            <strong className="dict-card__title">Another app may use this shortcut</strong>
          </div>
          <span className="dict-card__line">If voice typing starts twice or not at all, pick a different shortcut.</span>
          <div className="dict-card__actions">
            <button type="button" className="dict-card__btn" onClick={pillAction('keep-going')}>
              Keep going
            </button>
            <button type="button" className="dict-card__btn dict-card__btn--primary" onClick={pillAction('change-shortcut')}>
              Change shortcut
            </button>
          </div>
        </div>
      )
    case 'learned':
      return (
        <div className="dict-card" role="status">
          <div className="dict-card__head">
            <strong className="dict-card__title">Added to your dictionary</strong>
            <button type="button" className="dict-card__close" aria-label="Dismiss" onClick={pillAction('dismiss')}>
              ✕
            </button>
          </div>
          <span className="dict-card__line">{learnedLine(card.words)}</span>
          <div className="dict-card__actions">
            <button type="button" className="dict-card__btn" onClick={pillAction('undo-learned')}>
              Undo
            </button>
          </div>
        </div>
      )
    case 'in-history':
      return (
        <div className="dict-card" role="alert">
          <div className="dict-card__head">
            <strong className="dict-card__title">Couldn’t paste or copy the text</strong>
          </div>
          <span className="dict-card__line">Your text is saved in your voice typing history.</span>
          <div className="dict-card__actions">
            <button type="button" className="dict-card__btn dict-card__btn--primary" onClick={pillAction('open-history')}>
              Open history
            </button>
          </div>
        </div>
      )
    case 'mic-lid':
      return <span className="dict-pill__hint">Your laptop lid may be closed. Open it or pick another microphone.</span>
    case 'mic-silent':
      return <span className="dict-pill__hint">Notula can’t hear you. Check your microphone.</span>
  }
}

function Waveform({ levels }: { levels: number[] }): JSX.Element {
  return (
    <div className="dict-wave" aria-hidden="true">
      {levels.map((l, i) => (
        <span key={i} style={{ transform: `scaleY(${Math.max(0.12, Math.min(1, l))})` }} />
      ))}
    </div>
  )
}

export function DictationPill(): JSX.Element {
  const [state, setState] = useState<DictationState>({ kind: 'idle', ready: false, handsFree: false, reason: null, type: null })
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0))
  const mic = useRef<{ id: string; capture: MicCapture } | null>(null)
  const level = useRef(0)
  const [bar, setBar] = useState<DictationBarState | null>(null)

  useEffect(() => {
    document.documentElement.classList.add('dict-pill-doc')
    const offState = window.notula.dictation.onState((s) => {
      if (s.sound) play(s.sound)
      setState(s)
    })
    const offBar = window.notula.dictationBar.onState((b) => setBar(b))
    // Mounted: the first rect report tells main to send the bar state.
    window.notula.dictationBar.reportHitRects({ rects: [] })
    const offCapture = window.notula.dictation.onCapture((cmd: DictationCaptureCommand) => {
      const cur = mic.current
      if (cmd.action === 'start') {
        cur?.capture.release()
        const capture = new MicCapture(
          (pcm) => window.notula.dictation.sendAudio({ sessionId: cmd.sessionId, pcm }),
          (l) => (level.current = l),
          (error) =>
            window.notula.dictation.captureEvent({
              sessionId: cmd.sessionId,
              type: 'error',
              ...(error === 'transcription_start' ? {} : { error })
            }),
          (health) => window.notula.dictation.captureEvent({ sessionId: cmd.sessionId, type: 'health', health })
        )
        mic.current = { id: cmd.sessionId, capture }
        capture.start(cmd.microphone).then(
          (device) => window.notula.dictation.captureEvent({ sessionId: cmd.sessionId, type: 'ready', ...(device ? { device } : {}) }),
          (err: unknown) => {
            const e = micErrorOf(err)
            const error = e === 'transcription_start' ? 'mic_missing' : e
            capture.release()
            window.notula.dictation.captureEvent({ sessionId: cmd.sessionId, type: 'error', error })
          }
        )
        return
      }
      if (!cur || cur.id !== cmd.sessionId) return
      mic.current = null
      if (cmd.action === 'stop') void cur.capture.stop(100)
      else cur.capture.release()
    })
    return () => {
      offState()
      offBar()
      offCapture()
      mic.current?.capture.release()
    }
  }, [])

  // The waveform: a rolling window of the last levels, ~16 updates a second.
  useEffect(() => {
    if (state.kind !== 'recording') return
    const t = setInterval(() => setLevels((prev) => [...prev.slice(1), level.current]), 60)
    return () => {
      clearInterval(t)
      setLevels(Array(BARS).fill(0))
    }
  }, [state.kind])

  const hover = (hovered: boolean): void => window.notula.dictation.pillAction({ action: 'hover', hovered })
  const click = (): void => {
    if (state.kind === 'error' && state.reason === 'mic_denied') window.notula.system.openPrivacySettings({ target: 'microphone' })
    window.notula.dictation.pillAction({ action: 'click' })
  }

  let body: JSX.Element | null = null
  switch (state.kind) {
    case 'recording':
      body = (
        <>
          {state.handsFree ? (
            <button
              type="button"
              className="dict-pill__btn"
              aria-label="Cancel"
              onClick={(e) => {
                e.stopPropagation()
                window.notula.dictation.pillAction({ action: 'cancel' })
              }}
            >
              ✕
            </button>
          ) : null}
          <span className={`dict-pill__dot${state.ready ? ' is-ready' : ''}`} aria-hidden="true" />
          {state.card ? <Card card={state.card} /> : <Waveform levels={levels} />}
          {state.handsFree ? (
            <button
              type="button"
              className="dict-pill__btn dict-pill__btn--primary"
              aria-label="Finish"
              onClick={(e) => {
                e.stopPropagation()
                window.notula.dictation.pillAction({ action: 'finish' })
              }}
            >
              ✓
            </button>
          ) : null}
        </>
      )
      break
    case 'processing':
      body = (
        <div className="dict-proc" role="status" aria-label="Processing dictation">
          <span />
          <span />
          <span />
          <span />
        </div>
      )
      break
    case 'copied':
      body = (
        <span className="dict-pill__text" role="status">
          <strong>Copied</strong>
          {state.reason && state.reason !== 'no_focus' ? <span className="dict-pill__sub">Couldn’t paste automatically. Paste it where you need it.</span> : null}
        </span>
      )
      break
    case 'empty':
      body = (
        <span className="dict-pill__text" role="status">
          Didn’t catch that
        </span>
      )
      break
    case 'pasted':
      body = (
        <span className="dict-pill__text" role="status">
          <strong>Pasted</strong>
        </span>
      )
      break
    case 'saved':
      body = (
        <div className="dict-card" role="status">
          <div className="dict-card__head">
            <strong className="dict-card__title">Your audio is saved</strong>
            <button type="button" className="dict-card__close" aria-label="Dismiss" onClick={pillAction('dismiss')}>
              ✕
            </button>
          </div>
          <span className="dict-card__line">Try again now, or find it in your history.</span>
          <div className="dict-card__actions">
            <button type="button" className="dict-card__btn" onClick={pillAction('open-history')}>
              Open history
            </button>
            <button type="button" className="dict-card__btn dict-card__btn--primary" onClick={pillAction('retry')}>
              Retry
            </button>
          </div>
        </div>
      )
      break
    case 'notice':
      body = state.card ? <Card card={state.card} /> : null
      break
    case 'error':
      body = state.card ? (
        <Card card={state.card} />
      ) : (
        <span className="dict-pill__text dict-pill__text--error" role="alert">
          {ERRORS[state.reason ?? ''] ?? 'Something went wrong'}
        </span>
      )
      break
    default:
      body = null
  }

  const cardShown = !!state.card && state.kind !== 'recording'

  if (bar?.enabled) {
    return (
      <DictationBarView
        bar={bar}
        dictation={
          body ? (
            <div className={`dict-pill dict-pill--${state.kind}${cardShown ? ' dict-pill--card' : ''}`} data-hit="" onClick={click}>
              {body}
            </div>
          ) : null
        }
      />
    )
  }

  return (
    <div className="dict-pill-root">
      {body ? (
        <div
          className={`dict-pill dict-pill--${state.kind}${cardShown ? ' dict-pill--card' : ''}`}
          onMouseEnter={() => hover(true)}
          onMouseLeave={() => hover(false)}
          onClick={click}
        >
          {body}
        </div>
      ) : null}
    </div>
  )
}
