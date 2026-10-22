// SPDX-License-Identifier: Apache-2.0
// EnhancedView: one panel's
// enhanced notes in its current state.
// - generating: the progress label and the complete lines streamed so far, following
//   the new text while the user stays near the bottom;
// - completed: the editable panel editor on the panel's Yjs room, seeded from the
//   generated markdown; its projection saves through `panels:update`;
// - failed (or timed out): the failure copy and, for the owner, a retry into the panel;
// - idle: generates into this panel on open, for the owner.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from 'react'
import { parseError } from '@shared/errors'
import { BLANK_TEMPLATE_SLUG, type EnhanceErrorCode } from '@shared/types/enhance'
import type { Panel } from '@shared/types/panels'
import { IconAlert } from '../../app/icons'
import { navigate } from '../../app/navigation'
import { debugLog, isOwnNote } from '../../app/platform'
import { showToast } from '../../app/toast'
import { NotulaEditor, roomIdFor, type EditorHandle } from '../../editor'
import { findTurnForQuote, groupTurns } from '../transcript/turns'
import { useLiveTranscript } from '../transcript/live-transcript'
import { IconTranscript } from './icons'
import { liveNotesMarkdown } from './regenerate'
import { StreamingNotes } from './StreamingNotes'
import { useGeneration, useNote, usePanelsSnapshot, type Generation } from './store'
import './enhance.css'

export interface EnhancedViewProps {
  noteId: string
  panelId: string
  onShowInTranscript(quote: string): void
  /** Shows another panel; the failure state uses it to go back to the previous notes. */
  onSelectPanel?(panelId: string): void
  /** The panel editor's handle, for note chat; null when it goes away. */
  onEditorReady?(h: EditorHandle | null): void
  /** The panel editor's "Quick edit" (toolbar and Mod+J). */
  onQuickEdit?(selectionMarkdown: string): void
}

/** A stored "generating" older than this counts as failed. */
const WATCHDOG_MS = 180_000
/** Follow only near the bottom and not right after a wheel scroll. */
const FOLLOW_DISTANCE_PX = 100
const WHEEL_PAUSE_MS = 500
/** Plain notes longer than this make it "Enhancing" rather than "Writing". */
const NOTES_CHARS_THRESHOLD = 20

type ViewState = 'generating' | 'completed' | 'failed' | 'idle'

function storedState(p: Panel, now: number): ViewState {
  const started = p.enhance_started_at ?? ''
  const failed = p.enhance_failed_at ?? ''
  if (p.content_edited_at && p.content_edited_at >= started && p.content_edited_at >= failed) return 'completed'
  if (p.enhance_failed_at && p.enhance_failed_at >= started) return 'failed'
  if (p.enhance_started_at) return now - Date.parse(p.enhance_started_at) < WATCHDOG_MS ? 'generating' : 'failed'
  return 'idle'
}

function viewState(panel: Panel, gen: Generation | null): ViewState {
  if (gen?.status === 'generating') return 'generating'
  if (gen?.status === 'done') return 'completed'
  if (gen?.status === 'failed') return 'failed'
  return storedState(panel, Date.now())
}

/** Plain text length of markdown notes: markers and extra spaces do not count. */
export function plainLength(markdown: string | null | undefined): number {
  if (!markdown) return 0
  return markdown
    .split('\n')
    .map((l) => l.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '').trim())
    .join(' ')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim().length
}

/** Copy for the failure's cause, shown under the generic failure line. */
function failureHint(code: EnhanceErrorCode | null, message: string | null): { text: string; settings: boolean } | null {
  switch (code) {
    case 'missing-key':
      return { text: 'Add an API key for your AI provider in Settings.', settings: true }
    case 'no-model':
      return { text: 'Choose an AI model in Settings.', settings: true }
    case 'refusal':
      return { text: 'The AI model declined to write notes for this meeting.', settings: false }
    case 'timeout':
      return { text: 'The AI provider stopped responding.', settings: false }
    case 'empty-response':
      return { text: 'The AI model returned no notes.', settings: false }
    case 'interrupted':
      return { text: 'Notula closed before these notes were finished.', settings: false }
    case 'unknown-template':
    case 'blank-template':
      return { text: 'This template can’t be used to generate notes.', settings: false }
    case 'provider-error':
      return { text: message || 'The AI provider returned an error.', settings: false }
    default:
      return null
  }
}

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY
    if (o === 'auto' || o === 'scroll') return p
  }
  return null
}

export function EnhancedView(props: EnhancedViewProps): JSX.Element {
  // Keyed: a different panel is a fresh view with its own one-shot behaviours.
  return <PanelView key={props.panelId} {...props} />
}

/**
 * The newest completed panel this one superseded: same template and title (the
 * notes menu's grouping), created before it.
 */
function previousCompleted(panels: Panel[], panel: Panel): Panel | null {
  const key = (p: Panel): string => `${(p.template_key ?? '').toLowerCase()}\u0000${p.title}`
  const now = Date.now()
  let best: Panel | null = null
  for (const p of panels) {
    if (p.id === panel.id || key(p) !== key(panel) || p.created_at > panel.created_at) continue
    if (storedState(p, now) !== 'completed') continue
    if (!best || p.created_at > best.created_at) best = p
  }
  return best
}

/** Lines shorter than this never point back into the transcript. */
const REVEAL_MIN_CHARS = 12

/**
 * "Show in transcript". The summary prompt rules out block quotes,
 * so a passage counts as quoted when the transcript backs it: the same match the
 * transcript panel uses to find the turn (findTurnForQuote). Hovering such a line
 * shows a button in the right margin that opens the panel on that turn.
 */
function RevealHost({
  noteId,
  onShowInTranscript,
  children
}: {
  noteId: string
  onShowInTranscript(quote: string): void
  children: ReactNode
}): JSX.Element {
  const { chunks } = useLiveTranscript(noteId)
  const turns = useMemo(() => groupTurns(chunks), [chunks])
  const hostRef = useRef<HTMLDivElement>(null)
  const [target, setTarget] = useState<{ top: number; text: string } | null>(null)
  const backed = useRef(new Map<string, boolean>())
  useEffect(() => {
    backed.current.clear()
  }, [turns])

  const onMove = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const host = hostRef.current
    const el = e.target as HTMLElement
    if (!host || !turns.length || el.closest('.enh-reveal')) return
    const editor = host.querySelector('.ProseMirror')
    const line = el.closest('p')
    if (!line || !editor?.contains(line)) {
      // On the way to the button in the margin, keep it.
      if (!editor || e.clientX <= editor.getBoundingClientRect().right) setTarget(null)
      return
    }
    const text = (line.textContent ?? '').trim()
    let ok = backed.current.get(text)
    if (ok === undefined) {
      ok = text.length >= REVEAL_MIN_CHARS && findTurnForQuote(turns, text) >= 0
      backed.current.set(text, ok)
    }
    if (!ok) {
      setTarget(null)
      return
    }
    const top = Math.round(line.getBoundingClientRect().top - host.getBoundingClientRect().top)
    setTarget((t) => (t && t.top === top && t.text === text ? t : { top, text }))
  }

  return (
    <div className="enh-reveal-host" ref={hostRef} onMouseMove={onMove} onMouseLeave={() => setTarget(null)}>
      {children}
      {target ? (
        <span className="n-tooltip n-tooltip--end enh-reveal" style={{ top: target.top }} data-tooltip="Show in transcript">
          <button
            type="button"
            className="n-icon-btn n-icon-btn--sm"
            aria-label="Show in transcript"
            onClick={() => onShowInTranscript(target.text)}
          >
            <IconTranscript size={15} />
          </button>
        </span>
      ) : null}
    </div>
  )
}

/** The panel editor's hooks: the handle (null once the editor goes away) and Quick edit. */
interface EditorHooks {
  onEditorReady?(h: EditorHandle | null): void
  onQuickEdit?(selectionMarkdown: string): void
}

/** Reports the handle while the editor lives, and null when it unmounts. */
function useEditorReady(onEditorReady: EditorHooks['onEditorReady']): (h: EditorHandle) => void {
  const cb = useRef(onEditorReady)
  cb.current = onEditorReady
  const reported = useRef(false)
  useEffect(
    () => () => {
      if (reported.current) cb.current?.(null)
    },
    []
  )
  return useCallback((h: EditorHandle) => {
    reported.current = true
    cb.current?.(h)
  }, [])
}

function PanelView({ noteId, panelId, onSelectPanel, onShowInTranscript, onEditorReady, onQuickEdit }: EnhancedViewProps): JSX.Element {
  const { panels, loading } = usePanelsSnapshot(noteId)
  const panel = panels.find((p) => p.id === panelId) ?? null
  const gen = useGeneration(panelId)
  const note = useNote(noteId)
  const own = note ? isOwnNote(note) : false

  const hooks: EditorHooks = {
    ...(onEditorReady ? { onEditorReady } : {}),
    ...(onQuickEdit ? { onQuickEdit } : {})
  }

  if (!panel) {
    if (gen?.status === 'generating') return <Streaming noteId={noteId} gen={gen} />
    return <div className="enh-view enh-view--empty" aria-busy={loading} />
  }
  const state = viewState(panel, gen)
  if (state === 'generating') return <Streaming noteId={noteId} gen={gen} />
  if (state === 'completed') {
    return (
      <RevealHost noteId={noteId} onShowInTranscript={onShowInTranscript}>
        <Completed panel={panel} gen={gen} own={own} {...hooks} />
      </RevealHost>
    )
  }
  if (state === 'failed') {
    const previous = onSelectPanel ? previousCompleted(panels, panel) : null
    return (
      <Failed
        noteId={noteId}
        panel={panel}
        gen={gen}
        own={own}
        {...(previous && onSelectPanel ? { onShowPrevious: () => onSelectPanel(previous.id) } : {})}
      />
    )
  }
  return <Idle noteId={noteId} panel={panel} own={own} {...hooks} />
}

function Streaming({ noteId, gen }: { noteId: string; gen: Generation | null }): JSX.Element {
  const note = useNote(noteId)
  const rootRef = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const lastWheel = useRef(0)
  const text = gen?.text ?? ''
  const hasText = text.trim().length > 0
  const notesChars = Math.max(plainLength(liveNotesMarkdown(noteId)), note?.notes_text?.trim().length ?? 0)
  const label = !hasText ? 'Analyzing transcript' : notesChars > NOTES_CHARS_THRESHOLD ? 'Enhancing notes' : 'Writing notes'

  useEffect(() => {
    const scroller = scrollParent(rootRef.current)
    if (!scroller) return
    const onScroll = (): void => {
      follow.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= FOLLOW_DISTANCE_PX
    }
    const onWheel = (): void => {
      lastWheel.current = Date.now()
    }
    onScroll()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    scroller.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      scroller.removeEventListener('wheel', onWheel)
    }
  }, [])

  // New complete lines: keep the end in view when the user is following.
  const completeLength = text.lastIndexOf('\n')
  useLayoutEffect(() => {
    const scroller = scrollParent(rootRef.current)
    if (!scroller || !follow.current || Date.now() - lastWheel.current < WHEEL_PAUSE_MS) return
    scroller.scrollTop = scroller.scrollHeight
  }, [completeLength])

  return (
    <div className="enh-view enh-view--generating" ref={rootRef} aria-busy="true">
      <div className="enh-progress" role="status">
        <span className="enh-progress__spark" aria-hidden="true" />
        <span className="enh-progress__label">{label}</span>
      </div>
      {hasText ? <StreamingNotes text={text} lines={gen?.lines ?? null} /> : <ProgressSkeleton />}
    </div>
  )
}

function ProgressSkeleton(): JSX.Element {
  return (
    <div className="enh-skeleton" aria-hidden="true">
      {[38, 92, 84, 70, 0, 44, 88, 76].map((w, i) =>
        w === 0 ? <div key={i} className="enh-skeleton__gap" /> : <div key={i} className="n-skeleton enh-skeleton__line" style={{ width: `${w}%` }} />
      )}
    </div>
  )
}

function Completed({
  panel,
  gen,
  own,
  onEditorReady,
  onQuickEdit
}: { panel: Panel; gen: Generation | null; own: boolean } & EditorHooks): JSX.Element {
  const onReady = useEditorReady(onEditorReady)
  // Only a generation that just finished in this view takes focus, and only when
  // nothing else has it.
  const justDone = useRef(gen?.status === 'done' && (document.activeElement === null || document.activeElement === document.body))
  const seed = useMemo(
    () => {
      const markdown = panel.content_markdown ?? gen?.final ?? panel.generated_content ?? undefined
      return {
        ...(panel.content ? { json: panel.content } : {}),
        ...(markdown ? { markdown } : {})
      }
    },
    // The seed only matters when the panel's room is first created.
    [panel.id]
  )

  const onProjection = useCallback(
    (p: { json: unknown; plain: string; markdown: string }): void => {
      if (!own) return
      window.notula.panels
        .update({ id: panel.id, patch: { content: p.json, content_markdown: p.markdown } })
        .catch((err: unknown) => debugLog('panel-projection-save-failed', { panelId: panel.id, err: parseError(err) }))
    },
    [own, panel.id]
  )

  return (
    <div className="enh-view enh-view--completed">
      <NotulaEditor
        roomId={roomIdFor('summary', panel.id)}
        kind="panel"
        editable={own}
        seed={seed}
        autofocus={justDone.current && own}
        onProjection={onProjection}
        onReady={onReady}
        {...(own && onQuickEdit ? { onQuickEdit } : {})}
      />
    </div>
  )
}

/**
 * A failed generation. A failed regeneration keeps the notes it was replacing, and
 * "View previous notes" goes back to them, so a provider outage never
 * makes a good summary look lost.
 */
function Failed({
  noteId,
  panel,
  gen,
  own,
  onShowPrevious
}: {
  noteId: string
  panel: Panel
  gen: Generation | null
  own: boolean
  onShowPrevious?(): void
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const code = gen?.error?.code ?? panel.enhance_error ?? (panel.enhance_failed_at ? null : 'timeout')
  const hint = failureHint(code, gen?.error?.message ?? null)

  const retry = (): void => {
    if (busy) return
    setBusy(true)
    const md = liveNotesMarkdown(noteId)
    window.notula.enhance
      .generate({ noteId, panelId: panel.id, ...(md ? { notesMarkdown: md } : {}) })
      .catch((err: unknown) => {
        showToast({ kind: 'error', title: 'Couldn’t retry', description: parseError(err).message })
      })
      .finally(() => setBusy(false))
  }

  return (
    <div className="enh-view enh-view--failed">
      <div className="enh-failed" role="alert">
        <span className="enh-failed__icon" aria-hidden="true">
          <IconAlert size={18} />
        </span>
        <p className="enh-failed__title">Couldn’t enhance notes</p>
        <p className="enh-failed__body">Your notes and transcript are safe. Try again.</p>
        {onShowPrevious ? <p className="enh-failed__body">Your previous enhanced notes are kept too.</p> : null}
        {hint ? <p className="enh-failed__hint">{hint.text}</p> : null}
        {own || onShowPrevious ? (
          <div className="enh-failed__actions">
            {own ? (
              <button type="button" className="n-btn n-btn--primary n-btn--sm" onClick={retry} disabled={busy}>
                Retry generating notes
              </button>
            ) : null}
            {onShowPrevious ? (
              <button type="button" className="n-btn n-btn--sm" onClick={onShowPrevious}>
                View previous notes
              </button>
            ) : null}
            {own && hint?.settings ? (
              <button type="button" className="n-btn n-btn--sm" onClick={() => navigate('/settings')}>
                Open Settings
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function Idle({
  noteId,
  panel,
  own,
  onEditorReady,
  onQuickEdit
}: { noteId: string; panel: Panel; own: boolean } & EditorHooks): JSX.Element {
  const tried = useRef(false)
  const onReady = useEditorReady(onEditorReady)
  const blank = (panel.template_key ?? '').toLowerCase() === BLANK_TEMPLATE_SLUG

  useEffect(() => {
    if (tried.current || !own || blank) return
    tried.current = true
    const md = liveNotesMarkdown(noteId)
    window.notula.enhance
      .generate({ noteId, panelId: panel.id, ...(md ? { notesMarkdown: md } : {}) })
      .catch((err: unknown) => debugLog('panel-open-generate-failed', { panelId: panel.id, err: parseError(err) }))
  }, [own, blank, noteId, panel.id])

  if (blank || !own) {
    return (
      <div className="enh-view enh-view--completed">
        <NotulaEditor
          roomId={roomIdFor('summary', panel.id)}
          kind="panel"
          editable={own}
          autofocus={false}
          onReady={onReady}
          {...(own && onQuickEdit ? { onQuickEdit } : {})}
        />
      </div>
    )
  }
  return (
    <div className="enh-view enh-view--generating" aria-busy="true">
      <div className="enh-progress" role="status">
        <span className="enh-progress__spark" aria-hidden="true" />
        <span className="enh-progress__label">Analyzing transcript</span>
      </div>
      <ProgressSkeleton />
    </div>
  )
}
