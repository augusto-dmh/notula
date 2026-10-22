// SPDX-License-Identifier: Apache-2.0
// `#/meeting-dock`: a small dark window with three views (`Chat`, `My notes`,
// `Live transcript`) over one composer.
//
// - Main owns the geometry (`meeting-dock:set-bounds`, `meeting-dock:set-view`): the header
//   drags the window natively, the eight edge and corner handles send `setBounds`, and opening
//   a view sends `setView` so main grows it.
// - Chat: `chat:send-message` with surface `meeting_dock`, place `meeting`, grouping key
//   `meeting-dock:<noteId>`, read-only tools, a 60 s timeout. One question at a time; the
//   question is stored as pending before it is sent, and a failure shows its own message.
// - History (`meeting-dock:history-save`) is saved on every change; a failed save says so.
// - Recipes: suggestions while the composer is focused, empty and idle, most used first,
//   cached 60 s. Running one goes through the chat send path, which records its use.

import { Component, useCallback, useEffect, useMemo, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { LOCAL_ONLY_COPY } from '@shared/types/local-only'
import { meetingDockGroupingKey, type ChatEvent, type ChatOutput, type DocRef } from '@shared/types/chat'
import {
  MEETING_DOCK_GEOMETRY as G,
  type MeetingDockExchange,
  type MeetingDockHistory,
  type MeetingDockState,
  type MeetingDockView
} from '@shared/types/meeting-dock'
import type { Recipe } from '@shared/types/recipes'
import type { TranscriptChunk } from '@shared/types/transcript'
import { debugLog } from '../../app/platform'
import { NotulaEditor, roomIdFor } from '../../editor'
import { MarkdownView } from '../chat/ChatMarkdown'
import { useLiveTranscript } from '../transcript/live-transcript'
import './meeting-dock.css'

const COPY = {
  empty: 'No answer came back. Try asking again.',
  requestError: 'Couldn’t get an answer. Check your AI provider in Settings and try again.',
  cancelled: 'The answer was stopped.',
  startError: 'Couldn’t send your question. Try again in a moment.',
  interrupted: 'This answer was interrupted. Ask again to get a full one.',
  saveFailed: 'Couldn’t save this conversation. Copy what you need before closing this window.',
  needsAction: 'This needs your approval. Open the chat in the main window to continue.'
} as const

const THINKING = ['Thinking...', 'Mulling...', 'Simmering...', 'Cooking...', 'Working...', 'Processing...']
const VIEWS: { id: MeetingDockView; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'notes', label: 'My notes' },
  { id: 'transcript', label: 'Live transcript' }
]

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  override componentDidCatch(err: unknown): void {
    debugLog('meeting-dock:render-failed', { err: String(err) })
  }
  override render(): ReactNode {
    return this.state.failed ? <p className="dock-empty">Something went wrong in this view.</p> : this.props.children
  }
}

// ---------- resize handles ----------

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const EDGES: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

function ResizeHandles(): JSX.Element {
  const drag = useRef<{ edge: Edge; x: number; y: number; b: { x: number; y: number; width: number; height: number } } | null>(null)
  const frame = useRef(0)

  const onDown = (edge: Edge) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { edge, x: e.screenX, y: e.screenY, b: { x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight } }
  }
  const onMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    const dx = e.screenX - d.x
    const dy = e.screenY - d.y
    let { x, y, width, height } = d.b
    if (d.edge.includes('e')) width = Math.max(G.minWidth, d.b.width + dx)
    if (d.edge.includes('s')) height = Math.max(G.minHeight, d.b.height + dy)
    if (d.edge.includes('w')) {
      width = Math.max(G.minWidth, d.b.width - dx)
      x = d.b.x + d.b.width - width
    }
    if (d.edge.includes('n')) {
      height = Math.max(G.minHeight, d.b.height - dy)
      y = d.b.y + d.b.height - height
    }
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => window.notula.meetingDock.setBounds({ x, y, width, height }))
  }
  const onUp = (): void => {
    drag.current = null
  }
  return (
    <>
      {EDGES.map((edge) => (
        <div key={edge} className={`dock-handle dock-handle--${edge}`} onPointerDown={onDown(edge)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
      ))}
    </>
  )
}

// ---------- views ----------

function NotesView({ noteId }: { noteId: string | null }): JSX.Element {
  if (!noteId) return <p className="dock-empty">Start or open a meeting to take notes here.</p>
  return (
    <div className="dock-notes">
      <NotulaEditor roomId={roomIdFor('notes', noteId)} kind="notes" editable placeholder="Write notes" autofocus={false} />
    </div>
  )
}

function speakerOf(c: TranscriptChunk): string {
  return c.detectedSpeaker?.participantName ?? c.detected_speaker_name ?? (c.source === 'microphone' ? 'Me' : 'Them')
}

function TranscriptView({ noteId, captureState }: { noteId: string; captureState: MeetingDockState['captureState'] }): JSX.Element {
  const { chunks, loaded } = useLiveTranscript(noteId)
  const end = useRef<HTMLDivElement>(null)
  const lines = useMemo(() => {
    const out: { id: string; speaker: string; text: string }[] = []
    for (const c of chunks) {
      const text = c.text.trim()
      if (!text) continue
      const speaker = speakerOf(c)
      const last = out[out.length - 1]
      if (last && last.speaker === speaker) last.text = `${last.text} ${text}`
      else out.push({ id: c.id, speaker, text })
    }
    return out
  }, [chunks])
  useEffect(() => {
    if (captureState === 'on') end.current?.scrollIntoView({ block: 'end' })
  }, [lines, captureState])

  if (!loaded) return <p className="dock-empty">Loading meeting…</p>
  if (lines.length === 0) {
    const status = captureState === 'paused' ? 'Transcript paused' : captureState === 'on' ? 'Transcript on…' : 'Transcript starting…'
    return (
      <div className="dock-status" role="status">
        <span className={`dock-status__dot${captureState === 'on' ? ' is-live' : ''}`} aria-hidden="true" />
        {status}
      </div>
    )
  }
  return (
    <div className="dock-transcript">
      {lines.map((l) => (
        <p key={l.id} className="dock-line">
          <span className="dock-line__who">{l.speaker}</span>
          {l.text}
        </p>
      ))}
      <div ref={end} />
    </div>
  )
}

function answerOf(outputs: ChatOutput[], streamed: string): { text: string; nonReasoning: number; needsAction: boolean } {
  let text = ''
  let nonReasoning = 0
  let needsAction = false
  for (const o of outputs) {
    if (o.type === 'reasoning') continue
    nonReasoning++
    if (o.type === 'text') text += o.text
    else if (o.type === 'cited_text') text += o.plain_text
    else if (o.type === 'tool_call' && o.tool_call.approval?.status === 'pending') needsAction = true
    else if (o.type === 'draft_preview') needsAction = true
  }
  return { text: text || streamed, nonReasoning, needsAction }
}

function Sources({ sources, noteId }: { sources: MeetingDockExchange['sources']; noteId: string }): JSX.Element | null {
  if (sources.length === 0) return null
  const meeting = sources.filter((s) => s.noteId === noteId)
  const others = sources.filter((s) => s.noteId !== noteId)
  return (
    <div className="dock-sources">
      {meeting.length ? <span className="dock-sources__label">Meeting sources</span> : null}
      {meeting.length ? <span className="dock-chip">This meeting</span> : null}
      {others.length ? <span className="dock-sources__label">Supporting sources</span> : null}
      {others.map((s) => (
        <span key={s.noteId} className="dock-chip" title={s.title ?? undefined}>
          {s.title ?? 'Untitled'}
        </span>
      ))}
    </div>
  )
}

function Thinking(): JSX.Element {
  const [i, setI] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % THINKING.length), 1_600)
    return () => clearInterval(t)
  }, [])
  return <span className="dock-thinking">{THINKING[i]}</span>
}

// ---------- the dock ----------

interface Live {
  requestId: string
  question: string
  text: string
  outputs: ChatOutput[]
  docs: Record<string, DocRef>
}

function Dock(): JSX.Element {
  const [st, setSt] = useState<MeetingDockState | null>(null)
  const [history, setHistory] = useState<MeetingDockHistory | null>(null)
  const [live, setLive] = useState<Live | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  const [focused, setFocused] = useState(false)
  const [recipes, setRecipes] = useState<Recipe[] | null>(null)
  const threadRef = useRef<string | null>(null)
  const liveRef = useRef<Live | null>(null)
  const histRef = useRef<MeetingDockHistory | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recipesAt = useRef(0)
  const listEnd = useRef<HTMLDivElement>(null)
  const noteId = st?.noteId ?? null

  useEffect(() => {
    document.title = 'Notula meeting dock'
    document.documentElement.dataset['theme'] = 'dark'
    document.documentElement.classList.add('dock-doc')
    void window.notula.meetingDock.getState().then(setSt).catch((err: unknown) => debugLog('meeting-dock:state-failed', { err: String(err) }))
    return window.notula.meetingDock.onState(setSt)
  }, [])

  // History per note.
  useEffect(() => {
    if (!noteId) return
    let alive = true
    threadRef.current = null
    void window.notula.meetingDock
      .getHistory({ noteId })
      .then((h) => {
        if (!alive) return
        const next = h ?? { noteId, exchanges: [], pending: null, input: '' }
        histRef.current = next
        setHistory(next)
        if (next.pending) setError(COPY.interrupted)
      })
      .catch(() => alive && setHistory({ noteId, exchanges: [], pending: null, input: '' }))
    void window.notula.chat
      .listThreads({ groupingKey: meetingDockGroupingKey(noteId) })
      .then((ts) => {
        if (alive && !threadRef.current) threadRef.current = ts[0]?.id ?? null
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [noteId])

  const save = useCallback((next: MeetingDockHistory) => {
    histRef.current = next
    setHistory(next)
    void window.notula.meetingDock
      .saveHistory(next)
      .then(() => setSaveFailed(false))
      .catch(() => setSaveFailed(true))
  }, [])

  const finish = useCallback(
    (outcome: { exchange?: MeetingDockExchange; error?: string }) => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      liveRef.current = null
      setLive(null)
      const h = histRef.current
      if (!h) return
      if (outcome.exchange) {
        setError(null)
        save({ ...h, exchanges: [...h.exchanges, outcome.exchange], pending: null })
      } else if (outcome.error) {
        setError(outcome.error)
      }
    },
    [save]
  )

  // Chat events for the request in flight.
  useEffect(
    () =>
      window.notula.chat.onEvent((e: ChatEvent) => {
        const l = liveRef.current
        if (!l || e.requestId !== l.requestId) return
        threadRef.current = e.threadId
        if (e.type === 'text_delta') l.text += e.delta
        else if (e.type === 'outputs') l.outputs = e.outputs
        else if (e.type === 'output_update') {
          const next = [...l.outputs]
          next[e.index] = e.output
          l.outputs = next
        } else if (e.type === 'sources_progress' && e.scannedDocuments) l.docs = { ...l.docs, ...e.scannedDocuments }
        else if (e.type === 'error') return finish({ error: COPY.requestError })
        else if (e.type === 'stream_done') {
          if (e.metadata.finishReason === 'cancelled') return finish({ error: COPY.cancelled })
          const a = answerOf(e.outputs.length ? e.outputs : l.outputs, l.text)
          if (!a.text.trim() && a.nonReasoning === 0) return finish({ error: COPY.empty })
          return finish({
            exchange: {
              id: l.requestId,
              question: l.question,
              answer: a.needsAction ? `${a.text}\n\n${COPY.needsAction}`.trim() : a.text,
              status: 'done',
              at: new Date().toISOString(),
              sources: Object.values(l.docs).map((d) => ({ noteId: d.id, title: d.title || null, kind: d.id === noteId ? ('transcript' as const) : ('note' as const) }))
            }
          })
        }
        setLive({ ...l })
      }),
    [finish, noteId]
  )

  // A closing window aborts the request in flight; the question stays pending.
  useEffect(() => {
    const onUnload = (): void => {
      if (liveRef.current && threadRef.current) void window.notula.chat.stop({ threadId: threadRef.current })
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])

  const setView = (view: MeetingDockView): void => window.notula.meetingDock.setView({ expanded: true, view })

  const ask = async (question: string, recipe: Recipe | null = null): Promise<void> => {
    const h = histRef.current
    if (!noteId || !h || liveRef.current || st?.localOnlyBlocked) return
    // Stored as pending at once, so it survives a crash.
    save({ ...h, pending: { question, startedAt: new Date().toISOString() }, input: '' })
    setError(null)
    if (st?.view !== 'chat' || !st.expanded) setView('chat')
    const l: Live = { requestId: crypto.randomUUID(), question, text: '', outputs: [], docs: {} }
    liveRef.current = l
    setLive({ ...l })
    timer.current = setTimeout(() => {
      if (liveRef.current?.requestId !== l.requestId) return
      if (threadRef.current) void window.notula.chat.stop({ threadId: threadRef.current })
      finish({ error: COPY.cancelled })
    }, G.answerTimeoutMs)
    try {
      const accepted = await window.notula.chat.sendMessage({
        requestId: l.requestId,
        threadId: threadRef.current,
        groupingKey: meetingDockGroupingKey(noteId),
        surface: 'meeting_dock',
        place: { kind: 'meeting', noteId },
        text: recipe ? '' : question,
        mentions: [],
        recipeId: recipe?.id ?? null,
        selectedDocuments: [],
        target: null,
        selectionMarkdown: null,
        editWithAi: false,
        responseStyle: 'default',
        edit: null,
        approval: null,
        preview: null
      })
      threadRef.current = accepted.threadId
    } catch (err) {
      debugLog('meeting-dock:send-failed', { err: String(err) })
      if (liveRef.current?.requestId === l.requestId) finish({ error: COPY.startError })
    }
  }

  const retry = (): void => {
    const q = histRef.current?.pending?.question
    if (q) void ask(q)
  }

  const setInput = (input: string): void => {
    const h = histRef.current
    if (!h) return
    const next = { ...h, input }
    histRef.current = next
    setHistory(next)
    if (inputTimer.current) clearTimeout(inputTimer.current)
    inputTimer.current = setTimeout(() => save(histRef.current ?? next), 300)
  }

  // Recipes: loaded when the composer is focused, cached 60 s, most used first.
  useEffect(() => {
    if (!focused || Date.now() - recipesAt.current < G.recipesCacheMs) return
    recipesAt.current = Date.now()
    void Promise.all([window.notula.recipes.list(), window.notula.recipes.usage().catch(() => ({}) as Record<string, { total_count: number }>)])
      .then(([list, usage]) => {
        const used = (r: Recipe): number => usage[r.id]?.total_count ?? 0
        setRecipes(list.filter((r) => !r.deleted_at).sort((a, b) => used(b) - used(a)).slice(0, 4))
      })
      .catch(() => setRecipes([]))
  }, [focused])

  useEffect(() => {
    if (st?.view === 'chat') listEnd.current?.scrollIntoView({ block: 'end' })
  }, [history?.exchanges.length, live, st?.view])

  if (!st) return <div className="dock-root" />
  const input = history?.input ?? ''
  const busy = live !== null
  const blocked = st.localOnlyBlocked
  const showRecipes = focused && !input.trim() && !busy && !blocked && (recipes?.length ?? 0) > 0

  return (
    <div className={`dock-root${st.expanded ? ' is-expanded' : ''}`}>
      <ResizeHandles />
      <header className="dock-head">
        <div className="dock-tabs" role="tablist" aria-label="Meeting views">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={st.view === v.id}
              className={`dock-tab${st.view === v.id ? ' is-active' : ''}`}
              onClick={() => (st.view === v.id && st.expanded ? window.notula.meetingDock.setView({ expanded: false, view: v.id }) : setView(v.id))}
            >
              {v.label}
            </button>
          ))}
        </div>
        <button type="button" className="dock-close" aria-label="Close meeting dock" onClick={() => void window.notula.meetingDock.close()}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </header>

      <main className="dock-body">
        <Boundary>
          {st.view === 'notes' ? <NotesView noteId={noteId} /> : null}
          {st.view === 'transcript' && noteId ? <TranscriptView noteId={noteId} captureState={st.captureState} /> : null}
          {st.view === 'chat' ? (
            <div className="dock-chat">
              {!history ? <p className="dock-empty">Loading meeting…</p> : null}
              {history && history.exchanges.length === 0 && !live && !error ? <p className="dock-empty">Ask about this meeting while it happens.</p> : null}
              {history?.exchanges.map((x) => (
                <div key={x.id} className="dock-exchange">
                  <p className="dock-q">{x.question}</p>
                  <div className="dock-a">
                    <MarkdownView markdown={x.answer} />
                  </div>
                  {noteId ? <Sources sources={x.sources} noteId={noteId} /> : null}
                </div>
              ))}
              {live ? (
                <div className="dock-exchange" aria-live="polite">
                  <p className="dock-q">{live.question}</p>
                  <div className="dock-a">{live.text ? <MarkdownView markdown={live.text} /> : <Thinking />}</div>
                </div>
              ) : null}
              {error ? (
                <div className="dock-error" role="alert">
                  {history?.pending ? <p className="dock-q">{history.pending.question}</p> : null}
                  <span>{error}</span>
                  {history?.pending && !busy ? (
                    <button type="button" className="dock-link" onClick={retry}>
                      Retry
                    </button>
                  ) : null}
                </div>
              ) : null}
              <div ref={listEnd} />
            </div>
          ) : null}
        </Boundary>
      </main>

      {saveFailed ? <p className="dock-warn">{COPY.saveFailed}</p> : null}
      {showRecipes ? (
        <div className="dock-recipes">
          <span className="dock-recipes__label">Suggested recipes</span>
          {recipes!.map((r) => (
            <button
              key={r.id}
              type="button"
              className="dock-chip dock-chip--button"
              title={r.config.description ?? undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void ask(`/${r.slug}`, r)}
            >
              /{r.slug}
            </button>
          ))}
        </div>
      ) : null}
      <form
        className="dock-composer"
        onSubmit={(e) => {
          e.preventDefault()
          const q = input.trim()
          if (q) void ask(q)
        }}
      >
        <input
          className="dock-input"
          value={input}
          placeholder={blocked ? LOCAL_ONLY_COPY.blocked : 'Ask anything'}
          aria-label="Ask anything"
          disabled={blocked || !history}
          onChange={(e) => setInput(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        <button type="submit" className="dock-send" aria-label="Send question" disabled={blocked || busy || !input.trim()}>
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 19V5M6 11l6-6 6 6" />
          </svg>
        </button>
      </form>
    </div>
  )
}

export function MeetingDockRootView(): JSX.Element {
  return <Dock />
}
