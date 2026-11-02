// SPDX-License-Identifier: Apache-2.0
// A source note's transcript plan in the transcript panel (content sources): what the
// transcript comes from, the switches between video captions and this computer's audio, and,
// when both exist, which one the panel shows. Also the source note's turns: video-time lines,
// with no speaker labels.
//
// Above the line, at most one banner (outside Courses):
// - the first-use question left unanswered on the card: "Use this video's captions as the
//   transcript?" Allow / Not now, once, on the first YouTube note made while it was unanswered.
//   Allow turns lookups on (main looks this note up at once) and uses the captions once listed;
// - lookups off: "Captions are off: Notula doesn't ask YouTube." Allow lookups;
// - no captions with `sources.noCaptions` at `ask`: "This video has no captions." Transcribe its
//   audio / Not now (per note).
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
import { useCourses } from '../sources/courses/courses-store'
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

/** The note the unanswered first-use question returns in (once). */
const FIRST_USE_NOTE_KEY = 'notula.sources.firstUseNote'
const NO_CAPTIONS_DISMISSED_KEY = 'notula.sources.noCaptionsDismissed'

function readStore(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStore(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Storage full or off: the banner may show again.
  }
}

/** True for one note only: the first that asks keeps the question. */
function firstUseNoteIs(noteId: string): boolean {
  const kept = readStore(FIRST_USE_NOTE_KEY)
  if (kept) return kept === noteId
  writeStore(FIRST_USE_NOTE_KEY, noteId)
  return true
}

function noCaptionsDismissed(noteId: string): boolean {
  return (readStore(NO_CAPTIONS_DISMISSED_KEY) ?? '').split(',').includes(noteId)
}

function dismissNoCaptions(noteId: string): void {
  const ids = (readStore(NO_CAPTIONS_DISMISSED_KEY) ?? '').split(',').filter(Boolean)
  writeStore(NO_CAPTIONS_DISMISSED_KEY, [...ids, noteId].slice(-50).join(','))
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
  const prefs = usePrefs()
  const courses = useCourses()
  const [busy, setBusy] = useState(false)
  const [dismissed, setDismissed] = useState(() => noCaptionsDismissed(noteId))
  /** The banner's Allow: use the captions as soon as the lookup lists a track. */
  const [wantCaptions, setWantCaptions] = useState(false)
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

  // Banners: never on a course's note (courses always transcribe), never while capturing.
  const inCourses = !!view.series && (courses ?? []).some((c) => c.id === view.series?.id)
  const youtube = s.provider === 'youtube'
  const settled = s.enrichment?.state === 'done' || s.enrichment?.state === 'failed' || s.track_state === 'unavailable'
  let banner: 'first-use' | 'lookups-off' | 'no-captions' | null = null
  if (prefs && !inCourses && !capturing && !hasCaptions && !deciding) {
    if (youtube && !prefs['sources.grantAsked'] && firstUseNoteIs(noteId)) banner = 'first-use'
    else if (youtube && prefs['sources.grantAsked'] && !prefs['sources.onlineLookups']) banner = 'lookups-off'
    else if (
      prefs['sources.noCaptions'] === 'ask' &&
      !dismissed &&
      !views.includes('audio') &&
      s.transcript_plan !== 'captions' &&
      !hasTrack &&
      (!youtube || (prefs['sources.onlineLookups'] && settled))
    )
      banner = 'no-captions'
  }

  useEffect(() => {
    if (!wantCaptions || !hasTrack || capturing) return
    setWantCaptions(false)
    if (s.transcript_plan === 'captions') return
    window.notula.sources.setTranscriptPlan({ noteId, plan: 'captions' }).catch(() => undefined)
  }, [wantCaptions, hasTrack, capturing, s.transcript_plan, noteId])

  // Allow (the question, or lookups off): lookups on, and History too when the link isn't exact.
  const allowLookups = (): Promise<void> =>
    run(async () => {
      try {
        await window.notula.sources.grant({ onlineLookups: true, ...(banner === 'first-use' && s.confidence !== 'exact' ? { readHistory: true } : {}) })
        setWantCaptions(true)
      } catch {
        failed('Couldn’t turn on lookups', 'Try again in Source settings.')
      }
    })

  const notNow = (): Promise<void> =>
    run(async () => {
      try {
        await window.notula.sources.grant({ onlineLookups: false })
      } catch {
        // The question stays; nothing to undo.
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

  let bannerEl: JSX.Element | null = null
  if (banner === 'first-use') {
    bannerEl = (
      <div className="nt-srcplan-banner" role="group" aria-label="Use this video’s captions">
        <span className="nt-srcplan-banner-text">Use this video’s captions as the transcript?</span>
        <span className="nt-srcplan-actions">
          <button type="button" className="nt-tr-link" disabled={busy} onClick={() => void allowLookups()}>
            Allow
          </button>
          <button type="button" className="nt-tr-link" disabled={busy} onClick={() => void notNow()}>
            Not now
          </button>
        </span>
      </div>
    )
  } else if (banner === 'lookups-off') {
    bannerEl = (
      <div className="nt-srcplan-banner" role="group" aria-label="Captions are off">
        <span className="nt-srcplan-banner-text">Captions are off: Notula doesn’t ask YouTube.</span>
        <span className="nt-srcplan-actions">
          <button type="button" className="nt-tr-link" disabled={busy} onClick={() => void allowLookups()}>
            Allow lookups
          </button>
        </span>
      </div>
    )
  } else if (banner === 'no-captions') {
    bannerEl = (
      <div className="nt-srcplan-banner" role="group" aria-label="This video has no captions">
        <span className="nt-srcplan-banner-text">
          This video has no captions.
          <span className="nt-srcplan-banner-sub">Records your computer’s sound (not your microphone).</span>
        </span>
        <span className="nt-srcplan-actions">
          <button type="button" className="nt-tr-link" disabled={busy || otherBusy} onClick={() => void transcribeAudio()}>
            Transcribe its audio
          </button>
          <button
            type="button"
            className="nt-tr-link"
            onClick={() => {
              dismissNoCaptions(noteId)
              setDismissed(true)
            }}
          >
            Not now
          </button>
        </span>
      </div>
    )
  }

  return (
    <>
      {bannerEl}
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
    </>
  )
}
