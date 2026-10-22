// SPDX-License-Identifier: Apache-2.0
// The meeting control bar:
// Resume / Start now / Retry / Cancel / Stop transcript, the waveform toggle for the
// transcript panel, the first-run popover and the input picker.
//
// The status names what is wrong: which audio source failed, a transcription
// that cannot connect, or a reconnect in progress. Retry restarts only what failed:
// system audio alone, or (in main) just the transcription sockets when both sources
// still capture.
//
// A system-only note (a source note) has no microphone: no microphone status, notice or picker.

import { useEffect, useRef, useState, type JSX } from 'react'
import type { AudioSource } from '@shared/types/common'
import { DELETED_CHUNK_MARKER } from '@shared/types/transcript'
import { navigate } from '../../app/navigation'
import { dismissToast, showToast } from '../../app/toast'
import { isSystemOnly, MIC_SILENT_TITLE, micSilentReason } from './AudioHealthBanner'
import type { MeetingControlsProps } from './index'
import { InputPicker } from './InputPicker'
import { useLiveSignals } from './live'
import { cancelPendingStart, startTranscription, stopTranscription, useCaptureSnapshot, type CaptureSnapshot } from './store'
import './capture.css'

const POPOVER_MS = 8_000
/** Audio flows but transcription has not connected for this long: say so. */
const SLOW_CONNECT_MS = 15_000

interface StatusText {
  label: string
  /** The longer reason: tooltip and screen-reader text. */
  detail?: string
}

/** Transcription sources that were active at some point since this note started transcribing. */
function useSeenActive(s: CaptureSnapshot, noteId: string): ReadonlySet<AudioSource> {
  const seen = useRef<{ note: string | null; sources: Set<AudioSource> }>({ note: null, sources: new Set() })
  const current = s.transcribingNoteId === noteId && s.system.noteId === noteId ? noteId : null
  if (seen.current.note !== current) seen.current = { note: current, sources: new Set() }
  if (current) {
    if (s.system.microphoneTranscription === 'active') seen.current.sources.add('microphone')
    if (s.system.systemTranscription === 'active') seen.current.sources.add('system')
  }
  return seen.current.sources
}

/** The status line for the combined state, with its cause. */
function statusText(s: CaptureSnapshot, seen: ReadonlySet<AudioSource>, slow: boolean): StatusText {
  const st = s.system
  if (s.ui === 'error') {
    const mic = st.microphoneCapture === 'error'
    const sys = st.systemCapture === 'error'
    if (sys && isSystemOnly(s)) {
      return { label: 'System audio unavailable', detail: 'Audio playing on this computer isn’t being transcribed.' }
    }
    if (mic && sys) return { label: 'Audio unavailable', detail: 'Notula can’t capture your microphone or this computer’s audio.' }
    if (sys) {
      return {
        label: 'System audio unavailable',
        detail: 'Your microphone is still being transcribed, but voices playing on this computer are not.'
      }
    }
    if (mic) {
      return {
        label: 'Microphone unavailable',
        detail: 'Voices playing on this computer are still being transcribed, but your microphone is not.'
      }
    }
    if (st.microphoneTranscription === 'error' || st.systemTranscription === 'error') {
      return { label: 'Transcription unavailable', detail: 'Check your transcription provider and key in Settings.' }
    }
    return { label: 'Transcript error', detail: 'Transcription didn’t start.' }
  }
  if (s.ui === 'starting') {
    const reconnecting =
      (st.microphoneTranscription === 'starting' && seen.has('microphone')) ||
      (st.systemTranscription === 'starting' && seen.has('system'))
    if (reconnecting) {
      return {
        label: 'Reconnecting…',
        detail: 'Audio is kept for up to two minutes and transcribed once the connection is back.'
      }
    }
    // The sockets keep retrying with no error state; after a while the
    // wait itself is the news.
    const audioUp = st.microphoneCapture !== 'starting' && st.systemCapture !== 'starting'
    if (slow && audioUp) {
      return {
        label: 'Connecting…',
        detail: 'Notula can’t reach the transcription service yet and keeps trying. Audio is kept for up to two minutes.'
      }
    }
    return { label: 'Starting…' }
  }
  return { label: 'Transcribing' }
}

/** Whether the note already has a transcript or a summary (Resume vs Start now). */
function useHasContent(noteId: string): boolean {
  const [has, setHas] = useState(false)
  useEffect(() => {
    let alive = true
    setHas(false)
    const check = async (): Promise<void> => {
      const [chunks, panels] = await Promise.all([
        window.notula.transcript.get({ noteId }).catch(() => []),
        window.notula.panels.list({ noteId }).catch(() => [])
      ])
      if (!alive) return
      setHas(chunks.some((c) => c.text.trim() && c.text !== DELETED_CHUNK_MARKER) || panels.length > 0)
    }
    void check()
    const offTranscript = window.notula.transcript.onChanged((p) => {
      if (p.noteId === noteId && p.upserted.some((c) => c.text.trim())) setHas(true)
    })
    const offNotes = window.notula.notes.onChanged((c) => {
      if (c.tables.includes('note_panels')) void check()
    })
    return () => {
      alive = false
      offTranscript()
      offNotes()
    }
  }, [noteId])
  return has
}

/**
 * The silent-microphone notice also reaches a note whose transcript panel (and its
 * banner) is closed, as one toast when it appears; it goes when the notice clears.
 */
function useMicSilentToast(noteId: string, systemOnly: boolean): void {
  const health = useLiveSignals().health
  const silent = health.noteId === noteId && health.micSilent && !systemOnly
  const device = health.micSilentDevice
  const whileSystemSound = health.micSilentWhileSystemSound
  useEffect(() => {
    if (!silent) {
      dismissToast('mic-silent')
      return
    }
    showToast({
      id: 'mic-silent',
      kind: 'info',
      title: MIC_SILENT_TITLE,
      description: micSilentReason(device, whileSystemSound),
      action: { label: 'Sound settings', onClick: () => window.notula.system.openAudioSettings() },
      durationMs: 15_000
    })
  }, [silent, device, whileSystemSound])
}

export function MeetingControls({ noteId, transcriptOpen, onToggleTranscript }: MeetingControlsProps): JSX.Element {
  const s = useCaptureSnapshot()
  const isThis = s.transcribingNoteId === noteId
  useMicSilentToast(noteId, isThis && isSystemOnly(s))
  const hasContent = useHasContent(noteId)
  const [popover, setPopover] = useState(false)
  const otherBusy = s.transcribingNoteId !== null && !isThis
  const seenActive = useSeenActive(s, noteId)
  const [slow, setSlow] = useState(false)
  const starting = isThis && s.ui === 'starting'
  useEffect(() => {
    setSlow(false)
    if (!starting) return
    const t = window.setTimeout(() => setSlow(true), SLOW_CONNECT_MS)
    return () => clearTimeout(t)
  }, [starting])

  useEffect(() => {
    if (!popover) return
    const t = window.setTimeout(() => setPopover(false), POPOVER_MS)
    return () => clearTimeout(t)
  }, [popover])

  useEffect(() => {
    if (transcriptOpen || !isThis) setPopover(false)
  }, [transcriptOpen, isThis])

  const start = async (): Promise<void> => {
    const firstTime = !hasContent
    const r = await startTranscription(noteId)
    if (r.ok) {
      if (firstTime && !transcriptOpen) setPopover(true)
      return
    }
    if (r.reason === 'no-asr') {
      showToast({
        id: 'transcription-setup',
        kind: 'error',
        title: 'Set up transcription',
        description: 'Add a Deepgram or AssemblyAI key in Settings to transcribe.',
        action: { label: 'Open Settings', onClick: () => navigate('/settings') }
      })
    } else if (r.reason === 'busy') {
      showToast({ kind: 'error', title: "Can't start transcription", description: 'Another note is transcribing.' })
    } else {
      showToast({ kind: 'error', title: "Can't start transcription", description: 'This note no longer exists.' })
    }
  }

  const retry = async (): Promise<void> => {
    // Only system audio failed: reacquire it alone.
    const systemOnly = s.system.systemCapture === 'error' && s.system.microphoneCapture === 'active'
    const r = await window.notula.capture.restart({ scope: systemOnly ? 'system' : 'all' })
    if (r.ok) return
    if (r.reason === 'not-capturing') {
      stopTranscription('toggle_off')
      await start()
      return
    }
    showToast({ kind: 'error', title: "Couldn't restart transcription", description: 'Stop and resume the transcript.' })
  }

  let main: JSX.Element
  if (s.pendingStart && !isThis) {
    main = (
      <button type="button" className="nt-cap-btn" onClick={cancelPendingStart}>
        Cancel
      </button>
    )
  } else if (isThis) {
    const status = statusText(s, seenActive, slow)
    main = (
      <>
        <span className={`nt-cap-status nt-cap-status-${s.ui}`} role="status" title={status.detail}>
          <span className="nt-cap-dot" aria-hidden="true" />
          {status.label}
          {status.detail ? <span className="visually-hidden">. {status.detail}</span> : null}
        </span>
        {s.ui === 'error' && (
          <button type="button" className="nt-cap-btn" onClick={() => void retry()}>
            Retry
          </button>
        )}
        <button
          type="button"
          className="nt-cap-btn nt-cap-btn-stop"
          title="Stop transcript"
          onClick={() => stopTranscription('note_stop_button')}
        >
          Stop transcript
        </button>
        {/* A system-only note opens no microphone, so there is none to pick. */}
        {!isSystemOnly(s) && <InputPicker />}
      </>
    )
  } else {
    main = (
      <button
        type="button"
        className="nt-cap-btn nt-cap-btn-primary"
        disabled={otherBusy}
        title={otherBusy ? 'Another note is transcribing' : undefined}
        onClick={() => void start()}
      >
        {hasContent ? 'Resume' : 'Start now'}
      </button>
    )
  }

  return (
    <div className="nt-cap-bar">
      <div className="nt-cap-toggle-wrap">
        <button
          type="button"
          className={`nt-cap-wave${transcriptOpen ? ' nt-cap-wave-on' : ''}`}
          aria-pressed={transcriptOpen}
          aria-label={transcriptOpen ? 'Hide transcript' : 'Show transcript'}
          title={transcriptOpen ? 'Hide transcript' : 'Show transcript'}
          onClick={() => {
            setPopover(false)
            onToggleTranscript()
          }}
        >
          <Waveform active={isThis && s.ui === 'active'} />
        </button>
        {popover && (
          <div className="nt-cap-popover" role="dialog" aria-label="Notula is transcribing">
            <strong>Notula is transcribing</strong>
            <span>Open the live transcript here at any time.</span>
          </div>
        )}
      </div>
      {main}
    </div>
  )
}

function Waveform({ active }: { active: boolean }): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className={active ? 'nt-cap-wave-anim' : undefined}>
      {[3, 7, 11, 15].map((x, i) => (
        <rect key={x} x={x - 1} y={[6, 3, 5, 7][i]} width="2" height={[6, 12, 8, 4][i]} rx="1" fill="currentColor" />
      ))}
    </svg>
  )
}
