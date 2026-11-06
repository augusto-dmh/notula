// SPDX-License-Identifier: Apache-2.0
// The live transcript panel. Renderer-only:
// it reads main's transcript store through typed IPC and never writes to it.
//
// With diarization on, turns are word-level (shared `speakerTurns`); Copy uses the
// shared `transcriptCopyText`; the footer holds the language menu. `variant="bubble"`
// is the bubble's hover panel: no header, Copy, close or footer; the live list, search
// and the empty states.
//
// A source note (content sources) shows its transcript plan above the list, leaves out
// superseded sessions, shows either the video's captions or the audio transcript, and labels
// each turn with its video time instead of a speaker:
// - the transcript follows the video: while the note is fed a position, the line at that position
//   is highlighted and kept in view, until the user scrolls (Follow the video resumes it);
// - lines outside the watched spans are dimmed (a course note's `sources:lesson-notes-scope`);
// - a turn's time seeks the lesson's player (`jumpToPosition`); Shift-click opens the link;
// - caption tracks are named as languages ("English, auto-generated");
// - with no live playback, the panel opens at the last watched position, else the last stamp.
//
// Speaker profiles: a word-level turn's label is the speaker pill. While the
// note's job runs, the top of the list says "Naming speakers…" and the pills don't open. In
// pick mode (the agreement sheet's Pick the moment) a banner shows, and a click on a turn
// returns its note id, chunk and time to the sheet; Esc cancels.

import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from 'react'
import { hasWordLabels, type IdentityTurn } from '@shared/lib/speakers'
import { isUntimedChunk, sourceTranscriptChunks, sourceTranscriptViews, type SourceTranscriptView } from '@shared/lib/source-transcript'
import { transcriptCopyText } from '@shared/lib/transcript-text'
import type { InvokeRes } from '@shared/ipc'
import type { Note } from '@shared/types/notes'
import type { NoteSource, NoteSourceView } from '@shared/types/sources'
import type { TranscriptChunk } from '@shared/types/transcript'
import { showToast } from '../../app/toast'
import { jumpToPosition } from '../../editor/source-position'
import { AudioHealthBanner } from '../capture'
import { useCaptureSnapshot } from '../capture/store'
import { useNote } from '../enhance/store'
import { NuxTip } from '../nux'
import { TranscriptDeletedNotice } from '../retention'
import { TranscriptReportButton, TranscriptReportMenuItems, TranscriptSelectionActions } from '../transcript-reports'
import { cancelPickMode, pickTurn, usePickMode } from '../speaker-profiles'
import { positionNow, startPositionFeed, trySources } from '../sources/note/source-store'
import type { TranscriptPanelProps } from './index'
import { LanguageMenu } from './LanguageMenu'
import { mediaTurns, positionLabel, SourcePlanBar, useNoteSource } from './SourcePlan'
import { SpeakerNameCard } from './SpeakerNameCard'
import { SpeakerPill } from './SpeakerPill'
import { useSpeakerNote } from './speaker-note'
import * as SpeakerText from '../speaker-profiles/strings'
import { useSpeechPrefs } from './speech-state'
import { findTurnForQuote, formatElapsed, groupTurns, type Turn } from './turns'
import { useLiveTranscript } from './live-transcript'
import './transcript.css'

/** "At the bottom" within 48 px of the end. */
const BOTTOM_TOLERANCE_PX = 48
const COPIED_MS = 3_000
const HIGHLIGHT_MS = 6_000
const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent)
/** How often the panel reads the video position while following. */
const FOLLOW_TICK_MS = 1_000
/** How often a fed course note's watched spans are read again. */
const SCOPE_REFRESH_MS = 30_000
/** A source turn runs about this much video (SourcePlan's `mediaTurns`). */
const SOURCE_TURN_MS = 15_000

type LessonScope = InvokeRes<'sources:lesson-notes-scope'>

/** A caption track as a language: "English", "English, auto-generated". */
function trackName(lang: string, auto: boolean): string {
  let name = lang
  try {
    name = new Intl.DisplayNames(['en'], { type: 'language' }).of(lang.replace(/-orig$/i, '')) ?? lang
  } catch {
    name = lang
  }
  return auto ? `${name}, auto-generated` : name
}

/** The source as the plan bar shows it: its caption track named as a language. */
function namedTrack(view: NoteSourceView | null): NoteSourceView | null {
  const s = view?.source
  if (!view || !s?.track_language) return view
  const lang = s.track_language
  const track = s.enrichment?.captionTracks.find((t) => t.lang === lang)
  const auto = track ? track.kind === 'asr' : /-orig$/i.test(lang)
  const source: NoteSource = { ...s, track_language: trackName(lang, auto) }
  return { ...view, source }
}

/** The last `[mm:ss]` (or `[h:mm:ss]`) stamp of the stamped projection, in ms. */
function lastStampMs(stamped: string | null): number | null {
  let last: number | null = null
  for (const m of (stamped ?? '').matchAll(/\[(?:(\d+):)?(\d{1,2}):(\d{2})\]/g)) {
    last = ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1_000
  }
  return last
}

/** The turn at a video position: the one with the latest start at or before it, else the first. */
function turnAt(turns: { positionMs: number | null }[], ms: number): number {
  let idx = -1
  let best = -Infinity
  turns.forEach((t, i) => {
    if (t.positionMs !== null && t.positionMs <= ms && t.positionMs >= best) {
      best = t.positionMs
      idx = i
    }
  })
  return idx >= 0 ? idx : turns.findIndex((t) => t.positionMs !== null)
}

interface Match {
  turn: number
  start: number
  end: number
}

/**
 * The async clipboard refuses without window focus or permission; a selection copy
 * often still works then. False when both fail, so the panel can say so.
 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Fall through to the selection copy.
  }
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
    previous?.focus()
  }
}

function findMatches(turns: Turn[], query: string): Match[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const out: Match[] = []
  turns.forEach((t, turn) => {
    const text = t.text.toLowerCase()
    for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) out.push({ turn, start: i, end: i + q.length })
  })
  return out
}

function highlighted(text: string, matches: Match[], active: Match | null): ReactNode {
  if (!matches.length) return text
  const parts: ReactNode[] = []
  let at = 0
  matches.forEach((m, i) => {
    if (m.start > at) parts.push(text.slice(at, m.start))
    parts.push(
      <mark key={i} className={m === active ? 'nt-tr-mark nt-tr-mark-active' : 'nt-tr-mark'}>
        {text.slice(m.start, m.end)}
      </mark>
    )
    at = m.end
  })
  if (at < text.length) parts.push(text.slice(at))
  return parts
}

/** A panel turn; a word-level one carries its speaker identity for the pill. */
type PanelTurn = Turn & { speaker?: IdentityTurn }

/** Word-level turns (diarization on) in the panel's shape: one per run of one speaker identity. */
function wordTurns(turns: IdentityTurn[]): PanelTurn[] {
  return turns.map((t, i) => ({
    id: `${t.chunkIds[0] ?? 'turn'}:${i}`,
    source: t.channel,
    label: t.label,
    chunkIds: t.chunkIds,
    text: t.text,
    startMs: t.startMs,
    endMs: t.endMs,
    speaker: t
  }))
}

/** A note with a diarization pass shows word-level turns, so its speakers keep their letters. */
/** How long the pills fade into the labels the post-meeting step wrote. */
const SETTLE_MS = 600

/** True for a moment after `busy` ends, so the written labels cross-fade in instead of jumping. */
function useSettle(busy: boolean): boolean {
  const [settling, setSettling] = useState(false)
  const wasBusy = useRef(busy)
  useEffect(() => {
    if (busy) {
      wasBusy.current = true
      return
    }
    if (!wasBusy.current) return
    wasBusy.current = false
    setSettling(true)
    const t = setTimeout(() => setSettling(false), SETTLE_MS)
    return () => clearTimeout(t)
  }, [busy])
  return settling
}

function hasPass(chunks: TranscriptChunk[]): boolean {
  return chunks.some((c) => !!c.providerDetails?.mergeScopeId)
}

export function TranscriptPanel({ noteId, reveal, onClose, variant = 'note' }: TranscriptPanelProps): JSX.Element {
  const { chunks, loaded } = useLiveTranscript(noteId)
  const cap = useCaptureSnapshot()
  const prefs = useSpeechPrefs()
  // Word-level too when words carry confirmed names, attribution or provider labels.
  const wordLevel = (prefs?.['transcription.diarization'] ?? false) || hasWordLabels(chunks) || hasPass(chunks)
  const live = cap.transcribingNoteId === noteId
  const speakers = useSpeakerNote(noteId, chunks, live)
  const pickMode = usePickMode()
  const picking = pickMode.active && pickMode.noteId === noteId && variant !== 'bubble'
  // In pick mode a click picks a turn, so the pills don't open.
  const pillView = useMemo(() => (picking ? { ...speakers.view, viewing: false } : speakers.view), [picking, speakers.view])
  // When the post-meeting step writes, the pills fade into their final labels for a moment.
  const settling = useSettle(speakers.view.busy)
  // A source note: its plan, which transcript is shown, and video-time turns.
  const sourceView = useNoteSource(noteId)
  const source = sourceView?.source ?? null
  const views = useMemo(() => (source ? sourceTranscriptViews(chunks, source) : []), [chunks, source])
  const [shownPick, setShownPick] = useState<SourceTranscriptView | null>(null)
  const shown: SourceTranscriptView = shownPick && views.includes(shownPick) ? shownPick : (views[0] ?? 'audio')
  const shownChunks = useMemo(
    () => (source ? sourceTranscriptChunks(chunks, source, views.length ? shown : undefined) : chunks),
    [chunks, source, views.length, shown]
  )
  const sourceTurns = useMemo(() => (source ? mediaTurns(shownChunks) : null), [source, shownChunks])
  // Word-level turns run across chunks, so they can't mark held lines; while an off-the-record
  // hold lasts, the chunk turns show which lines are held back.
  const holding = useMemo(() => chunks.some((c) => c.held === true), [chunks])
  const turns = useMemo(
    (): PanelTurn[] => sourceTurns ?? (wordLevel && !holding ? wordTurns(speakers.identityTurns) : groupTurns(chunks)),
    [sourceTurns, chunks, wordLevel, holding, speakers.identityTurns]
  )
  // An untimed import's turns show no time (its times are 1 s offsets).
  const untimed = useMemo(() => new Set(chunks.filter(isUntimedChunk).map((c) => c.id)), [chunks])
  const videoTimes = useMemo(() => new Map((sourceTurns ?? []).map((t) => [t.id, positionLabel(t.positionMs)])), [sourceTurns])
  const videoPositions = useMemo(() => new Map((sourceTurns ?? []).map((t) => [t.id, t.positionMs])), [sourceTurns])
  const planView = useMemo(() => namedTrack(sourceView), [sourceView])
  const bubble = variant === 'bubble'
  const scrollRef = useRef<HTMLDivElement>(null)
  const findRef = useRef<HTMLInputElement>(null)
  const atBottomRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const [highlight, setHighlight] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeMatch, setActiveMatch] = useState(0)
  const [copied, setCopied] = useState(false)
  const [learnMore, setLearnMore] = useState(false)
  const handledReveal = useRef<number | null>(null)
  // A purged transcript shows the retention notice instead of the empty state.
  const transcriptDeleted = !!useNote(noteId)?.transcript_purged_at

  // Following the video: the fed position, the line at it, and whether the user scrolled away.
  const sourceKey = source?.canonical_key ?? null
  const [nowMs, setNowMs] = useState<number | null>(null)
  useEffect(() => {
    if (!sourceKey || bubble) {
      setNowMs(null)
      return
    }
    startPositionFeed()
    const tick = (): void => setNowMs(positionNow(noteId, sourceKey)?.positionMs ?? null)
    tick()
    const t = window.setInterval(tick, FOLLOW_TICK_MS)
    return () => clearInterval(t)
  }, [noteId, sourceKey, bubble])
  const fed = nowMs !== null
  const [followPaused, setFollowPaused] = useState(false)
  // A new playback follows again.
  useEffect(() => {
    if (!fed) setFollowPaused(false)
  }, [fed])
  const currentTurn = useMemo(() => (nowMs !== null && sourceTurns ? turnAt(sourceTurns, nowMs) : -1), [nowMs, sourceTurns])
  // The watched spans (dimming) and the last watched position; undefined until read.
  const [scope, setScope] = useState<LessonScope | undefined>(undefined)
  useEffect(() => {
    if (!sourceKey || bubble) {
      setScope(null)
      return
    }
    let alive = true
    const load = (): void =>
      void trySources('sources:lesson-notes-scope-failed', () => window.notula.sources.lessonNotesScope({ noteId })).then((r) => {
        if (alive) setScope(r)
      })
    load()
    const t = fed ? window.setInterval(load, SCOPE_REFRESH_MS) : undefined
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [noteId, sourceKey, bubble, fed])
  const ranges = scope?.ranges ?? []
  const outsideWatched = (pos: number | null | undefined): boolean =>
    ranges.length > 0 && pos !== null && pos !== undefined && !ranges.some(([a, b]) => pos + SOURCE_TURN_MS >= a && pos <= b)
  /** Set once a source note opened at its last watched position or stamp. */
  const positioned = useRef(false)
  const videoMode = useRef(false)
  videoMode.current = !!source && (fed || positioned.current)

  const origin = turns[0]?.startMs ?? 0
  // Row 0 is the consent notice; the bubble panel has none, and nor does a source note (a video
  // has nobody to ask).
  const lead = bubble || source ? 0 : 1
  const count = turns.length + lead

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (i < lead ? (learnMore ? 96 : 44) : 64),
    overscan: 8,
    getItemKey: (i) => (i < lead ? '__consent' : (turns[i - lead]?.id ?? i))
  })

  const matches = useMemo(() => (findOpen ? findMatches(turns, query) : []), [findOpen, turns, query])
  const active = matches.length ? (matches[Math.min(activeMatch, matches.length - 1)] ?? null) : null

  // Selection keeps only turns that still exist.
  useEffect(() => {
    setSelected((prev) => {
      if (!prev.size) return prev
      const ids = new Set(turns.map((t) => t.id))
      const next = new Set([...prev].filter((id) => ids.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [turns])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_TOLERANCE_PX
    atBottomRef.current = bottom
    setAtBottom(bottom)
  }, [])

  const scrollToLatest = useCallback(() => {
    if (!turns.length) return
    virtualizer.scrollToIndex(count - 1, { align: 'end' })
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }, [virtualizer, count, turns.length])

  // Follow new text only at the bottom and with no highlight active. A Show in
  // transcript reveal still to be handled wins: following would scroll its turn away.
  useEffect(() => {
    const revealPending = !!reveal && handledReveal.current !== reveal.nonce
    // A source note follows the video instead, or stays where it opened.
    if (atBottomRef.current && !highlight && !revealPending && !videoMode.current) scrollToLatest()
  }, [chunks])

  // The line at the video's position stays in view while the user doesn't scroll.
  useEffect(() => {
    if (!fed || followPaused || currentTurn < 0 || findOpen || highlight) return
    virtualizer.scrollToIndex(currentTurn + lead, { align: 'center' })
  }, [fed, followPaused, currentTurn, findOpen, highlight, virtualizer, lead])

  // With no live playback, open at the last watched position, else the last stamp.
  useEffect(() => {
    if (positioned.current || !source || !sourceTurns?.length || !loaded || fed || scope === undefined) return
    if (reveal && handledReveal.current !== reveal.nonce) return
    const at = scope?.lastMs ?? lastStampMs(source.notes_md_stamped)
    if (at === null) return
    const idx = turnAt(sourceTurns, at)
    if (idx < 0) return
    positioned.current = true
    videoMode.current = true
    virtualizer.scrollToIndex(idx + lead, { align: 'center' })
  }, [source, sourceTurns, loaded, fed, scope, reveal, virtualizer, lead])

  /** A scroll the user made (wheel, touch, the scrollbar) stops following the video. */
  const userScrolled = useCallback((): void => {
    if (fed) setFollowPaused(true)
  }, [fed])

  // Show in transcript: highlight the matching turn and centre it.
  useEffect(() => {
    if (!reveal || !loaded || handledReveal.current === reveal.nonce) return
    handledReveal.current = reveal.nonce
    const idx = findTurnForQuote(turns, reveal.quote)
    if (idx < 0) return
    const turn = turns[idx] as Turn
    setHighlight(turn.id)
    virtualizer.scrollToIndex(idx + lead, { align: 'center' })
  }, [reveal, loaded, turns, virtualizer, lead])

  useEffect(() => {
    if (!highlight) return
    const t = window.setTimeout(() => setHighlight(null), HIGHLIGHT_MS)
    return () => clearTimeout(t)
  }, [highlight])

  // The active match scrolls into view.
  useEffect(() => {
    if (active) virtualizer.scrollToIndex(active.turn + lead, { align: 'center' })
  }, [active, virtualizer, lead])

  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(t)
  }, [copied])

  const openFind = (): void => {
    setFindOpen(true)
    requestAnimationFrame(() => {
      findRef.current?.focus()
      findRef.current?.select()
    })
  }
  const closeFind = (): void => {
    setFindOpen(false)
    setQuery('')
    setActiveMatch(0)
  }
  const step = (dir: 1 | -1): void => {
    if (!matches.length) return
    setActiveMatch((i) => (Math.min(i, matches.length - 1) + dir + matches.length) % matches.length)
  }

  const onPanelKey = (e: KeyboardEvent<HTMLElement>): void => {
    const mod = IS_MAC ? e.metaKey : e.ctrlKey
    if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      openFind()
    } else if (mod && e.key.toLowerCase() === 'g' && findOpen) {
      e.preventDefault()
      step(e.shiftKey ? -1 : 1)
    }
  }

  const onFindKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    const mod = IS_MAC ? e.metaKey : e.ctrlKey
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeFind()
    } else if (e.key === 'ArrowDown' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault()
      step(1)
    } else if (e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey)) {
      e.preventDefault()
      step(-1)
    } else if (mod && e.key.toLowerCase() === 'g') {
      e.preventDefault()
      e.stopPropagation()
      step(e.shiftKey ? -1 : 1)
    }
  }

  const copy = async (): Promise<void> => {
    if (!turns.length) return
    let note: Note | null = null
    try {
      note = await window.notula.notes.get({ id: noteId })
    } catch {
      note = null
    }
    const text = transcriptCopyText({
      note: note ?? { title: null, linked_event: null, people: null, created_at: chunks[0]?.start_timestamp ?? new Date().toISOString() },
      // A source note copies the transcript it shows.
      chunks: shownChunks,
      wordLevel
    })
    if (await writeClipboard(text)) {
      setCopied(true)
      return
    }
    setCopied(false)
    showToast({
      id: 'transcript-copy-failed',
      kind: 'error',
      title: 'Couldn’t copy the transcript',
      description: 'The clipboard wasn’t available. Try again with the Notula window in front.'
    })
  }

  const toggleSelect = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Pick mode: Esc returns to the agreement sheet with nothing picked.
  useEffect(() => {
    if (!picking) return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      cancelPickMode()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [picking])

  const isThis = cap.transcribingNoteId === noteId
  const emptyState = isThis && cap.ui === 'active' ? 'active' : isThis && cap.ui === 'starting' ? 'starting' : 'paused'
  const items = virtualizer.getVirtualItems()

  return (
    <aside className={['nt-tr', bubble ? 'nt-tr--bubble' : '', picking ? 'nt-tr--picking' : '', settling ? 'nt-tr--settling' : ''].join(' ').trim()} aria-label="Transcript" tabIndex={-1} onKeyDown={onPanelKey}>
      {bubble ? (
        !findOpen && (
          <button type="button" className="nt-tr-icon nt-tr-bubble-find" title="Find" aria-label="Find" onClick={openFind}>
            <SearchIcon />
          </button>
        )
      ) : (
      <header className="nt-tr-head">
        <span className="nt-tr-title">Transcript</span>
        <div className="nt-tr-actions">
          <button type="button" className="nt-tr-icon" title="Find" aria-label="Find" onClick={openFind}>
            <SearchIcon />
          </button>
          <button
            type="button"
            className="nt-tr-icon"
            title={copied ? 'Copied' : 'Copy transcript'}
            aria-label={copied ? 'Copied' : 'Copy transcript'}
            disabled={!turns.length}
            onClick={() => void copy()}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
          {/* Report a transcript problem. */}
          <TranscriptReportButton noteId={noteId} />
          <button type="button" className="nt-tr-icon" title="Hide transcript" aria-label="Hide transcript" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
      </header>
      )}
      {!bubble && sourceView && (
        <SourcePlanBar noteId={noteId} view={planView ?? sourceView} views={views} shown={shown} onShow={setShownPick} />
      )}
      {!bubble && <AudioHealthBanner noteId={noteId} />}
      {/* The speaker-name suggestion card, top of the panel. */}
      {!bubble && <SpeakerNameCard noteId={noteId} variant="panel" />}
      {/* The live-transcript tip. */}
      {!bubble && <NuxTip id="live-transcript" />}
      {/* While the post-meeting job runs the pills don't open. */}
      {speakers.view.busy && !live && (
        <div className="nt-spk-quiet" role="status">
          {SpeakerText.namingSpeakers()}
        </div>
      )}
      {picking && pickMode.active && (
        <div className="nt-spk-pickbar" role="status">
          <span>{SpeakerText.pickBanner(pickMode.personName)}</span>
          <button type="button" className="nt-tr-link" onClick={cancelPickMode}>
            {SpeakerText.cancel()}
          </button>
        </div>
      )}

      {findOpen && (
        <div className="nt-tr-find">
          <input
            ref={findRef}
            className="nt-tr-find-input"
            placeholder="Find"
            aria-label="Find"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActiveMatch(0)
            }}
            onKeyDown={onFindKey}
          />
          <span className="nt-tr-find-count" aria-live="polite">
            {query.trim() ? (matches.length ? `${Math.min(activeMatch, matches.length - 1) + 1}/${matches.length}` : 'No results') : ''}
          </span>
          <button type="button" className="nt-tr-icon" title="Previous result" aria-label="Previous result" onClick={() => step(-1)}>
            ↑
          </button>
          <button type="button" className="nt-tr-icon" title="Next result" aria-label="Next result" onClick={() => step(1)}>
            ↓
          </button>
          <button type="button" className="nt-tr-icon" title="Close" aria-label="Close find" onClick={closeFind}>
            <CloseIcon />
          </button>
        </div>
      )}

      <div
        className="nt-tr-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        onWheel={userScrolled}
        onTouchMove={userScrolled}
        onMouseDown={(e) => {
          // A press on the scrollbar itself.
          if (e.target === e.currentTarget) userScrolled()
        }}
      >
        <div className="nt-tr-list" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => {
            const style = { transform: `translateY(${item.start}px)` }
            if (item.index < lead) {
              return (
                <div key={item.key} ref={virtualizer.measureElement} data-index={0} className="nt-tr-row" style={style}>
                  <div className="nt-tr-consent">
                    <span>Let everyone know before you transcribe a meeting.</span>{' '}
                    <button type="button" className="nt-tr-link" onClick={() => setLearnMore((v) => !v)}>
                      Learn more
                    </button>
                    {learnMore && (
                      <p className="nt-tr-consent-more">
                        Notula records your microphone and your computer's audio and sends them only to the
                        transcription provider you chose. Tell everyone in the meeting and get their consent before
                        you transcribe.
                      </p>
                    )}
                  </div>
                </div>
              )
            }
            const i = item.index - lead
            const turn = turns[i] as PanelTurn
            const prev = i > 0 ? turns[i - 1] : undefined
            const timeless = untimed.has(turn.chunkIds[0] ?? '')
            const elapsedAbove = !source && !timeless && !!prev && prev.chunkIds.length >= 2 && prev.source !== turn.source
            const videoTime = source ? videoTimes.get(turn.id) : null
            const videoPos = source ? videoPositions.get(turn.id) : null
            const turnMatches = matches.filter((m) => m.turn === i)
            const isSelected = selected.has(turn.id)
            return (
              <div key={item.key} ref={virtualizer.measureElement} data-index={item.index} className="nt-tr-row" style={style}>
                {elapsedAbove && <div className="nt-tr-elapsed">{formatElapsed(turn.startMs - origin)}</div>}
                <div
                  className={[
                    'nt-tr-turn',
                    turn.source === 'microphone' ? 'nt-tr-me' : 'nt-tr-them',
                    highlight === turn.id ? 'nt-tr-highlight' : '',
                    isSelected ? 'nt-tr-selected' : '',
                    turn.held ? 'nt-tr-held' : '',
                    fed && i === currentTurn ? 'nt-tr-current' : '',
                    outsideWatched(videoPos) ? 'nt-tr-unwatched' : ''
                  ].join(' ')}
                  onClickCapture={
                    picking
                      ? (e) => {
                          // The label and text are for the sheet's display only; main gets the note id and
                          // the time and extracts the excerpt itself.
                          e.preventDefault()
                          e.stopPropagation()
                          pickTurn({
                            noteId,
                            chunkId: turn.chunkIds[0] ?? '',
                            atMs: turn.startMs,
                            ...(turn.label ? { speaker: turn.label } : {}),
                            ...(turn.text ? { text: turn.text } : {})
                          })
                        }
                      : undefined
                  }
                >
                  <button
                    type="button"
                    className="nt-tr-select"
                    aria-pressed={isSelected}
                    aria-label={isSelected ? 'Deselect turn' : 'Select turn'}
                    onClick={() => toggleSelect(turn.id)}
                  >
                    {isSelected ? '✓' : ''}
                  </button>
                  <div className="nt-tr-turn-main">
                    <div className="nt-tr-meta">
                      {turn.speaker && !source ? (
                        <SpeakerPill view={pillView} turn={turn.speaker} />
                      ) : (
                        turn.label && <span className="nt-tr-label">{turn.label}</span>
                      )}
                      {!timeless &&
                        (videoTime && videoPos !== null && videoPos !== undefined ? (
                          <button
                            type="button"
                            className="nt-tr-time nt-tr-time--jump"
                            title={source?.url ? `Jump to ${videoTime} (Shift: open the link)` : `Jump to ${videoTime}`}
                            aria-label={`Jump to ${videoTime} in the video`}
                            onClick={(e) => {
                              e.stopPropagation()
                              void jumpToPosition(noteId, source?.url ?? null, videoPos, { newTab: e.shiftKey })
                            }}
                          >
                            {videoTime}
                          </button>
                        ) : (
                          <span className="nt-tr-time">{videoTime ?? formatElapsed(turn.startMs - origin)}</span>
                        ))}
                      {turn.held && <span className="nt-tr-held-mark">Held back</span>}
                    </div>
                    <div className="nt-tr-text">{highlighted(turn.text, turnMatches, active)}</div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {loaded && !turns.length && transcriptDeleted && <TranscriptDeletedNotice noteId={noteId} />}
        {loaded && !turns.length && !transcriptDeleted && (
          <div className="nt-tr-empty">
            {emptyState === 'active' ? (
              <>
                <span className="nt-tr-empty-line">Transcript on…</span>
                <span className="nt-tr-empty-prompt">{source ? 'Play the video to transcribe it' : 'Try saying “Hello Notula”'}</span>
              </>
            ) : emptyState === 'starting' ? (
              <span className="nt-tr-empty-line">Transcript starting…</span>
            ) : (
              <span className="nt-tr-empty-line">Transcript paused</span>
            )}
          </div>
        )}
      </div>

      {selected.size > 0 ? (
        <div className="nt-tr-pill">
          <span>
            {selected.size} {selected.size === 1 ? 'turn' : 'turns'} selected
          </span>
          <button type="button" className="nt-tr-link" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
          {/* Thumbs for a report, and Delete for the selected sections. */}
          <TranscriptSelectionActions
            noteId={noteId}
            chunkIds={turns.filter((t) => selected.has(t.id)).flatMap((t) => t.chunkIds)}
            onClear={() => setSelected(new Set())}
          />
        </div>
      ) : fed && followPaused ? (
        <button type="button" className="nt-tr-follow" onClick={() => setFollowPaused(false)}>
          Follow the video
        </button>
      ) : (
        !atBottom &&
        !fed &&
        turns.length > 0 && (
          <button type="button" className="nt-tr-jump" aria-label="Jump to the latest" title="Jump to the latest" onClick={scrollToLatest}>
            ↓
          </button>
        )
      )}
      {!bubble && (
        <footer className="nt-tr-foot">
          <LanguageMenu />
          {/* The transcript menu's report items. */}
          <TranscriptReportMenuItems noteId={noteId} />
        </footer>
      )}
    </aside>
  )
}

function SearchIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function CopyIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3 10.5V3.5A1.5 1.5 0 0 1 4.5 2h6" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

function CheckIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m3 8.5 3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function CloseIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}
