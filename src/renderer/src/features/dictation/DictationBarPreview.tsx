// SPDX-License-Identifier: Apache-2.0
// Dev only (`#/dictation-bar-preview`, compiled out of production builds): the dictation bar's
// states side by side, with simulated mic levels, so its look can be judged without dictating.
// It draws the real BarFrame and Waveform and never talks to main.

import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { BarFrame, useBarSurface, Waveform, type LevelRef } from './Pill'
import './pill.css'
import './dictation-bar.css'
import './dictation-bar-preview.css'

type Loudness = 'quiet' | 'normal' | 'loud'

const PEAK: Record<Loudness, number> = { quiet: 0.15, normal: 0.45, loud: 0.9 }

/** Speech-like raw levels: syllables inside phrases, with pauses and jitter, at mic rate. */
function useSimulatedLevel(loudness: Loudness): LevelRef {
  const level = useRef(0)
  useEffect(() => {
    const t0 = performance.now()
    const t = setInterval(() => {
      const ms = performance.now() - t0
      const inPhrase = ms % 2600 < 1900
      const syllable = Math.max(0, Math.sin((2 * Math.PI * ms) / 230))
      level.current = inPhrase ? Math.min(1, PEAK[loudness] * (0.35 + 0.65 * syllable) * (0.75 + Math.random() * 0.5)) : Math.random() * 0.02
    }, 40)
    return () => clearInterval(t)
  }, [loudness])
  return level
}

function Cell({ title, note, children }: { title: string; note?: string; children: ReactNode }): JSX.Element {
  return (
    <figure className="dbp-cell">
      <div className="dict-pill-root dict-pill-root--bar dbp-window">{children}</div>
      <figcaption>
        <strong>{title}</strong>
        {note ? <span>{note}</span> : null}
      </figcaption>
    </figure>
  )
}

function Capsule(): JSX.Element {
  return (
    <div className="dbar">
      <span className="dbar-bubble" />
    </div>
  )
}

function Recording({ loudness, still }: { loudness: Loudness; still: boolean }): JSX.Element {
  const level = useSimulatedLevel(loudness)
  const smooth = useRef(0)
  return (
    <BarFrame className="dict-pill dict-pill--recording" leaving={false} still={still}>
      <span className="dict-pill__dot is-ready" />
      <Waveform level={level} smooth={smooth} mode="recording" still={still} />
    </BarFrame>
  )
}

/** Processing, replayed every 4 s from a mid level so the settle shows too. */
function Processing({ still }: { still: boolean }): JSX.Element {
  const [round, setRound] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setRound((r) => r + 1), 4000)
    return () => clearInterval(t)
  }, [])
  return <ProcessingRound key={round} still={still} />
}

function ProcessingRound({ still }: { still: boolean }): JSX.Element {
  const level = useRef(0)
  const smooth = useRef(0.6)
  return (
    <BarFrame className="dict-pill dict-pill--processing" leaving={false} still={still}>
      <span className="dict-pill__dot" />
      <div className="dict-proc">
        <Waveform level={level} smooth={smooth} mode="processing" still={still} />
      </div>
    </BarFrame>
  )
}

type Step = 'rest' | 'recording' | 'processing'
const CYCLE: { step: Step; ms: number }[] = [
  { step: 'rest', ms: 1400 },
  { step: 'recording', ms: 4200 },
  { step: 'processing', ms: 1800 }
]

/** The whole round trip on a loop: rest, grow, speak, process, shrink back. */
function Cycle({ still }: { still: boolean }): JSX.Element {
  const [i, setI] = useState(0)
  useEffect(() => {
    const t = setTimeout(() => setI((n) => (n + 1) % CYCLE.length), CYCLE[i]?.ms ?? 1000)
    return () => clearTimeout(t)
  }, [i])
  const step = CYCLE[i]?.step ?? 'rest'
  const level = useSimulatedLevel('normal')
  const smooth = useRef(0)
  const surface = useBarSurface(step === 'rest' ? null : { step }, true)
  if (!surface) return <Capsule />
  const s = surface.value.step
  return (
    <BarFrame className={`dict-pill dict-pill--${s}`} leaving={surface.leaving} still={still}>
      <span className={`dict-pill__dot${s === 'recording' ? ' is-ready' : ''}`} />
      {s === 'recording' ? (
        <Waveform level={level} smooth={smooth} mode="recording" still={still} />
      ) : (
        <div className="dict-proc">
          <Waveform level={level} smooth={smooth} mode="processing" still={still} />
        </div>
      )}
    </BarFrame>
  )
}

export function DictationBarPreview(): JSX.Element {
  return (
    <main className="dbp">
      <h1>Dictation bar preview</h1>
      <p>Simulated levels; nothing is recorded. Turn on reduced motion in the OS to check the real setting too.</p>
      <section>
        <Cell title="Resting">
          <Capsule />
        </Cell>
        <Cell title="Recording" note="quiet">
          <Recording loudness="quiet" still={false} />
        </Cell>
        <Cell title="Recording" note="normal">
          <Recording loudness="normal" still={false} />
        </Cell>
        <Cell title="Recording" note="loud">
          <Recording loudness="loud" still={false} />
        </Cell>
        <Cell title="Processing" note="replays every 4 s">
          <Processing still={false} />
        </Cell>
        <Cell title="Round trip" note="rest, record, process, rest">
          <Cycle still={false} />
        </Cell>
      </section>
      <h2>Reduced motion</h2>
      <section>
        <Cell title="Recording" note="normal, 8 Hz steps">
          <Recording loudness="normal" still />
        </Cell>
        <Cell title="Processing">
          <Processing still />
        </Cell>
        <Cell title="Round trip" note="cross-fades">
          <Cycle still />
        </Cell>
      </section>
    </main>
  )
}
