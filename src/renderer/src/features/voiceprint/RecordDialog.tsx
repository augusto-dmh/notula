// SPDX-License-Identifier: Apache-2.0
// Record my voice: the guided 30 s sample. A sample that passes adds a
// self exemplar and turns Recognize my voice on.
//
// The sample is captured here: the selected input device through the capture worklet in a
// 16 kHz AudioContext, sent to main in 100 ms chunks on `voiceprint:sample-audio`, held in
// memory there only.

import { useEffect, useRef, useState, type JSX } from 'react'
import type { VoiceprintSampleResult } from '@shared/types/voiceprint'
import { VOICEPRINT_LIMITS } from '@shared/types/voiceprint'
import workletUrl from '../capture/worklet.ts?worker&url'
import { Modal } from '../folders/Modal'
import './voiceprint.css'

const PASSAGE =
  'When the meeting starts, I like to settle in, check the agenda and listen first. ' +
  'Good notes keep the decisions, the open questions and who said they would do what. ' +
  'Later I read them back, fix a name or two, and send the summary to everyone who was there. ' +
  'If something was unclear, I write it down as a question for next time.'

export function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message.replace(/^.*?(?:[a-z-]+): /, '') || fallback : fallback
}

// ---------- the guided sample ----------

async function openMic(onChunk: (pcm: Uint8Array) => void): Promise<() => void> {
  const input = await window.notula.input.getState().catch(() => null)
  const deviceId = input?.preference.mode === 'physical-device' ? input.preference.deviceId : null
  const ctx = new AudioContext({ sampleRate: 16_000, latencyHint: 'interactive', sinkId: { type: 'none' } } as AudioContextOptions)
  await ctx.audioWorklet.addModule(workletUrl)
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false },
    video: false
  })
  const source = ctx.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(ctx, 'notula-capture', { numberOfInputs: 1, numberOfOutputs: 1 })
  node.port.onmessage = (e: MessageEvent<{ samples: Float32Array }>) => {
    const s = e.data.samples
    const out = new Int16Array(s.length)
    for (let i = 0; i < s.length; i++) {
      const v = Math.max(-1, Math.min(1, s[i] as number))
      out[i] = v < 0 ? v * 0x8000 : v * 0x7fff
    }
    onChunk(new Uint8Array(out.buffer))
  }
  source.connect(node)
  const sink = ctx.createGain()
  sink.gain.value = 0
  node.connect(sink)
  sink.connect(ctx.destination)
  if (ctx.state === 'suspended') await ctx.resume()
  return () => {
    node.port.onmessage = null
    stream.getTracks().forEach((t) => t.stop())
    void ctx.close().catch(() => undefined)
  }
}

export function RecordDialog({ onClose }: { onClose(): void }): JSX.Element {
  const [phase, setPhase] = useState<'ready' | 'recording' | 'checking' | 'done'>('ready')
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const [result, setResult] = useState<VoiceprintSampleResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const stopMic = useRef<(() => void) | null>(null)
  const session = useRef<string | null>(null)

  useEffect(() => {
    const off = window.notula.voiceprint.onSampleProgress((p) => {
      if (p.sessionId !== session.current) return
      setElapsed(p.elapsedMs)
      setLevel(p.level)
      if (p.elapsedMs >= VOICEPRINT_LIMITS.sampleMs) setPhase('checking')
    })
    return () => {
      off()
      stopMic.current?.()
      if (session.current) window.notula.voiceprint.cancelSample({ sessionId: session.current })
    }
  }, [])

  const start = (): void => {
    const sessionId = crypto.randomUUID()
    session.current = sessionId
    setError(null)
    setResult(null)
    setElapsed(0)
    setPhase('recording')
    const pending = window.notula.voiceprint.recordSample({ sessionId, durationMs: VOICEPRINT_LIMITS.sampleMs })
    openMic((pcm) => window.notula.voiceprint.sendSampleAudio({ sessionId, pcm }))
      .then((stop) => {
        stopMic.current = stop
      })
      .catch(() => {
        window.notula.voiceprint.cancelSample({ sessionId })
        setError("Notula couldn't use your microphone. Check it in Settings ▸ Preferences.")
        setPhase('ready')
      })
    pending
      .then((r) => {
        stopMic.current?.()
        stopMic.current = null
        if (session.current !== sessionId || r.reason === 'cancelled') return
        session.current = null
        setResult(r)
        setPhase('done')
      })
      .catch((err: unknown) => {
        stopMic.current?.()
        stopMic.current = null
        setError(errorText(err, 'Recording failed.'))
        setPhase('ready')
      })
  }

  const cancel = (): void => {
    if (session.current) window.notula.voiceprint.cancelSample({ sessionId: session.current })
    session.current = null
    stopMic.current?.()
    stopMic.current = null
    onClose()
  }

  const pct = Math.min(100, (elapsed / VOICEPRINT_LIMITS.sampleMs) * 100)
  return (
    <Modal label="Record my voice" onClose={cancel}>
      <div className="h-modal__body vp-record">
        <h2 className="h-modal__title">Record my voice</h2>
        {phase === 'done' && result ? (
          result.enrolled ? (
            <p className="vp-record__ok">Got it. Notula will recognize you as Me in your meetings on this computer.</p>
          ) : result.reason === 'model-missing' ? (
            <p className="vp-record__bad">The speaker models aren't installed yet. Download them, then try again.</p>
          ) : (
            <p className="vp-record__bad">Not enough clear speech — try again somewhere quieter.</p>
          )
        ) : (
          <>
            <p className="h-modal__subtitle">Read this aloud in your normal voice. It takes 30 seconds, and the audio is never saved.</p>
            <blockquote className="vp-record__passage">{PASSAGE}</blockquote>
            <div className="vp-record__meter" aria-hidden={phase !== 'recording'}>
              <div className="vp-record__bar" style={{ width: `${pct}%` }} />
              <div className="vp-record__level" style={{ transform: `scaleX(${phase === 'recording' ? level : 0})` }} />
            </div>
            <p className="vp-record__state" role="status">
              {phase === 'recording' ? `Listening… ${Math.ceil((VOICEPRINT_LIMITS.sampleMs - elapsed) / 1000)} s left` : phase === 'checking' ? 'Learning your voice…' : ' '}
            </p>
          </>
        )}
        {error ? (
          <p className="vp-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="vp-record__actions">
          {phase === 'done' ? (
            <>
              {!result?.enrolled ? (
                <button type="button" className="n-btn n-btn--ghost" onClick={start}>
                  Try again
                </button>
              ) : null}
              <button type="button" className="n-btn n-btn--primary" data-autofocus onClick={onClose}>
                Done
              </button>
            </>
          ) : (
            <>
              <button type="button" className="n-btn n-btn--ghost" onClick={cancel}>
                Cancel
              </button>
              <button type="button" className="n-btn n-btn--primary" data-autofocus disabled={phase !== 'ready'} onClick={start}>
                {phase === 'ready' ? 'Start' : phase === 'checking' ? 'Checking…' : 'Recording…'}
              </button>
            </>
          )}
        </footer>
      </div>
    </Modal>
  )
}
