// SPDX-License-Identifier: Apache-2.0
// The dictation pill (`#/dictation-pill`): a small
// floating bar at the bottom of the screen that never takes focus. It shows the state main
// pushes (`dictation:state`) and does the microphone capture main asks for
// (`dictation:capture` → `dictation:audio`, `dictation:capture-event`).
//
// - recording: a calm level display (7 bars on a soft hill); hands-free adds Cancel and Finish;
// - processing: the same bars settle, then a slow ripple; pasted, copied, empty and the errors: one short line;
// - saved: the retry card (Retry, Open history, Dismiss), which fits the 320 × 180 window;
// - cards (`state.card`): the neutral conflict card (Change shortcut, Keep going), learned words
//   (Undo), check-your-mic while recording is silent, and "the text is in your history";
// - pasted without formatting (formatting failed): one line with a link to Settings ▸ AI;
// - sounds (`state.sound`, only sent while `dictation.sounds` is on): start, lock, finish, notice.
// Hovering makes the window clickable (`dictation:pill-action` `hover`); a click finishes a recording,
// opens the microphone settings on `mic_denied`, or starts a hands-free dictation.
// With the dictation bar on (`dictation-bar:state`), the same content is the bar's wide
// layout and ./DictationBar.tsx draws the rest. There it grows out of the resting capsule and
// shrinks back into it (`BarFrame`, `useBarSurface`).

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type JSX, type ReactNode } from 'react'
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
  (action: 'retry' | 'open-history' | 'dismiss' | 'undo-learned' | 'change-shortcut' | 'keep-going' | 'open-ai-settings') =>
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
    case 'unformatted':
      return (
        <span className="dict-pill__text" role="status">
          <strong>Pasted without formatting</strong>
          <span className="dict-pill__sub" aria-hidden="true">
            ·
          </span>
          <button type="button" className="dict-pill__link" onClick={pillAction('open-ai-settings')}>
            AI settings
          </button>
        </span>
      )
  }
}

/**
 * The level display: one smoothed level drawn as a soft hill, never as a history. `phase`: per
 * bar, a small spread of the smoothing and breath timing, so the hill doesn't move as one block.
 */
const BARS = [
  { weight: 0.45, phase: -0.1 },
  { weight: 0.65, phase: 0.06 },
  { weight: 0.85, phase: -0.04 },
  { weight: 1, phase: 0 },
  { weight: 0.85, phase: 0.04 },
  { weight: 0.65, phase: -0.06 },
  { weight: 0.45, phase: 0.1 }
]
const BASE_PX = 4
const SWING_PX = 14
const ATTACK_MS = 60
const RELEASE_MS = 220
const BREATH_MS = 2400
const SETTLE_MS = 200
const RIPPLE_MS = 1200
const OPACITY = 0.85
/** Reduced motion: plain steps at 8 Hz. */
const STEP_MS = 125

export interface LevelRef {
  current: number
}

/**
 * `level`: the mic's raw level (0–1). `smooth`: the last smoothed level, shared so processing
 * settles from where recording left off. `still`: reduced motion. One rAF loop while mounted;
 * the bars are styled directly, so a frame never re-renders React.
 */
export function Waveform({ level, smooth, mode, still }: { level: LevelRef; smooth: LevelRef; mode: 'recording' | 'processing'; still: boolean }): JSX.Element {
  const els = useRef<(HTMLSpanElement | null)[]>([])

  useEffect(() => {
    const paint = (i: number, h: number, o = OPACITY): void => {
      const el = els.current[i]
      if (!el) return
      el.style.height = `${h.toFixed(2)}px`
      el.style.opacity = o.toFixed(3)
    }
    if (still) {
      if (mode === 'processing') {
        smooth.current = 0
        BARS.forEach((_, i) => paint(i, BASE_PX))
        return
      }
      const step = (): void => BARS.forEach((b, i) => paint(i, BASE_PX + level.current * b.weight * SWING_PX))
      step()
      const t = setInterval(step, STEP_MS)
      return () => clearInterval(t)
    }

    // Each bar keeps its own smoothed level; the centre bar's is the one shared.
    const live = BARS.map((b) => ({ ...b, v: smooth.current, from: smooth.current }))
    const centre = live[3]
    const start = performance.now()
    let last = start
    let raf = 0
    const frame = (now: number): void => {
      const dt = Math.min(100, Math.max(0, now - last))
      last = now
      if (mode === 'recording') {
        const target = level.current
        live.forEach((b, i) => {
          const tau = (target > b.v ? ATTACK_MS : RELEASE_MS) * (1 + b.phase)
          b.v += (target - b.v) * (1 - Math.exp(-dt / tau))
          // The breath fades out as the voice comes in.
          const breath = Math.sin(2 * Math.PI * (now / BREATH_MS + b.phase)) * Math.max(0, 1 - b.v * 5)
          paint(i, BASE_PX + b.v * b.weight * SWING_PX + breath)
        })
        smooth.current = centre?.v ?? 0
      } else {
        const k = Math.min(1, Math.max(0, now - start) / SETTLE_MS)
        const ease = 1 - (1 - k) ** 3
        // After the settle, the ripple fades in: a crest travelling left to right.
        const since = now - start - SETTLE_MS
        const depth = since <= 0 ? 0 : Math.min(1, since / 300)
        live.forEach((b, i) => {
          const crest = 0.5 + 0.5 * Math.cos(2 * Math.PI * (since / RIPPLE_MS - i / live.length))
          paint(i, BASE_PX + b.from * (1 - ease) * b.weight * SWING_PX, OPACITY - depth * 0.45 * (1 - crest))
        })
        smooth.current = (centre?.from ?? 0) * (1 - ease)
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [level, smooth, mode, still])

  return (
    <div className="dict-wave" aria-hidden="true">
      {BARS.map((_, i) => (
        <span
          key={i}
          ref={(el) => {
            els.current[i] = el
          }}
        />
      ))}
    </div>
  )
}

/** The OS reduced-motion setting, live. */
function useReducedMotion(): boolean {
  const [still, setStill] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const m = window.matchMedia('(prefers-reduced-motion: reduce)')
    const on = (): void => setStill(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return still
}

/** How long the bar keeps the last content on screen to shrink it into the capsule. */
const LEAVE_MS = 140

/**
 * The bar's dictation surface. Mounted, it grows out of the resting capsule; `leaving`, it fades
 * its content and shrinks back. Its natural size is measured before the first paint of each
 * phase, so the keyframes tween between real sizes (CSS can't tween to `auto`).
 */
export function BarFrame({ className, leaving, still, onClick, children }: { className: string; leaving: boolean; still: boolean; onClick?: () => void; children: ReactNode }): JSX.Element {
  const el = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ leaving: boolean; w: number; h: number; grown?: boolean } | null>(null)
  useLayoutEffect(() => {
    const r = el.current?.getBoundingClientRect()
    if (r) setSize({ leaving, w: r.width, h: r.height })
  }, [leaving])
  // Once grown, the class goes, so content that changes later (recording → processing) doesn't fade in again.
  const phase = size?.leaving !== leaving ? '' : leaving ? ' is-leaving' : size.grown ? '' : ' is-entering'
  return (
    <div
      ref={el}
      className={`${className} dict-pill--bar${phase}${still ? ' is-still' : ''}`}
      style={size ? ({ '--dict-w': `${size.w}px`, '--dict-h': `${size.h}px` } as CSSProperties) : undefined}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget && !leaving) setSize((s) => (s && !s.leaving ? { ...s, grown: true } : s))
      }}
      {...(leaving ? {} : { 'data-hit': '', onClick })}
    >
      {children}
    </div>
  )
}

/**
 * The bar's content, kept on screen for the shrink after the dictation ends. Off (`enabled`
 * false, the plain pill) it simply goes.
 */
export function useBarSurface<T>(current: T | null, enabled: boolean): { value: T; leaving: boolean } | null {
  const last = useRef<T | null>(null)
  const [shown, setShown] = useState(current !== null)
  const [leaving, setLeaving] = useState(false)
  if ((current !== null) !== shown) {
    setShown(current !== null)
    setLeaving(current === null && enabled && last.current !== null)
  }
  useLayoutEffect(() => {
    if (current !== null) last.current = current
  })
  useEffect(() => {
    if (!leaving) return
    const t = setTimeout(() => setLeaving(false), LEAVE_MS)
    return () => clearTimeout(t)
  }, [leaving])
  if (current !== null) return { value: current, leaving: false }
  return leaving && last.current !== null ? { value: last.current, leaving: true } : null
}

export function DictationPill(): JSX.Element {
  const [state, setState] = useState<DictationState>({ kind: 'idle', ready: false, handsFree: false, reason: null, type: null })
  const mic = useRef<{ id: string; capture: MicCapture } | null>(null)
  const level = useRef(0)
  const smooth = useRef(0)
  const still = useReducedMotion()
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
          {state.card ? <Card card={state.card} /> : <Waveform level={level} smooth={smooth} mode="recording" still={still} />}
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
      // The dot stays (grey: the mic is off), so the bars don't shift when recording ends.
      body = (
        <>
          <span className="dict-pill__dot" aria-hidden="true" />
          <div className="dict-proc" role="status" aria-label="Processing dictation">
            <Waveform level={level} smooth={smooth} mode="processing" still={still} />
          </div>
        </>
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
      body =
        state.card?.kind === 'unformatted' ? (
          <Card card={state.card} />
        ) : (
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

  // The unformatted hint is one line, not a card.
  const cardShown = !!state.card && state.kind !== 'recording' && state.card.kind !== 'unformatted'
  const pillClass = `dict-pill dict-pill--${state.kind}${cardShown ? ' dict-pill--card' : ''}`
  const surface = useBarSurface(body ? { body, pillClass } : null, !!bar?.enabled)

  if (bar?.enabled) {
    return (
      <DictationBarView
        bar={bar}
        dictation={
          surface ? (
            <BarFrame className={surface.value.pillClass} leaving={surface.leaving} still={still} onClick={click}>
              {surface.value.body}
            </BarFrame>
          ) : null
        }
      />
    )
  }

  return (
    <div className="dict-pill-root">
      {body ? (
        <div
          className={pillClass}
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
