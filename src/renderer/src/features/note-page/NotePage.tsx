// SPDX-License-Identifier: Apache-2.0
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import { parseError, type ParsedError } from '@shared/errors'
import { isDemoNote } from '@shared/types/demo'
import type { Note } from '@shared/types/notes'
import type { Panel } from '@shared/types/panels'
import { IconPencil, IconSparkle } from '../../app/icons'
import { navigate, useRoute } from '../../app/navigation'
import { debugLog, isMod, isOwnNote, isTextTarget } from '../../app/platform'
import { showToast } from '../../app/toast'
import { BackButton, SettingsButton, TopBar } from '../../app/TopBar'
import { copyHeaderFor, EditorScopeContext, NotulaEditor, roomIdFor, type EditorHandle } from '../../editor'
import { ActionItemDrafts, ActionItemThumbs } from '../action-items'
import { addNoteImages, AttachedLinks, ImageDropOverlay, isImageFile, NoteImages, useImageDrop } from '../attachments'
import { PrepBriefCard } from '../briefs'
import { NoteAttendees } from '../calendar'
import { MeetingControls, MeetingPrompts, useCaptureState } from '../capture'
import { NoteChatPanel } from '../chat'
import { ConsentNoteStatus, ConsentPendingBanner } from '../consent'
import { DemoNoteBar } from '../demo'
import {
  EnhancedView,
  GenerateButton,
  NotesMenu,
  regenerate,
  TitleField,
  useGenerationEvents,
  usePanels,
  type GenerationEvent
} from '../enhance'
import { FolderSuggestionBar } from '../folders'
import { noteAttendeeLine } from '../home/attendees'
import { NoteShareMenu } from '../integrations'
import { eventStart, formatTime, isAllDay, noteTime } from '../home/grouping'
import { SummaryFeedbackBanner } from '../summary-feedback'
import { TemplateChip } from '../templates'
import { SourceChip } from '../sources'
import { SpeakerNameBanner, TranscriptPanel } from '../transcript'
import { deletePermanently, IconRestore, IconTrash, restoreFromTrash } from '../trash'
import { noteInNavHistory } from './nav-history'
import { NoteActions } from './NoteActions'
import { NotFound } from './NotFound'
import { forgetSelectedPanel, rememberSelectedPanel } from './selected-panel'
import './note-page.css'

/** Auto-switching waits while the user typed this recently. */
const TYPING_GRACE_MS = 20_000
const SCROLL_TOP_DELAY_MS = 200
const LOADING_DELAY_MS = 150

/**
 * The slash menu offers formatting, not templates, so the placeholder names
 * what `/` actually offers.
 */
const NOTES_PLACEHOLDER = 'Write notes, or type / for headings, lists and checkboxes'

type View = 'private' | 'enhanced'

type LoadState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error'; error: ParsedError }
  | { status: 'ready'; note: Note }

/** `/meeting/:id`. */
export function NotePage({ id }: { id: string }): JSX.Element {
  const route = useRoute()
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const request = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const n = ++request.current
    try {
      // A trashed note still opens by id, read-only.
      const note = await window.notula.notes.get({ id, includeDeleted: true })
      if (n !== request.current) return
      if (!note) debugLog('note-page-missing-note', { id })
      setState(note ? { status: 'ready', note } : { status: 'missing' })
    } catch (err) {
      if (n !== request.current) return
      const error = parseError(err)
      setState((prev) =>
        error.code === 'not-found' ? { status: 'missing' } : prev.status === 'ready' ? prev : { status: 'error', error }
      )
    }
  }, [id])

  useEffect(() => {
    setState({ status: 'loading' })
    void load()
  }, [load])

  // The page re-reads its note on store changes.
  useEffect(
    () =>
      window.notula.notes.onChanged((c) => {
        if (c.tables.includes('documents') && c.ids.includes(id)) void load()
      }),
    [id, load]
  )

  useEffect(() => {
    debugLog('document-open', { id, opened_from: route.query.get('opened_from') })
    // Logged once per opened id.
  }, [id])

  // Canonical note per event: a younger duplicate redirects to the oldest.
  const note = state.status === 'ready' ? state.note : null
  const query = route.query.toString()
  useEffect(() => {
    if (!note || !isOwnNote(note) || !note.event_id || note.deleted_at) return
    let cancelled = false
    const start = eventStart(note.linked_event)
    window.notula.notes
      .findByEvent({ eventId: note.event_id, ...(start ? { startTime: start.toISOString() } : {}) })
      .then((canonical) => {
        if (cancelled || !canonical || canonical.id === note.id) return
        navigate(`/meeting/${encodeURIComponent(canonical.id)}${query ? `?${query}` : ''}`, { replace: true })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
    // Only when the note or its event changes.
  }, [note?.id, note?.event_id])

  if (state.status === 'ready') {
    return (
      <div className={`page note-page${state.note.deleted_at ? ' is-trashed' : ''}`}>
        <NoteView key={state.note.id} note={state.note} reveal={route.query.get('reveal')} />
      </div>
    )
  }

  return (
    <div className="page note-page">
      <TopBar left={<BackButton />}>
        <SettingsButton />
      </TopBar>
      <div className="page__scroll">
        {state.status === 'loading' ? (
          <NoteSkeleton />
        ) : state.status === 'missing' ? (
          <NotFound id={id} />
        ) : (
          <div className="note-error" role="alert">
            <p className="note-error__title">
              {state.error.code === 'storage-unavailable' ? 'This note isn’t available yet' : 'Couldn’t open this note'}
            </p>
            <p className="note-error__detail">
              {state.error.code === 'storage-unavailable'
                ? 'Notula is still opening its local storage.'
                : state.error.message || 'Something went wrong.'}
            </p>
            <button type="button" className="n-btn n-btn--sm" onClick={() => void load()}>
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function NoteSkeleton(): JSX.Element {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), LOADING_DELAY_MS)
    return () => clearTimeout(t)
  }, [])
  if (!visible) return <div className="note-column" aria-busy="true" />
  return (
    <div className="note-column note-skeleton" aria-busy="true" aria-label="Loading note">
      <div className="n-skeleton note-skeleton__title" />
      <div className="n-skeleton note-skeleton__meta" />
      <div className="note-skeleton__lines">
        {[92, 78, 85, 60].map((w) => (
          <div key={w} className="n-skeleton note-skeleton__line" style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  )
}

function formatNoteDate(note: Note): string {
  const d = noteTime(note)
  const date = d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {})
  })
  return isAllDay(note) ? date : `${date} · ${formatTime(d)}`
}

/**
 * The note body's width at which the note keeps a readable column between the transcript
 * (up to 400 px) and the chat (340 px beside it): about 480 px of note.
 */
const BOTH_SIDE_PANELS_MIN_WIDTH = 1_220

/** An element's width, kept current by a ResizeObserver; null before the first layout. */
function useWidth(ref: { current: HTMLElement | null }): number | null {
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.getBoundingClientRect().width)
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w !== undefined) setWidth(w)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return width
}

function newest(panels: Panel[]): Panel | null {
  let best: Panel | null = null
  for (const p of panels) if (!best || p.created_at > best.created_at) best = p
  return best
}

function NoteView({ note, reveal: revealQuery }: { note: Note; reveal: string | null }): JSX.Element {
  const own = isOwnNote(note)
  const trashed = note.deleted_at !== null
  const panelsState = usePanels(note.id)
  const panels = useMemo(() => panelsState.panels.filter((p) => !p.deleted_at), [panelsState.panels])
  const latest = panelsState.latest && !panelsState.latest.deleted_at ? panelsState.latest : newest(panels)

  const [view, setView] = useState<View | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  // The palette's "Copy enhanced notes" copies this panel.
  useEffect(() => rememberSelectedPanel(note.id, selected), [note.id, selected])
  useEffect(() => () => forgetSelectedPanel(note.id), [note.id])
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [reveal, setReveal] = useState<{ quote: string; nonce: number } | null>(null)
  // Mount points: the editors note chat and the template chip act on.
  const capture = useCaptureState()
  const [notesEditor, setNotesEditor] = useState<EditorHandle | null>(null)
  const [summaryEditor, setSummaryEditor] = useState<EditorHandle | null>(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [quickEdit, setQuickEdit] = useState<{ selection: string; nonce: number } | null>(null)
  const bodyWidth = useWidth(bodyRef)
  // The transcript and the chat share the side when the note would be squeezed between
  // them: below the width three panes need, opening one closes the other.
  const lastSide = useRef<'chat' | 'transcript' | null>(null)
  useLayoutEffect(() => {
    if (chatOpen) lastSide.current = 'chat'
  }, [chatOpen])
  useLayoutEffect(() => {
    if (transcriptOpen) lastSide.current = 'transcript'
  }, [transcriptOpen])
  useLayoutEffect(() => {
    if (!chatOpen || !transcriptOpen || bodyWidth === null || bodyWidth >= BOTH_SIDE_PANELS_MIN_WIDTH) return
    if (lastSide.current === 'chat') setTranscriptOpen(false)
    else setChatOpen(false)
  }, [chatOpen, transcriptOpen, bodyWidth])

  const viewRef = useRef(view)
  viewRef.current = view
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const noteRef = useRef(note)
  noteRef.current = note
  const initialView = useRef<View | null>(null)
  if (initialView.current === null && view !== null) initialView.current = view

  const editor = useRef<EditorHandle | null>(null)
  const lastTyped = useRef(0)
  const known = useRef<Set<string> | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const seed = useMemo(
    () => ({
      ...(note.notes ? { json: note.notes } : {}),
      ...(note.notes_md ? { markdown: note.notes_md } : {})
    }),
    // The seed only matters when the room is first created.
    []
  )
  // Every editor on the page: read-only in Trash, and the copy header.
  const scope = useMemo(
    () => ({ readOnly: trashed, copyHeader: copyHeaderFor(note) }),
    [trashed, note.title, note.linked_event, note.created_at, note.people]
  )

  const typedRecently = (): boolean => Date.now() - lastTyped.current < TYPING_GRACE_MS

  // Initial view, once the panels are resolved.
  useEffect(() => {
    if (view !== null || panelsState.loading) return
    known.current = new Set(panels.map((p) => p.id))
    setSelected(latest?.id ?? null)
    setView(panels.length === 0 || (own && note.private_notes_visible) ? 'private' : 'enhanced')
  }, [view, panelsState.loading, panels, latest, own, note.private_notes_visible])

  // `?reveal=<quote>` (chat citations): open the transcript and highlight the passage.
  useEffect(() => {
    if (!revealQuery) return
    setTranscriptOpen(true)
    setReveal({ quote: revealQuery, nonce: Date.now() })
  }, [revealQuery])

  // Path A of the empty-note auto-delete: leaving the page
  // hands main the live editor length and whether Back can still reach this note; main
  // re-checks every rule from its own data.
  useEffect(
    () => () => {
      const n = noteRef.current
      if (n.deleted_at || !isOwnNote(n)) return
      const editorTextLength = editor.current?.getTextLength() ?? 0
      window.notula.notes
        .autoDeleteIfEmpty({ id: n.id, path: 'leave', editorTextLength, inNavHistory: noteInNavHistory(n.id) })
        .then((r) => debugLog(r.deleted ? 'empty-note-discarded' : 'auto-delete-kept', { id: n.id, skipped: r.skipped }))
        .catch((err: unknown) => debugLog('auto-delete-failed', { id: n.id, err: parseError(err) }))
    },
    []
  )

  // The user's choice of view is saved on the note for the owner.
  const chooseView = useCallback(
    (next: View, panelId?: string): void => {
      const prev = viewRef.current
      if (panelId) {
        selectedRef.current = panelId
        setSelected(panelId)
      } else if (next === 'enhanced' && !selectedRef.current) {
        if (!latest) return
        selectedRef.current = latest.id
        setSelected(latest.id)
      }
      if (prev === next) return
      setView(next)
      debugLog('notes-view-switched', { from: prev, to: next })
      if (own && !noteRef.current.deleted_at) {
        window.notula.notes
          .update({ id: noteRef.current.id, patch: { private_notes_visible: next === 'private' } })
          .catch((err: unknown) => debugLog('notes-view-save-failed', { err: parseError(err) }))
      }
    },
    [latest, own]
  )

  const selectPanel = useCallback((panelId: string): void => chooseView('enhanced', panelId), [chooseView])

  /** Automatic switches are not saved as the user's choice. */
  const autoEnhanced = useCallback((panelId: string, scrollToTop: boolean): void => {
    setSelected(panelId)
    setView('enhanced')
    if (scrollToTop) {
      setTimeout(() => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' }), SCROLL_TOP_DELAY_MS)
    }
  }, [])

  // Selecting a panel updates its last_opened_at.
  useEffect(() => {
    if (view !== 'enhanced' || !selected || trashed) return
    window.notula.panels
      .update({ id: selected, patch: { last_opened_at: new Date().toISOString() } })
      .catch((err: unknown) => debugLog('panel-viewed-save-failed', { err: parseError(err) }))
  }, [view, selected, trashed])

  // Generation started / finished.
  const onGeneration = useCallback(
    (e: GenerationEvent): void => {
      if (e.type === 'failed') return
      known.current?.add(e.panelId)
      if (e.type === 'started') {
        autoEnhanced(e.panelId, false)
        return
      }
      if (viewRef.current === 'private' && Date.now() - lastTyped.current < TYPING_GRACE_MS) {
        showToast({
          id: 'summary-ready',
          title: 'Your enhanced notes are ready',
          action: { label: 'View now', onClick: () => autoEnhanced(e.panelId, true) }
        })
      } else {
        autoEnhanced(e.panelId, true)
      }
    },
    [autoEnhanced]
  )
  useGenerationEvents(note.id, onGeneration)

  // A panel arriving from elsewhere, or the selected one going away.
  useEffect(() => {
    const seen = known.current
    if (!seen || viewRef.current === null) return
    const ids = panels.map((p) => p.id)
    const added = ids.filter((i) => !seen.has(i))
    for (const i of added) seen.add(i)
    const arrived = added[added.length - 1]
    if (arrived && viewRef.current === 'private') {
      if (typedRecently()) debugLog('view-switch-held-while-typing', { noteId: note.id })
      else autoEnhanced(arrived, false)
      return
    }
    const sel = selectedRef.current
    if (sel && !ids.includes(sel)) {
      if (viewRef.current === 'enhanced') setView('private')
      setSelected(latest?.id ?? null)
    } else if (!sel && latest) {
      setSelected(latest.id)
    }
    // typedRecently reads refs only.
  }, [panels, latest, autoEnhanced, note.id])

  // Shift+Mod+G regenerates the current panel. The find bar claims it first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || !isMod(e) || !e.shiftKey || e.altKey || e.key.toLowerCase() !== 'g') return
      if (noteRef.current.deleted_at) return
      e.preventDefault()
      regenerate(noteRef.current.id, selectedRef.current ?? undefined)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Left / right arrows move between the header's buttons outside text fields.
  const onHeaderKeyDown = (e: ReactKeyboardEvent<HTMLElement>): void => {
    if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || isTextTarget(e.target)) return
    const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled)')).filter(
      (b) => b.offsetParent !== null
    )
    const i = buttons.indexOf(document.activeElement as HTMLElement)
    if (i === -1) return
    const next = buttons[(i + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length]
    if (next) {
      e.preventDefault()
      next.focus()
    }
  }

  const onProjection = useCallback(
    (p: { json: unknown; plain: string; markdown: string }): void => {
      if (!own) return
      window.notula.notes
        .update({ id: noteRef.current.id, patch: { notes: p.json, notes_text: p.plain, notes_md: p.markdown } })
        .catch((err: unknown) => debugLog('notes-projection-save-failed', { err: parseError(err) }))
    },
    [own]
  )

  const getNotesMarkdown = useCallback(
    (): string => editor.current?.getMarkdown() ?? noteRef.current.notes_md ?? '',
    []
  )

  const showInTranscript = useCallback((quote: string): void => {
    setTranscriptOpen(true)
    setReveal({ quote, nonce: Date.now() })
  }, [])

  const selectedPanel = panels.find((p) => p.id === selected) ?? null
  const demo = isDemoNote(note)

  // Images dropped on the page or pasted into an
  // editor go to the note; only the owner's notes outside Trash take them.
  const imagesEditable = own && !trashed
  const addImages = useCallback(
    (files: File[]): void => {
      const images = files.filter(isImageFile)
      if (images.length === 0 && files.length > 0) {
        showToast({ id: 'att-unsupported', kind: 'error', title: 'Unsupported file type', description: 'Use PNG or JPEG images' })
        return
      }
      void addNoteImages(noteRef.current.id, files, noteRef.current.attachments.length)
    },
    []
  )
  const drop = useImageDrop(imagesEditable, addImages)
  const onPasteImages = (e: ReactClipboardEvent<HTMLElement>): void => {
    const data = e.clipboardData
    if (!imagesEditable || !data || data.getData('text/plain') !== '' || data.getData('text/html') !== '') return
    const files = Array.from(data.files).filter(isImageFile)
    if (files.length === 0) return
    e.preventDefault()
    addImages(files)
  }

  return (
    <EditorScopeContext.Provider value={scope}>
      <TopBar left={<BackButton />}>
        {/* Share, left of the "…" menu. */}
        {trashed ? null : <NoteShareMenu noteId={note.id} panelId={selected} />}
        {trashed ? null : (
          <NoteActions
            note={note}
            panels={panels}
            selectedPanel={selectedPanel}
            summaryEditor={view === 'enhanced' ? summaryEditor : null}
          />
        )}
        <SettingsButton />
      </TopBar>
      <div ref={bodyRef} className={`note-body${transcriptOpen ? ' has-transcript' : ''}`}>
        <div className="note-main" {...drop.handlers}>
          <ImageDropOverlay visible={drop.dragging} enabled={imagesEditable} />
          <div className="page__scroll note-scroll" ref={scrollRef}>
            <article className="note-column" onPaste={onPasteImages}>
              {trashed ? <TrashedBanner note={note} /> : null}
              {/* The consent banner while capture waits on the notice, top of the page. */}
              {trashed ? null : <ConsentPendingBanner noteId={note.id} />}
              {/* The speaker-name suggestion banner, top of the page. */}
              {trashed ? null : <SpeakerNameBanner noteId={note.id} />}
              <header className="note-header" onKeyDown={onHeaderKeyDown}>
                {/* The prep brief card, top of the header. */}
                {trashed ? null : <PrepBriefCard noteId={note.id} eventId={note.event_id} />}
                {/* The notice's status line and its actions. */}
                {trashed ? null : <ConsentNoteStatus noteId={note.id} />}
                {trashed ? (
                  <h1 className={`note-trashed-title${note.title ? '' : ' is-untitled'}`}>{note.title || 'New note'}</h1>
                ) : (
                  <TitleField
                    noteId={note.id}
                    readOnly={!own}
                    onEnter={() => {
                      if (viewRef.current === 'private') editor.current?.focus()
                    }}
                  />
                )}
                {/* The date and attendees: the NoteAttendees trigger, or this static line on a
                    trashed note, which has no trigger. */}
                {trashed ? (
                  <p className="note-meta">
                    <span>{formatNoteDate(note)}</span>
                    <span className="note-meta__dot" aria-hidden="true">
                      ·
                    </span>
                    <span>{noteAttendeeLine(note, own)}</span>
                  </p>
                ) : null}
                {trashed ? null : (
                  <>
                    <NoteAttendees noteId={note.id} />
                    <SourceChip noteId={note.id} />
                    <TemplateChip noteId={note.id} hasSummary={panels.length > 0} editor={notesEditor} />
                  </>
                )}
                <div className="note-tabs">
                  <div className="note-tabs__list" role="tablist" aria-label="Notes view">
                    <button
                      type="button"
                      role="tab"
                      className="note-tab"
                      aria-selected={view === 'private'}
                      onClick={() => chooseView('private')}
                    >
                      <IconPencil size={15} />
                      My notes
                    </button>
                    {panels.length > 0 ? (
                      <button
                        type="button"
                        role="tab"
                        className="note-tab"
                        aria-selected={view === 'enhanced'}
                        onClick={() => chooseView('enhanced')}
                      >
                        <IconSparkle size={15} />
                        Enhanced notes
                      </button>
                    ) : null}
                  </div>
                  {trashed ? null : (
                    <div className="note-tabs__menu">
                      <NotesMenu
                        noteId={note.id}
                        selectedPanelId={selected}
                        onSelectPanel={selectPanel}
                        onSwitchToPrivate={() => chooseView('private')}
                      />
                    </div>
                  )}
                </div>
              </header>
              {/* Links from the meeting invite. */}
              <AttachedLinks note={note} editable={imagesEditable} />
              <FolderSuggestionBar noteId={note.id} />

              {view === null ? <div className="note-section note-section--pending" aria-busy="true" /> : null}
              <section className="note-section" role="tabpanel" aria-label="My notes" hidden={view !== 'private'}>
                {view !== null ? (
                  <NotulaEditor
                    roomId={roomIdFor('notes', note.id)}
                    kind="notes"
                    editable={own}
                    placeholder={NOTES_PLACEHOLDER}
                    seed={seed}
                    autofocus={initialView.current === 'private'}
                    onProjection={onProjection}
                    onTyping={() => {
                      lastTyped.current = Date.now()
                    }}
                    onReady={(h) => {
                      editor.current = h
                      setNotesEditor(h)
                    }}
                  />
                ) : null}
              </section>
              {view === 'enhanced' && selectedPanel && trashed ? (
                <section className="note-section" role="tabpanel" aria-label="Enhanced notes">
                  <TrashedPanel panel={selectedPanel} />
                </section>
              ) : view === 'enhanced' && selected && !trashed ? (
                <section className="note-section" role="tabpanel" aria-label="Enhanced notes">
                  {/* Thumbs and draft buttons on summary lines that state action items. */}
                  <ActionItemThumbs noteId={note.id} />
                  <ActionItemDrafts noteId={note.id} />
                  <EnhancedView
                    noteId={note.id}
                    panelId={selected}
                    onShowInTranscript={showInTranscript}
                    onSelectPanel={selectPanel}
                    onEditorReady={setSummaryEditor}
                    onQuickEdit={(selection) => {
                      setQuickEdit({ selection, nonce: Date.now() })
                      setChatOpen(true)
                    }}
                  />
                </section>
              ) : null}
              {/* The note's images. */}
              {view !== null ? <NoteImages noteId={note.id} attachments={note.attachments} editable={imagesEditable} /> : null}
            </article>
          </div>
          {trashed ? null : (
            <>
              {/* The rating banner in the bottom zone; idle while the note chat is closed. */}
              <SummaryFeedbackBanner noteId={note.id} chatIdle={!chatOpen} />
              <MeetingPrompts noteId={note.id} />
              <div className="note-dock">
                <div className="note-dock__center">
                  {/* A demo note never captures; its bar replaces MeetingControls. */}
                  {demo ? (
                    <DemoNoteBar noteId={note.id} />
                  ) : own ? (
                    <MeetingControls
                      noteId={note.id}
                      transcriptOpen={transcriptOpen}
                      onToggleTranscript={() => setTranscriptOpen((o) => !o)}
                    />
                  ) : null}
                  <GenerateButton noteId={note.id} getNotesMarkdown={getNotesMarkdown} />
                </div>
                {/* The note chat's launcher: beside the controls, never over them. */}
                <div className="note-dock__end" />

              </div>
            </>
          )}
        </div>
        {transcriptOpen ? (
          <aside className="note-transcript" aria-label="Transcript">
            <TranscriptPanel noteId={note.id} reveal={reveal} onClose={() => setTranscriptOpen(false)} />
          </aside>
        ) : null}
        {trashed ? null : (
          <NoteChatPanel
            noteId={note.id}
            target={
              view === 'enhanced' && selected && summaryEditor
                ? { kind: 'summary', panelId: selected, editor: summaryEditor }
                : view === 'private' && notesEditor
                  ? { kind: 'notes', editor: notesEditor }
                  : null
            }
            transcribing={capture.transcribingNoteId === note.id}
            open={chatOpen}
            onOpenChange={setChatOpen}
            quickEdit={quickEdit}
            onOpenPanel={selectPanel}
            onShowInTranscript={showInTranscript}
          />
        )}
      </div>
    </EditorScopeContext.Provider>
  )
}

/**
 * A trashed note: an "In Trash" header in place of the
 * usual controls, read-only editors, and Restore / Delete permanently.
 */
function TrashedBanner({ note }: { note: Note }): JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <div className="note-trashed" role="status">
      <span className="note-trashed__badge">
        <IconTrash size={15} />
        In Trash
      </span>
      <span className="note-trashed__text">This note is read-only until you restore it.</span>
      <span className="note-trashed__actions">
        <button
          type="button"
          className="n-btn n-btn--sm"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void restoreFromTrash(note.id).finally(() => setBusy(false))
          }}
        >
          <IconRestore size={14} />
          Restore
        </button>
        <button
          type="button"
          className="n-btn n-btn--sm note-trashed__delete"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void deletePermanently(note.id)
              .then((deleted) => {
                if (deleted) navigate('/')
              })
              .finally(() => setBusy(false))
          }}
        >
          Delete permanently
        </button>
      </span>
    </div>
  )
}

/** A trashed note's panel, read-only. EnhancedView is not mounted: it would generate on open. */
function TrashedPanel({ panel }: { panel: Panel }): JSX.Element {
  const seed = useMemo(
    () => {
      const markdown = panel.content_markdown ?? panel.generated_content ?? undefined
      return { ...(panel.content ? { json: panel.content } : {}), ...(markdown ? { markdown } : {}) }
    },
    // The seed only matters when the panel's room is first created.
    [panel.id]
  )
  return (
    <div className="enh-view enh-view--completed">
      <NotulaEditor roomId={roomIdFor('summary', panel.id)} kind="panel" editable={false} seed={seed} autofocus={false} />
    </div>
  )
}
