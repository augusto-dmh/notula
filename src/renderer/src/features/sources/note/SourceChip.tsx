// SPDX-License-Identifier: Apache-2.0
// The note header's source chip: the source title (opens the original), the
// channel, the series and lesson breadcrumb, the confidence, Change source, and a menu with Edit
// details and Unlink source. A guess whose key another note shares asks "Same as <note>?".
// A note without a source shows Link source. Nothing renders while
// `sources.enabled` is off, off Windows, or before `sources:get-for-note` has a handler.
// While mounted with a source, it registers the note as the window's active source note, which
// the editor's stamping plugin binds to.

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { NoteSourceView } from '@shared/types/sources'
import { IconChevronDown } from '../../../app/icons'
import { navigate, navigateToSettings } from '../../../app/navigation'
import { isMac } from '../../../app/platform'
import { IconPlay } from '../../settings/icons'
import { usePrefs } from '../../settings/prefs-store'
import { LinkSourceDialog, type LinkDialogMode } from './LinkSourceDialog'
import { clearActiveSource, setActiveSource, trySources } from './source-store'
import './sources-note.css'

type Loaded = { available: false } | { available: true; view: NoteSourceView | null }

function lessonText(view: NoteSourceView): string | null {
  const s = view.source
  if (s.lesson_label) return s.lesson_label
  if (s.lesson_number !== null) return `Lesson ${s.lesson_number}`
  // A series item without a number yet.
  return view.series && view.series.kind !== 'channel' && s.lesson_state === 'pending' ? '—' : null
}

function confidenceText(view: NoteSourceView): string | null {
  switch (view.source.confidence) {
    case 'exact':
      return null
    case 'high':
      return 'Likely match'
    case 'guess':
      return 'Not sure which video'
  }
}

function useNoteSource(noteId: string, enabled: boolean): [Loaded | null, () => void] {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const seq = useRef(0)
  const load = useCallback((): void => {
    const mine = ++seq.current
    void (async () => {
      let ok = true
      const view = await trySources('sources:get-for-note-failed', async () => {
        try {
          return await window.notula.sources.getForNote({ noteId })
        } catch (err) {
          ok = false
          throw err
        }
      })
      if (mine !== seq.current) return
      setLoaded(ok ? { available: true, view } : { available: false })
    })()
  }, [noteId])

  useEffect(() => {
    if (!enabled) {
      setLoaded(null)
      return
    }
    load()
    return window.notula.sources.onChanged(({ noteIds }) => {
      if (noteIds.includes(noteId)) load()
    })
  }, [enabled, noteId, load])

  return [loaded, load]
}

/** The guess's "Same as <note>?" line, once per note until answered. */
function SameAsPrompt({ noteId, otherId }: { noteId: string; otherId: string }): JSX.Element | null {
  const [title, setTitle] = useState<string | null>(null)
  const [gone, setGone] = useState(false)
  const [answered, setAnswered] = useState(false)
  useEffect(() => {
    let alive = true
    void window.notula.notes
      .get({ id: otherId })
      .then((n) => {
        if (!alive) return
        if (!n || n.deleted_at) setGone(true)
        else setTitle(n.title || 'Untitled note')
      })
      .catch(() => alive && setGone(true))
    return () => {
      alive = false
    }
  }, [otherId])
  if (gone || answered || title === null) return null
  const dismiss = (): void => {
    setAnswered(true)
    void trySources('sources:dismiss-hint-failed', () => window.notula.sources.dismissHint({ hint: 'same-as', key: noteId }))
  }
  return (
    <div className="src-same" role="group" aria-label="Possible duplicate">
      <span className="src-same__text">Same as “{title}”?</span>
      <button
        type="button"
        className="n-btn n-btn--sm"
        onClick={() => {
          dismiss()
          navigate(`/meeting/${encodeURIComponent(otherId)}?opened_from=source_linked`)
        }}
      >
        Open that note
      </button>
      <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={dismiss}>
        Keep separate
      </button>
    </div>
  )
}

export function SourceChipView({ noteId }: { noteId: string }): JSX.Element | null {
  const prefs = usePrefs()
  const enabled = !isMac && prefs?.['sources.enabled'] === true
  const [loaded, reload] = useNoteSource(noteId, enabled)
  const [dialog, setDialog] = useState<LinkDialogMode | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const view = loaded?.available ? loaded.view : null
  const source = view?.source ?? null

  // The window's active source note, for stamps, Ctrl+Alt+T, marks and the stamped projection.
  useEffect(() => {
    if (!enabled || !source) {
      clearActiveSource(noteId)
      return
    }
    setActiveSource({ noteId, canonicalKey: source.canonical_key, url: source.url, stamped: source.notes_md_stamped })
  }, [enabled, noteId, source])
  useEffect(() => () => clearActiveSource(noteId), [noteId])

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  if (!enabled || !loaded || !loaded.available) return null

  const dialogEl = dialog ? (
    <LinkSourceDialog
      noteId={noteId}
      current={view}
      mode={dialog}
      onClose={() => setDialog(null)}
      onDone={() => {
        setDialog(null)
        reload()
      }}
    />
  ) : null

  if (!view || !source) {
    return (
      <div className="src-chip">
        <button type="button" className="src-chip__link" onClick={() => setDialog('link')}>
          <IconPlay size={14} />
          Link source
        </button>
        {dialogEl}
      </div>
    )
  }

  const lesson = lessonText(view)
  const confidence = confidenceText(view)
  const seriesTitle = view.series && view.series.kind !== 'channel' ? view.series.title : null
  const sameAs =
    source.confidence === 'guess' &&
    view.sameKeyNoteIds[0] &&
    !(prefs?.['sources.dismissedHints'] ?? []).includes(`same-as:${noteId}`)
      ? view.sameKeyNoteIds[0]
      : null
  const percent = view.watched.percent
  const openOriginal = (): void => {
    if (source.url) window.open(source.url, '_blank', 'noopener')
  }

  return (
    <div className="src-chip" ref={rootRef}>
      <div className="src-chip__row">
        <IconPlay size={14} className="src-chip__icon" />
        {source.url ? (
          <button type="button" className="src-chip__title" title={`Open original: ${source.title}`} onClick={openOriginal}>
            {source.title}
          </button>
        ) : (
          <span className="src-chip__title src-chip__title--static">{source.title}</span>
        )}
        {source.channel ? <span className="src-chip__meta">{source.channel}</span> : null}
        {seriesTitle || lesson ? (
          <span className="src-chip__meta src-chip__crumb">
            {seriesTitle ? <span className="src-chip__series">{seriesTitle}</span> : null}
            {seriesTitle && lesson ? <span aria-hidden="true"> › </span> : null}
            {lesson ? (
              <span title={source.lesson_state === 'guessed' ? 'Number guessed from the title' : undefined}>
                {lesson}
                {source.lesson_state === 'guessed' ? '?' : ''}
              </span>
            ) : null}
          </span>
        ) : null}
        {percent !== null ? <span className="src-chip__meta">{Math.round(percent)}% watched</span> : null}
        {confidence ? <span className={`src-chip__badge src-chip__badge--${source.confidence}`}>{confidence}</span> : null}
        {source.confidence !== 'exact' ? (
          <button type="button" className="src-chip__action" onClick={() => setDialog('link')}>
            Change source
          </button>
        ) : null}
        <span className="src-chip__more-wrap">
          <button
            type="button"
            className={`src-chip__more${menuOpen ? ' is-open' : ''}`}
            aria-label="Source actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <IconChevronDown size={14} />
          </button>
          {menuOpen ? (
            <div className="src-menu" role="menu">
              {source.url ? (
                <button type="button" role="menuitem" className="src-menu__item" onClick={() => (setMenuOpen(false), openOriginal())}>
                  Open original
                </button>
              ) : null}
              <button type="button" role="menuitem" className="src-menu__item" onClick={() => (setMenuOpen(false), setDialog('link'))}>
                Change source…
              </button>
              <button type="button" role="menuitem" className="src-menu__item" onClick={() => (setMenuOpen(false), setDialog('edit'))}>
                Edit details…
              </button>
              <div className="src-menu__divider" role="separator" />
              <button type="button" role="menuitem" className="src-menu__item" onClick={() => (setMenuOpen(false), setDialog('unlink'))}>
                Unlink source…
              </button>
              <button
                type="button"
                role="menuitem"
                className="src-menu__item"
                onClick={() => {
                  setMenuOpen(false)
                  navigateToSettings('sources')
                }}
              >
                Source settings
              </button>
            </div>
          ) : null}
        </span>
      </div>
      {sameAs ? <SameAsPrompt noteId={noteId} otherId={sameAs} /> : null}
      {dialogEl}
    </div>
  )
}
