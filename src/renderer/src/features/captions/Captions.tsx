// SPDX-License-Identifier: Apache-2.0
// The live-captions window (`#/captions`): a dark strip
// with the latest speaker group in large type, which expands into a scrolling live transcript
// with search. Content comes from `transcript:get` and `transcript:changed`, grouped
// with the shared speaker turns; the status line and title follow the bubble's document.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX, type ReactNode } from 'react'
import { speakerTurns, type SpeakerTurn } from '@shared/lib/speakers'
import type { CaptionsState } from '@shared/types/captions'
import { CAPTIONS_GEOMETRY } from '@shared/types/captions'
import type { SourceState } from '@shared/types/common'
import type { TranscriptChanged, TranscriptChunk } from '@shared/types/transcript'
import { SPEAKER_LABEL_ME } from '@shared/types/transcript'
import { useBubbleState } from '../bubble/state'
import './captions.css'

// ---------- state mirrors ----------

let captions: CaptionsState = { noteId: null, active: false, alwaysOn: false, mode: 'compact', searching: false }
let captionsStarted = false
let captionsPushed = false
const captionListeners = new Set<() => void>()

function setCaptions(next: CaptionsState, fromPush: boolean): void {
  if (!fromPush && captionsPushed) return
  if (fromPush) captionsPushed = true
  captions = next
  for (const l of captionListeners) l()
}

export function useCaptionsState(): CaptionsState {
  return useSyncExternalStore(
    (cb) => {
      if (!captionsStarted) {
        captionsStarted = true
        window.notula.captions.onState((s) => setCaptions(s, true))
        void window.notula.captions
          .getState()
          .then((s) => setCaptions(s, false))
          .catch(() => undefined)
      }
      captionListeners.add(cb)
      return () => captionListeners.delete(cb)
    },
    () => captions
  )
}

function useChunks(noteId: string | null): TranscriptChunk[] {
  const [chunks, setChunks] = useState<TranscriptChunk[]>([])
  useEffect(() => {
    setChunks([])
    if (!noteId) return
    let alive = true
    let loaded = false
    const map = new Map<string, TranscriptChunk>()
    const early: TranscriptChanged[] = []
    const apply = (p: TranscriptChanged): void => {
      for (const id of p.removedIds) map.delete(id)
      for (const c of p.upserted) map.set(c.id, c)
    }
    const publish = (): void => {
      if (alive) setChunks([...map.values()])
    }
    const off = window.notula.transcript.onChanged((p) => {
      if (p.noteId !== noteId) return
      if (!loaded) {
        early.push(p)
        return
      }
      apply(p)
      publish()
    })
    void window.notula.transcript
      .get({ noteId })
      .then((rows) => {
        for (const r of rows) map.set(r.id, r)
      })
      .catch(() => undefined)
      .finally(() => {
        loaded = true
        for (const p of early.splice(0)) apply(p)
        publish()
      })
    return () => {
      alive = false
      off()
    }
  }, [noteId])
  return chunks
}

// ---------- helpers ----------

const STATUS: Record<SourceState, string> = {
  starting: 'Captions are starting…',
  active: 'Listening for speech…',
  error: 'Captions are reconnecting…',
  inactive: 'Captions are paused'
}

const PALETTE = ['#7cc4ff', '#f7a8d8', '#ffd27a', '#a6e3a1', '#c5a3ff', '#ffb38a', '#8be0d4']

function speakerColor(label: string, own: boolean): string {
  if (own) return '#7ee2a8'
  let h = 0
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) | 0
  return PALETTE[Math.abs(h) % PALETTE.length] as string
}

interface Group {
  key: string
  turn: SpeakerTurn
  own: boolean
  final: boolean
}

function groups(chunks: TranscriptChunk[], live: boolean): Group[] {
  const byId = new Map(chunks.map((c) => [c.id, c]))
  return speakerTurns(chunks, { wordLevel: false, live }).map((t) => {
    const last = byId.get(t.chunkIds[t.chunkIds.length - 1] ?? '')
    return {
      key: `${t.sessionId}:${t.chunkIds[0] ?? ''}`,
      turn: t,
      own: t.source === 'microphone' || t.label === SPEAKER_LABEL_ME,
      // A group is final once its last chunk is, or once transcription is no longer active.
      final: !live || (last?.is_final ?? true)
    }
  })
}

/** Each word in its own span, so new words fade in while earlier ones stay put. */
function Words({ text }: { text: string }): JSX.Element {
  const words = text.split(/\s+/).filter(Boolean)
  return (
    <>
      {words.map((w, i) => (
        <span key={i} className="cap-word">
          {w}{' '}
        </span>
      ))}
    </>
  )
}

function highlight(text: string, q: string): ReactNode {
  if (!q) return text
  const lower = text.toLowerCase()
  const needle = q.toLowerCase()
  const out: ReactNode[] = []
  let at = 0
  for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, at)) {
    if (i > at) out.push(text.slice(at, i))
    out.push(<mark key={i}>{text.slice(i, i + needle.length)}</mark>)
    at = i + needle.length
  }
  out.push(text.slice(at))
  return out
}

function Icon({ d, size = 16 }: { d: string; size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

const ICON_EXPAND = 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7'
const ICON_COLLAPSE = 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7'
const ICON_CLOSE = 'M6 6l12 12M18 6L6 18'
const ICON_SEARCH = 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4'
const ICON_DOWN = 'M12 5v14M5 12l7 7 7-7'

function IconButton({ label, d, onClick }: { label: string; d: string; onClick(): void }): JSX.Element {
  return (
    <button type="button" className="cap-btn" aria-label={label} title={label} onClick={onClick}>
      <Icon d={d} />
    </button>
  )
}

// ---------- the window ----------

export function CaptionsWindow(): JSX.Element {
  useEffect(() => {
    const html = document.documentElement
    html.classList.add('nt-secondary', 'cap-window')
    html.dataset['theme'] = 'dark'
  }, [])
  const s = useCaptionsState()
  const { document: doc } = useBubbleState()
  const transcription: SourceState = doc && doc.noteId === s.noteId ? doc.transcription : s.active ? 'active' : 'inactive'
  const live = transcription === 'active' || transcription === 'starting'
  const chunks = useChunks(s.noteId)
  const all = useMemo(() => groups(chunks, live), [chunks, live])

  const close = (): void => {
    if (s.noteId) void window.notula.captions.setEnabled({ noteId: s.noteId, enabled: false })
  }
  const setMode = (mode: 'compact' | 'expanded', searching: boolean): void => {
    void window.notula.captions.setMode({ mode, searching })
  }

  if (!s.active) return <div className="cap-root" />
  return s.mode === 'expanded' ? (
    <Expanded title={doc?.title?.trim() || 'New meeting'} groups={all} searching={s.searching} setMode={setMode} close={close} />
  ) : (
    <Compact latest={all[all.length - 1] ?? null} status={STATUS[transcription]} expand={() => setMode('expanded', false)} close={close} />
  )
}

function Compact({ latest, status, expand, close }: { latest: Group | null; status: string; expand(): void; close(): void }): JSX.Element {
  return (
    <div className="cap-root cap-root--compact">
      <div className="cap-card cap-card--compact">
        <div className="cap-compact__body">
          {latest ? (
            <div key={latest.key} className="cap-caption">
              <div className="cap-caption__label" style={{ color: speakerColor(latest.turn.label, latest.own) }}>
                {latest.turn.label}
              </div>
              <div className="cap-caption__lines">
                <p className="cap-caption__text" style={{ opacity: latest.final ? 1 : CAPTIONS_GEOMETRY.interimOpacityCompact }}>
                  <Words text={latest.turn.text} />
                </p>
              </div>
            </div>
          ) : (
            <div className="cap-waiting">
              <div className="cap-waiting__title">Live captions</div>
              <div className="cap-waiting__status">{status}</div>
            </div>
          )}
        </div>
        <div className="cap-tools">
          <IconButton label="Expand live transcript" d={ICON_EXPAND} onClick={expand} />
          <IconButton label="Close live captions" d={ICON_CLOSE} onClick={close} />
        </div>
      </div>
    </div>
  )
}

function Expanded({
  title,
  groups: all,
  searching,
  setMode,
  close
}: {
  title: string
  groups: Group[]
  searching: boolean
  setMode(mode: 'compact' | 'expanded', searching: boolean): void
  close(): void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const q = searching ? query.trim() : ''
  const shown = q ? all.filter((g) => g.turn.text.toLowerCase().includes(q.toLowerCase())) : all
  const list = useRef<HTMLDivElement | null>(null)
  const [following, setFollowing] = useState(true)
  const input = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!searching) setQuery('')
    else input.current?.focus()
  }, [searching])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && searching) setMode('expanded', false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [searching, setMode])

  // Follow the newest group while within 48 px of the bottom.
  useLayoutEffect(() => {
    const el = list.current
    if (el && following && !q) el.scrollTop = el.scrollHeight
  }, [shown, following, q])

  const onScroll = (): void => {
    const el = list.current
    if (!el) return
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight <= CAPTIONS_GEOMETRY.followTolerancePx)
  }

  return (
    <div className="cap-root cap-root--expanded">
      <div className="cap-card cap-card--expanded">
        <header className="cap-head">
          <div className="cap-head__title">{title}</div>
          <div className="cap-tools">
            <IconButton
              label={searching ? 'Close transcript search' : 'Search transcript'}
              d={searching ? ICON_CLOSE : ICON_SEARCH}
              onClick={() => setMode('expanded', !searching)}
            />
            <IconButton label="Collapse live transcript" d={ICON_COLLAPSE} onClick={() => setMode('compact', false)} />
            <IconButton label="Close live captions" d={ICON_CLOSE} onClick={close} />
          </div>
        </header>
        {searching ? (
          <div className="cap-search">
            <Icon d={ICON_SEARCH} size={14} />
            <input
              ref={input}
              className="cap-search__input"
              placeholder="Search transcript"
              aria-label="Search transcript"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {q ? <span className="cap-search__count">{`${shown.length} ${shown.length === 1 ? 'result' : 'results'}`}</span> : null}
          </div>
        ) : null}
        <div ref={list} className="cap-list" onScroll={onScroll}>
          {all.length === 0 ? (
            <div className="cap-empty">Transcript will appear here</div>
          ) : shown.length === 0 ? (
            <div className="cap-empty">No transcript results</div>
          ) : (
            shown.map((g) => (
              <div
                key={g.key}
                className={`cap-group${g.own ? ' is-own' : ''}`}
                style={{ opacity: g.final ? 1 : CAPTIONS_GEOMETRY.interimOpacityExpanded }}
              >
                <div className="cap-group__label" style={{ color: speakerColor(g.turn.label, g.own) }}>
                  {g.turn.label}
                </div>
                <div className="cap-group__text">{q ? highlight(g.turn.text, q) : g.final ? g.turn.text : <Words text={g.turn.text} />}</div>
              </div>
            ))
          )}
        </div>
        {!following && !q && all.length > 0 ? (
          <button
            type="button"
            className="cap-jump"
            onClick={() => {
              setFollowing(true)
              const el = list.current
              if (el) el.scrollTop = el.scrollHeight
            }}
          >
            <Icon d={ICON_DOWN} size={14} /> Jump to latest
          </button>
        ) : null}
      </div>
    </div>
  )
}
