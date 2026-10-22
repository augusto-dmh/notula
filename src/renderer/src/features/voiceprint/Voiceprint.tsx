// SPDX-License-Identifier: Apache-2.0
// The voiceprint: the Labs row (status, Record my
// voice, the passive switch, Forget my voice; turning off asks to forget, "forget" by default), the
// note's quiet "Identified you" line and the transcript menu's "This was an in-person meeting".
//
// The sample is captured here: the selected input device through the capture worklet in a
// 16 kHz AudioContext, sent to main in 100 ms chunks on `voiceprint:sample-audio`, held in
// memory there only.

import { useEffect, useRef, useState, type JSX } from 'react'
import type { VoiceprintSampleResult, VoiceprintStatus } from '@shared/types/voiceprint'
import { VOICEPRINT_LIMITS } from '@shared/types/voiceprint'
import type { TranscriptChunk } from '@shared/types/transcript'
import { showToast } from '../../app/toast'
import workletUrl from '../capture/worklet.ts?worker&url'
import { Modal } from '../folders/Modal'
import { Switch } from '../settings/controls'
import { setPrefs, usePrefs } from '../settings/prefs-store'
import './voiceprint.css'

const PASSAGE =
  'When the meeting starts, I like to settle in, check the agenda and listen first. ' +
  'Good notes keep the decisions, the open questions and who said they would do what. ' +
  'Later I read them back, fix a name or two, and send the summary to everyone who was there. ' +
  'If something was unclear, I write it down as a question for next time.'

let status: VoiceprintStatus | null = null
const listeners = new Set<() => void>()
let subscribed = false

function setStatus(s: VoiceprintStatus): void {
  status = s
  for (const l of listeners) l()
}

function useVoiceprint(): VoiceprintStatus | null {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!subscribed) {
      subscribed = true
      window.notula.voiceprint.onStatusChanged(setStatus)
    }
    const l = (): void => tick((n) => n + 1)
    listeners.add(l)
    void window.notula.voiceprint.getStatus().then(setStatus).catch(() => undefined)
    return () => {
      listeners.delete(l)
    }
  }, [])
  return status
}

function minutes(ms: number): string {
  const m = ms / 60_000
  return m < 1 ? 'less than a minute' : `${Math.round(m)} ${Math.round(m) === 1 ? 'minute' : 'minutes'}`
}

function errorText(err: unknown, fallback: string): string {
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

function RecordDialog({ onClose }: { onClose(): void }): JSX.Element {
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
            <p className="vp-record__ok">Got it. Notula will label you as Me in in-person transcripts on this computer.</p>
          ) : result.reason === 'model-missing' ? (
            <p className="vp-record__bad">The speaker model isn't installed yet. Download it, then try again.</p>
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

function TurnOffDialog({ onClose }: { onClose(): void }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const off = (forget: boolean): void => {
    setBusy(true)
    const run = forget ? window.notula.voiceprint.forget().then(() => undefined) : Promise.resolve()
    run
      .then(() => setPrefs({ 'voiceprint.enabled': false }))
      .catch((err: unknown) => showToast({ title: errorText(err, "Couldn't forget your voice."), kind: 'error' }))
      .finally(() => {
        setBusy(false)
        onClose()
      })
  }
  return (
    <Modal label="Turn off Recognize my voice" onClose={onClose}>
      <div className="h-modal__body vp-record">
        <h2 className="h-modal__title">Also forget your voice?</h2>
        <p className="h-modal__subtitle">Notula can delete your voiceprint from this computer now, or keep it for when you turn this back on.</p>
        <footer className="vp-record__actions">
          <button type="button" className="n-btn n-btn--ghost" disabled={busy} onClick={() => off(false)}>
            Keep it
          </button>
          <button type="button" className="n-btn n-btn--danger" data-autofocus disabled={busy} onClick={() => off(true)}>
            Forget my voice
          </button>
        </footer>
      </div>
    </Modal>
  )
}

export function VoiceprintLabsRow(): JSX.Element {
  const prefs = usePrefs()
  const s = useVoiceprint()
  const [dialog, setDialog] = useState<'record' | 'off' | null>(null)
  const [downloading, setDownloading] = useState(false)
  const on = prefs?.['voiceprint.enabled'] === true
  const download = (): void => {
    setDownloading(true)
    window.notula.asr
      .downloadLocalModel({ modelId: 'diarization-en' })
      .then(() => window.notula.voiceprint.getStatus().then(setStatus))
      .catch((err: unknown) => showToast({ title: errorText(err, "Couldn't download the speaker model."), kind: 'error' }))
      .finally(() => setDownloading(false))
  }
  const forget = (): void => {
    void window.notula.voiceprint
      .forget()
      .then(() => showToast({ title: 'Your voice is forgotten' }))
      .catch((err: unknown) => showToast({ title: errorText(err, "Couldn't forget your voice."), kind: 'error' }))
  }
  const profile = s?.profile
  return (
    <>
      <div className="settings-row">
        <div className="settings-row__text">
          <div className="settings-row__label">Recognize my voice</div>
          <div className="settings-row__hint">Learn your voice on this computer so in-person transcripts label you as Me.</div>
        </div>
        <div className="settings-row__control">
          <Switch
            label="Recognize my voice"
            checked={on}
            disabled={!prefs}
            onChange={(next) => (next ? setPrefs({ 'voiceprint.enabled': true }) : profile?.present ? setDialog('off') : setPrefs({ 'voiceprint.enabled': false }))}
          />
        </div>
      </div>
      {on && s ? (
        <div className="vp-panel">
          <p className="vp-panel__status">
            {profile?.present
              ? `Voiceprint from ${minutes(profile.totalSpeechMs)} of speech${profile.updatedAt ? `, updated ${new Date(profile.updatedAt).toLocaleDateString()}` : ''}.`
              : 'No voiceprint yet.'}
          </p>
          {!s.modelReady ? (
            <p className="vp-panel__model">
              Needs the speaker model.{' '}
              <button type="button" className="vp-link" disabled={downloading} onClick={download}>
                {downloading ? 'Downloading…' : 'Download'}
              </button>
            </p>
          ) : null}
          <div className="vp-panel__actions">
            <button type="button" className="n-btn n-btn--sm" disabled={!s.modelReady} onClick={() => setDialog('record')}>
              Record my voice
            </button>
            {profile?.present ? (
              <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={forget}>
                Forget my voice
              </button>
            ) : null}
          </div>
          <div className="vp-panel__passive">
            <div>
              <div className="settings-row__label">Keep improving from my online meetings</div>
              <div className="settings-row__hint">After an online call, learn a little more from your microphone. Never from in-person meetings.</div>
            </div>
            <Switch
              label="Keep improving from my online meetings"
              checked={s.passiveEnrolment}
              onChange={(next) =>
                void window.notula.voiceprint
                  .setPassive({ enabled: next })
                  .then(setStatus)
                  .catch((err: unknown) => showToast({ title: errorText(err, 'Not changed.'), kind: 'error' }))
              }
            />
          </div>
        </div>
      ) : null}
      {dialog === 'record' ? <RecordDialog onClose={() => setDialog(null)} /> : null}
      {dialog === 'off' ? <TurnOffDialog onClose={() => setDialog(null)} /> : null}
    </>
  )
}

// ---------- on the note ----------

function useIdentified(noteId: string): boolean {
  const [yes, setYes] = useState(false)
  useEffect(() => {
    let alive = true
    const check = (chunks: TranscriptChunk[]): boolean =>
      chunks.some((c) => c.source === 'microphone' && c.detected_speaker_name === 'Me' && c.detectedSpeaker?.source === 'diarization')
    void window.notula.transcript
      .get({ noteId })
      .then((chunks) => alive && setYes(check(chunks)))
      .catch(() => undefined)
    const off = window.notula.transcript.onChanged((e) => {
      if (e.noteId === noteId && check(e.upserted)) setYes(true)
    })
    return () => {
      alive = false
      off()
    }
  }, [noteId])
  return yes
}

export function VoiceprintNoteLine({ noteId }: { noteId: string }): JSX.Element | null {
  const identified = useIdentified(noteId)
  if (!identified) return null
  return <p className="vp-note-line">Identified you in this transcript</p>
}

const SKIP_TEXT: Record<string, string> = {
  'no-profile': 'Record your voice in Settings ▸ Labs first.',
  'no-audio': "This meeting's audio is no longer on this computer.",
  'too-little-speech': 'There was too little speech to tell voices apart.',
  'single-speaker': 'Only one voice was heard.',
  'no-match': "Notula couldn't recognize your voice in this meeting."
}

export function InPersonMenuItem({ noteId }: { noteId: string }): JSX.Element | null {
  const prefs = usePrefs()
  const s = useVoiceprint()
  const [busy, setBusy] = useState(false)
  if (prefs?.['voiceprint.enabled'] !== true || !s?.profile.present) return null
  const run = (): void => {
    setBusy(true)
    window.notula.voiceprint
      .identifyNote({ noteId })
      .then((r) => {
        if (r.action === 'relabelled' && r.selfMatched) showToast({ title: 'Identified you in this transcript', kind: 'success' })
        else if (r.action === 'relabelled') showToast({ title: 'Speakers labelled', description: SKIP_TEXT['no-match'] })
        else showToast({ title: 'Speakers not labelled', description: SKIP_TEXT[r.reason ?? ''] ?? undefined })
      })
      .catch((err: unknown) => showToast({ title: errorText(err, "Couldn't label the speakers."), kind: 'error' }))
      .finally(() => setBusy(false))
  }
  return (
    <button type="button" className="vp-menu-item" disabled={busy} onClick={run}>
      {busy ? 'Labelling speakers…' : 'This was an in-person meeting'}
    </button>
  )
}
