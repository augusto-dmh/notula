// SPDX-License-Identifier: Apache-2.0
// The "Note templates" gallery: a modal dialog
// with the template list on the left (resizable: 240 px by default, 200 px to the
// smaller of 420 px and the dialog width minus 360 px, arrow keys in 24 px steps) and
// the selected template's editor on the right. Opened from the sidebar ("manage", no
// Apply button) or from a note ("apply"), where it opens on the note's current
// template and offers "Apply template".

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import { parseError } from '@shared/errors'
import type { NoteTemplate, TemplateSection } from '@shared/types/templates'
import { IconClose, IconPlus, IconSearch } from '../../app/icons'
import { debugLog } from '../../app/platform'
import { showToast } from '../../app/toast'
import { usePrefs } from '../settings/prefs-store'
import { isNoteGenerating } from '../enhance/store'
import type { TemplateGalleryOptions } from './index'
import { applyFromGallery } from './apply'
import { confirmDialog } from './confirm'
import { DEFAULT_TEMPLATE_ICON, TemplateIconView } from './icons'
import { displayTitle, galleryGroups, isEditable, searchTemplates } from './order'
import {
  favoriteIds,
  putLocalTemplate,
  removeLocalTemplate,
  setFavorite,
  temporaryTemplateId,
  useFavoriteIds,
  useTemplates
} from './store'
import { TemplateEditor } from './TemplateEditor'
import './templates.css'

const LIST_DEFAULT = 240
const LIST_MIN = 200
const LIST_MAX = 420
const EDITOR_MIN = 360
const LIST_STEP = 24
const INTRODUCTION: TemplateSection = {
  id: '',
  heading: 'Overview',
  section_hint: 'The purpose of the meeting and its main outcomes, in a few bullets.'
}

// ---------- open state ----------

let current: { opts: TemplateGalleryOptions; nonce: number } | null = null
let nonce = 0
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

export function openGallery(opts: TemplateGalleryOptions): void {
  // Never while the note is generating.
  if (opts.mode === 'apply' && isNoteGenerating(opts.noteId)) {
    debugLog('template-gallery-blocked-generating', { noteId: opts.noteId })
    return
  }
  current = { opts, nonce: ++nonce }
  emit()
}

function closeGallery(): void {
  current = null
  emit()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function GalleryHost(): JSX.Element | null {
  const state = useSyncExternalStore(subscribe, () => current)
  if (!state) return null
  return <Gallery key={state.nonce} opts={state.opts} onClose={closeGallery} />
}

// ---------- the dialog ----------

function newSections(fromList: boolean): TemplateSection[] {
  // The list button adds the Introduction section; elsewhere two empty ones.
  const empty = (): TemplateSection => ({ id: crypto.randomUUID(), heading: '', section_hint: '' })
  return fromList ? [{ ...INTRODUCTION, id: crypto.randomUUID() }, empty()] : [empty(), empty()]
}

function Gallery({ opts, onClose }: { opts: TemplateGalleryOptions; onClose(): void }): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { templates, loading } = useTemplates()
  const favorites = useFavoriteIds()
  const prefs = usePrefs()
  const ownerName = prefs?.['profile.name'] ?? ''
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    opts.mode === 'apply' ? temporaryTemplateId(opts.noteId) : null
  )
  const [listWidth, setListWidth] = useState(LIST_DEFAULT)
  const [busy, setBusy] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const created = useRef(false)

  useEffect(() => {
    const d = dialogRef.current
    if (d && !d.open) d.showModal()
  }, [])

  const groups = useMemo(() => galleryGroups(templates, favorites), [templates, favorites])
  const flat = useMemo(() => groups.flatMap((g) => g.templates), [groups])
  const results = useMemo(() => (query.trim() ? searchTemplates(flat, query) : null), [flat, query])
  const visible = results ?? flat
  const selected = templates.find((t) => t.id === selectedId) ?? null

  // The note's current template, else the first in the list.
  useEffect(() => {
    if (loading || selected) return
    const first = flat[0]
    if (first) setSelectedId(first.id)
  }, [loading, selected, flat])

  const createTemplate = useCallback(
    async (fromList: boolean): Promise<void> => {
      try {
        const t = await window.notula.templates.create({
          title: 'Untitled template',
          description: '',
          sections: newSections(fromList),
          category: null,
          icon: DEFAULT_TEMPLATE_ICON,
          copied_from: null
        })
        putLocalTemplate(t, { pending: false })
        setQuery('')
        setSelectedId(t.id)
      } catch (err) {
        showToast({ kind: 'error', title: 'Couldn’t create template', description: parseError(err).message })
      }
    },
    []
  )

  // "New template" from the chip or the notes menu.
  useEffect(() => {
    if (opts.mode !== 'apply' || !opts.createNew || created.current) return
    created.current = true
    void createTemplate(false)
  }, [opts, createTemplate])

  /** Duplicate and "Edit a copy". */
  const duplicate = async (t: NoteTemplate): Promise<void> => {
    try {
      const copy = await window.notula.templates.create({
        title: `${displayTitle(t)} (Copy)`,
        description: t.description,
        sections: t.sections.map((s) => ({ ...s, id: crypto.randomUUID() })),
        category: null,
        icon: t.icon,
        copied_from: t.id
      })
      putLocalTemplate(copy, { pending: false })
      if (!isEditable(t) && favoriteIds().includes(t.id)) setFavorite(t.id, false)
      setQuery('')
      setSelectedId(copy.id)
    } catch (err) {
      showToast({ kind: 'error', title: 'Couldn’t copy template', description: parseError(err).message })
    }
  }

  /** Confirmed soft delete; the selection moves to a neighbour. */
  const remove = async (t: NoteTemplate): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Delete template',
      body: `Delete “${t.title.trim() || 'Untitled'}”? This can't be undone.`,
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    const i = visible.findIndex((x) => x.id === t.id)
    const neighbour = i > 0 ? visible[i - 1] : visible[i + 1]
    try {
      await window.notula.templates.delete({ id: t.id })
      removeLocalTemplate(t.id)
      setSelectedId(neighbour?.id ?? null)
    } catch (err) {
      showToast({ kind: 'error', title: 'Couldn’t delete template', description: parseError(err).message })
    }
  }

  const apply = async (): Promise<void> => {
    if (opts.mode !== 'apply' || !selected || busy) return
    setBusy(true)
    const outcome = await applyFromGallery(opts.noteId, selected, opts.editor)
    setBusy(false)
    if (outcome !== 'failed') onClose()
  }

  // ---------- the resizable list ----------
  const maxWidth = (): number => {
    const w = dialogRef.current?.clientWidth ?? 960
    return Math.max(LIST_MIN, Math.min(LIST_MAX, w - EDITOR_MIN))
  }
  const clampWidth = (w: number): number => Math.max(LIST_MIN, Math.min(maxWidth(), w))
  const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = listWidth
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent): void => setListWidth(clampWidth(startW + ev.clientX - startX))
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const row = (t: NoteTemplate): JSX.Element => (
    <li key={t.id}>
      <button
        type="button"
        className="tpl-row"
        aria-current={t.id === selectedId ? 'true' : undefined}
        title={displayTitle(t)}
        onClick={() => setSelectedId(t.id)}
      >
        <TemplateIconView icon={t.icon} size={17} className="tpl-row__icon" />
        <span className="tpl-row__text">
          <span className="tpl-row__title">{displayTitle(t)}</span>
          <span className="tpl-row__owner">{t.is_builtin ? 'Notula' : 'Me'}</span>
        </span>
      </button>
    </li>
  )

  return (
    <dialog
      ref={dialogRef}
      className="tpl-gallery"
      aria-labelledby="tpl-gallery-title"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return
        const r = e.currentTarget.getBoundingClientRect()
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose()
      }}
    >
      <header className="tpl-gallery__header">
        <h2 id="tpl-gallery-title" className="tpl-gallery__title">
          Note templates
        </h2>
        <button type="button" className="n-icon-btn" aria-label="Close" onClick={onClose}>
          <IconClose size={18} />
        </button>
      </header>
      <div className="tpl-gallery__body">
        <aside className="tpl-list" style={{ width: listWidth }} aria-label="Templates">
          <div className="tpl-list__top">
            <button type="button" className="n-btn n-btn--sm tpl-list__new" onClick={() => void createTemplate(true)}>
              <IconPlus size={14} />
              New template
            </button>
            <div className="tpl-search">
              <IconSearch size={14} className="tpl-search__icon" />
              <input
                ref={searchRef}
                className="tpl-search__input"
                placeholder="Search templates..."
                aria-label="Search templates"
                autoFocus={!(opts.mode === 'apply' && opts.createNew)}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && query) {
                    e.preventDefault()
                    e.stopPropagation()
                    setQuery('')
                  }
                }}
              />
              {query ? (
                <button
                  type="button"
                  className="n-icon-btn n-icon-btn--sm tpl-search__clear"
                  aria-label="Clear search"
                  title="Clear search"
                  onClick={() => {
                    setQuery('')
                    searchRef.current?.focus()
                  }}
                >
                  <IconClose size={13} />
                </button>
              ) : null}
            </div>
          </div>
          <div className="tpl-list__scroll">
            {loading ? (
              <p className="tpl-list__note">Loading…</p>
            ) : results ? (
              results.length ? (
                <ul className="tpl-list__group">{results.map(row)}</ul>
              ) : (
                <p className="tpl-list__note">No templates found</p>
              )
            ) : (
              groups.map((g, i) => (
                <div key={g.id} className="tpl-list__section">
                  {i > 0 && groups[i - 1]?.id === 'mine' ? <div className="tpl-list__divider" role="separator" /> : null}
                  <h3 className="tpl-list__heading">{g.heading}</h3>
                  <ul className="tpl-list__group">{g.templates.map(row)}</ul>
                </div>
              ))
            )}
          </div>
        </aside>
        <div
          className="tpl-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize template list"
          aria-valuenow={listWidth}
          aria-valuemin={LIST_MIN}
          aria-valuemax={LIST_MAX}
          tabIndex={0}
          onPointerDown={onResizeStart}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
              e.preventDefault()
              setListWidth((w) => clampWidth(w + (e.key === 'ArrowRight' ? LIST_STEP : -LIST_STEP)))
            }
          }}
        />
        <div className="tpl-gallery__main">
          {selected ? (
            <TemplateEditor
              key={selected.id}
              template={selected}
              editable={isEditable(selected)}
              favorite={favorites.includes(selected.id)}
              ownerName={ownerName}
              onDuplicate={() => void duplicate(selected)}
              onDelete={() => void remove(selected)}
              onToggleFavorite={() => setFavorite(selected.id, !favorites.includes(selected.id))}
            />
          ) : (
            <div className="tpl-gallery__empty">{loading ? null : 'Choose a template'}</div>
          )}
        </div>
      </div>
      {opts.mode === 'apply' ? (
        <footer className="tpl-gallery__footer">
          <button type="button" className="n-btn n-btn--sm" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="n-btn n-btn--primary n-btn--sm" disabled={!selected || busy} onClick={() => void apply()}>
            Apply template
          </button>
        </footer>
      ) : null}
    </dialog>
  )
}
