// SPDX-License-Identifier: Apache-2.0
// A source note's transcript plan in the transcript panel (content sources): what the
// transcript comes from, the switches between video captions and this computer's audio, and,
// when both exist, which one the panel shows. Also the source note's turns: video-time lines,
// with no speaker labels.
//
// Nothing here runs unless Sources is on and the note has a source. Every sources channel may
// answer "No handler registered" while main has no handler for it; that reads as no source.

import { useCallback, useEffect, useState, type JSX } from 'react'
import { formatPosition } from '@shared/lib/position'
import { chunkPositionMs, pickCaptionTrack, type SourceTranscriptView } from '@shared/lib/source-transcript'
import type { NoteSourceView } from '@shared/types/sources'
import type { TranscriptChunk } from '@shared/types/transcript'
import { navigate } from '../../app/navigation'
import { showToast } from '../../app/toast'
import { startTranscription, stopTranscription, useCaptureSnapshot } from '../capture/store'
import { usePrefs } from '../settings/prefs-store'
import type { Turn } from './turns'
import './source-plan.css'

/** A turn spans about this much video before the next one starts. */
const TURN_MS = 15_000
/** A plan still `pending` this long after the link was never asked for (a link by hand). */
const PENDING_FRESH_MS = 10_000

/** The note's source while Sources is on, kept current by `sources:changed` and caption progress. */
export function useNoteSource(noteId: string): NoteSourceView | null {
  const enabled = usePrefs()?.['sources.enabled'] === true
  const [view, setView] = useState<NoteSourceView | null>(null)
  useEffect(() => {
    setView(null)
    if (!enabled) return
    let alive = true
    const load = (): void => {
      void window.notula.sources
        .getForNote({ noteId })
        .then((v) => alive && setView(v))
        .catch(() => alive && setView(null))
    }
    load()
    const offChanged = window.notula.sources.onChanged((p) => {
      if (p.noteIds.includes(noteId)) load()
    })
    const offProgress = window.notula.sources.onCaptionsProgress((p) => {
      if (p.noteId === noteId) load()
    })
    return () => {
      alive = false
      offChanged()
      offProgress()
    }
  }, [noteId, enabled])
  return view
}

/** Video-time turns: a new one about every 15 s of video; a chunk with no position joins the one before. */
export function mediaTurns(chunks: TranscriptChunk[]): (Turn & { positionMs: number | null })[] {
  const out: (Turn & { positionMs: number | null })[] = []
  let cur: (Turn & { positionMs: number | null }) | null = null
  for (const c of chunks) {
    const text = c.text.trim()
    if (!text) continue
    const pos = chunkPositionMs(c)
    const start = Date.parse(c.start_timestamp)
    const end = Date.parse(c.end_timestamp)
    const fresh = !cur || (pos !== null && (cur.positionMs === null || pos - cur.positionMs >= TURN_MS || pos < cur.positionMs))
    if (fresh || !cur) {
      cur = { id: c.id, source: c.source, label: '', chunkIds: [c.id], text, startMs: start, endMs: end, positionMs: pos }
      out.push(cur)
      continue
    }
    cur.chunkIds.push(c.id)
    cur.text = `${cur.text} ${text}`
    cur.endMs = Math.max(cur.endMs, end)
  }
  return out
}

export function positionLabel(ms: number | null): string | null {
  return ms === null ? null : formatPosition(ms)
}

function failed(title: string, description: string): void {
  showToast({ id: 'source-plan-failed', kind: 'error', title, description })
}

interface Props {
  noteId: string
  view: NoteSourceView
  views: SourceTranscriptView[]
  shown: SourceTranscriptView
  onShow(v: SourceTranscriptView): void
}

export function SourcePlanBar({ noteId, view, views, shown, onShow }: Props): JSX.Element {
  const cap = useCaptureSnapshot()
  const [busy, setBusy] = useState(false)
  const s = view.source
  const capturing = cap.transcribingNoteId === noteId
  const otherBusy = (cap.transcribingNoteId !== null && !capturing) || cap.pendingStart
  const hasTrack = !!pickCaptionTrack(s.enrichment, { live: s.live })
  const hasCaptions = views.includes('captions')
  const fetchingCaptions = s.transcript_plan === 'captions' && (s.track_state === 'queued' || s.track_state === 'fetching')
  const captionsFailed = s.transcript_plan === 'captions' && !hasCaptions && (s.track_state === 'failed' || s.track_state === 'unavailable')
  // Being decided right after Take notes; a source linked by hand has no automatic plan.
  const deciding = s.transcript_plan === 'pending' && Date.now() - Date.parse(s.created_at) < PENDING_FRESH_MS

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }, [])

  // Transcribe audio: system audio only. With captions, a second session prompts don't use.
  const transcribeAudio = (): Promise<void> =>
    run(async () => {
      if (s.transcript_plan !== 'captions' || !hasCaptions) {
        try {
          await window.notula.sources.setTranscriptPlan({ noteId, plan: 'system-audio' })
        } catch {
          // The capture start below records the plan too.
        }
      }
      const r = await startTranscription(noteId)
      if (r.ok) return
      if (r.reason === 'no-asr') {
        showToast({
          id: 'source-plan-failed',
          kind: 'error',
          title: 'Set up transcription',
          description: 'Add a transcription provider in Settings to transcribe this computer’s audio.',
          action: { label: 'Open Settings', onClick: () => navigate('/settings') }
        })
      } else if (r.reason === 'busy') failed('Can’t transcribe audio', 'Another note is transcribing.')
      else failed('Can’t transcribe audio', 'This note no longer exists.')
    })

  const useCaptions = (): Promise<void> =>
    run(async () => {
      try {
        await window.notula.sources.setTranscriptPlan({ noteId, plan: 'captions' })
        // The audio transcript is hidden now: stop adding to it.
        if (capturing) stopTranscription('toggle_off')
        onShow('captions')
      } catch {
        failed('Couldn’t use the video’s captions', 'This video has no captions in its own language, or they can’t be fetched now.')
      }
    })

  const retry = (): Promise<void> =>
    run(async () => {
      try {
        await window.notula.sources.fetchCaptions({ noteId })
      } catch {
        failed('Couldn’t fetch the video’s captions', 'Try again in a moment.')
      }
    })

  let line: string
  if (deciding) line = 'Choosing where the transcript comes from…'
  else if (fetchingCaptions) line = 'Getting the video’s captions…'
  else if (captionsFailed) line = s.track_state === 'unavailable' ? 'This video has no captions to use.' : 'Couldn’t get the video’s captions.'
  else if (hasCaptions && shown === 'captions') line = `From the video’s captions${s.track_language ? ` (${s.track_language})` : ''}.`
  else if (capturing) line = 'Transcribing this computer’s audio. Your microphone isn’t recorded.'
  else if (views.includes('audio')) line = 'From this computer’s audio.'
  else line = 'No transcript yet. Your notes and their video times are kept.'

  const showTranscribe = !capturing && !fetchingCaptions && !deciding
  const showUseCaptions = !hasCaptions && hasTrack && !fetchingCaptions && !deciding && s.transcript_plan !== 'captions'

  return (
    <div className="nt-srcplan" role="status">
      <span className="nt-srcplan-line">{line}</span>
      <span className="nt-srcplan-actions">
        {views.length > 1 && (
          <span className="nt-srcplan-switch" role="group" aria-label="Transcript shown">
            {views.map((v) => (
              <button key={v} type="button" className="nt-srcplan-tab" aria-pressed={shown === v} onClick={() => onShow(v)}>
                {v === 'captions' ? 'Captions' : 'Audio'}
              </button>
            ))}
          </span>
        )}
        {captionsFailed && s.track_state === 'failed' && (
          <button type="button" className="nt-tr-link" disabled={busy} onClick={() => void retry()}>
            Try again
          </button>
        )}
        {showUseCaptions && (
          <button type="button" className="nt-tr-link" disabled={busy} onClick={() => void useCaptions()}>
            Use the video’s captions
          </button>
        )}
        {showTranscribe && (
          <button
            type="button"
            className="nt-tr-link"
            disabled={busy || otherBusy}
            title={otherBusy ? 'Another note is transcribing' : 'Transcribes this computer’s audio, without your microphone'}
            onClick={() => void transcribeAudio()}
          >
            {captionsFailed ? 'Transcribe audio now' : 'Transcribe audio'}
          </button>
        )}
      </span>
    </div>
  )
}
