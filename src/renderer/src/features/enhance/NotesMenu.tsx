// SPDX-License-Identifier: Apache-2.0
// NotesMenu: switch between "My notes" and the enhanced panels,
// regenerate the current panel, and pick or regenerate a template ("Summary", then the
// quick picks by recent use). Picking a template switches to its panel or generates
// one. Before the meeting (no transcript yet, or still transcribing with no summary),
// picking one makes it the note's template instead, and "No template"
// clears it. "All templates…" and "New template" open the gallery. The Regenerate
// buttons spin and ignore clicks while the note is generating. Only the newest panel
// per template is listed. Before the meeting the "Template for this
// meeting" heading has the chip's search (≤ 5 results, "No templates found"), and once a
// template is picked the header chip is the only template control, so this menu hides.

import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { parseError } from '@shared/errors'
import { DEFAULT_TEMPLATE_SLUG } from '@shared/types/enhance'
import { TEMPLATE_QUICK_PICKS } from '@shared/types/templates'
import type { Panel } from '@shared/types/panels'
import type { TemplateIcon } from '@shared/types/templates'
import { IconCheck, IconChevronDown, IconClose, IconPencil, IconPlus, IconSearch, IconSparkle } from '../../app/icons'
import { debugLog, isOwnNote } from '../../app/platform'
import { showToast } from '../../app/toast'
import { useCaptureState } from '../capture'
import { RateTheseNotesMenuItem } from '../summary-feedback'
import {
  displayTitle,
  notesEditorFor,
  openTemplateGallery,
  pickForNote,
  quickPicks,
  searchTemplates,
  TemplateIconView,
  useFavoriteIds,
  useTemplateUsage,
  useTemplates,
  useTemporaryTemplateId
} from '../templates'
import { IconRegenerate } from './icons'
import { liveNotesMarkdown, regenerateWith } from './regenerate'
import { useNote, useNoteGenerating, usePanelsSnapshot, useTranscriptCount } from './store'
import './enhance.css'

export interface NotesMenuProps {
  noteId: string
  selectedPanelId: string | null
  onSelectPanel(id: string): void
  onSwitchToPrivate(): void
}

function slugKey(slug: string | null): string {
  return (slug ?? '').toLowerCase()
}

/** The newest panel per template, in the store's order (most recently viewed first). */
function latestPerTemplate(panels: Panel[]): Panel[] {
  const seen = new Set<string>()
  const out: Panel[] = []
  for (const p of panels) {
    const key = `${slugKey(p.template_key)}\u0000${p.title}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

export function NotesMenu({ noteId, selectedPanelId, onSelectPanel, onSwitchToPrivate }: NotesMenuProps): JSX.Element {
  const note = useNote(noteId)
  const own = note ? isOwnNote(note) : false
  const { panels } = usePanelsSnapshot(noteId)
  const generating = useNoteGenerating(noteId)
  const capture = useCaptureState()
  const chunkCount = useTranscriptCount(noteId)
  const [open, setOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const mayGenerate = own && capture.transcribingNoteId !== noteId && chunkCount > 0
  // Before the meeting's summary can exist, a template is picked for the notes.
  const preMeeting = own && panels.length === 0 && !mayGenerate
  const current = panels.find((p) => p.id === selectedPanelId) ?? null
  const listed = useMemo(() => latestPerTemplate(panels), [panels])

  const { templates } = useTemplates()
  const favorites = useFavoriteIds()
  const usage = useTemplateUsage()
  const temporaryId = useTemporaryTemplateId(noteId)
  const choices = useMemo((): { slug: string; title: string; icon: TemplateIcon | null }[] => {
    const picks = quickPicks(templates, favorites, usage, temporaryId).map((t) => ({ slug: t.id, title: displayTitle(t), icon: t.icon }))
    if (!preMeeting) return [{ slug: DEFAULT_TEMPLATE_SLUG, title: 'Summary', icon: null }, ...picks]
    if (!searching || !query.trim()) return picks
    return searchTemplates(templates, query, TEMPLATE_QUICK_PICKS).map((t) => ({ slug: t.id, title: displayTitle(t), icon: t.icon }))
  }, [templates, favorites, usage, temporaryId, preMeeting, searching, query])

  useEffect(() => {
    if (open) return
    setSearching(false)
    setQuery('')
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  if (panels.length === 0 && !own) return <></>
  // The header chip already offers this note's template before the meeting.
  if (preMeeting && temporaryId !== null) return <></>

  const close = (): void => setOpen(false)

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (searching) {
        setSearching(false)
        setQuery('')
        return
      }
      close()
      rootRef.current?.querySelector<HTMLElement>('.enh-menu__trigger')?.focus()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled), .tpl-menu__search-input') ?? [])
    const i = items.indexOf(document.activeElement as HTMLElement)
    const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]
    next?.focus()
  }

  const regen = (panel: Panel | null, templateSlug?: string): void => {
    if (generating) return
    close()
    void regenerateWith(noteId, { panel, ...(templateSlug ? { templateSlug } : {}) })
  }

  /** Switch to that template's panel, or generate one. */
  const pickTemplate = (slug: string): void => {
    close()
    if (preMeeting) {
      pickForNote(noteId, templates.find((t) => t.id === slug) ?? null, notesEditorFor(noteId))
      return
    }
    const existing = panels.find((p) => slugKey(p.template_key) === slug.toLowerCase())
    if (existing) {
      onSelectPanel(existing.id)
      return
    }
    if (generating || !mayGenerate) return
    debugLog('summary-tab-added', { noteId, templateSlug: slug })
    const md = liveNotesMarkdown(noteId)
    window.notula.enhance
      .generate({ noteId, templateSlug: slug, ...(md ? { notesMarkdown: md } : {}) })
      .catch((err: unknown) => showToast({ kind: 'error', title: 'Couldn’t generate notes', description: parseError(err).message }))
  }

  const regenButton = (panel: Panel | null, templateSlug?: string): JSX.Element => (
    <span className="n-tooltip n-tooltip--end" data-tooltip="Regenerate">
      <button
        type="button"
        role="menuitem"
        className="n-icon-btn n-icon-btn--sm enh-menu__regen"
        aria-label="Regenerate"
        aria-disabled={generating}
        onClick={(e) => {
          e.stopPropagation()
          regen(panel, templateSlug)
        }}
      >
        <IconRegenerate size={15} className={generating ? 'enh-spin' : undefined} />
      </button>
    </span>
  )

  return (
    <div className="enh-menu" ref={rootRef}>
      <button
        type="button"
        className="n-btn n-btn--ghost n-btn--sm enh-menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {generating ? <IconRegenerate size={14} className="enh-spin" /> : <IconSparkle size={14} />}
        <span className="enh-menu__label">{current?.title ?? (panels.length > 0 ? 'Enhanced notes' : 'Templates')}</span>
        <IconChevronDown size={14} />
      </button>
      {open ? (
        <div className="enh-menu__popover" role="menu" aria-label="Notes" ref={menuRef} onKeyDown={onMenuKey}>
          <button
            type="button"
            role="menuitem"
            className="enh-menu__item"
            onClick={() => {
              close()
              onSwitchToPrivate()
            }}
          >
            <IconPencil size={15} />
            <span className="enh-menu__text">My notes</span>
          </button>
          {listed.map((p) => (
            <div key={p.id} className="enh-menu__row">
              <button
                type="button"
                role="menuitem"
                className="enh-menu__item"
                aria-current={p.id === selectedPanelId ? 'true' : undefined}
                onClick={() => {
                  close()
                  onSelectPanel(p.id)
                }}
              >
                <IconSparkle size={15} />
                <span className="enh-menu__text">{p.title}</span>
                {p.id === selectedPanelId ? <IconCheck size={14} className="enh-menu__check" /> : null}
              </button>
              {mayGenerate && p.template_key ? regenButton(p) : null}
            </div>
          ))}
          {mayGenerate || preMeeting ? (
            <>
              <div className="enh-menu__divider" role="separator" />
              {!preMeeting ? (
                <div className="enh-menu__heading">Templates</div>
              ) : searching ? (
                <div className="tpl-menu__search">
                  <IconSearch size={14} />
                  <input
                    className="tpl-menu__search-input"
                    placeholder="Search templates"
                    aria-label="Search templates"
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <button
                    type="button"
                    className="n-icon-btn n-icon-btn--sm"
                    aria-label="Close template search"
                    title="Close template search"
                    onClick={() => {
                      setSearching(false)
                      setQuery('')
                    }}
                  >
                    <IconClose size={13} />
                  </button>
                </div>
              ) : (
                <div className="tpl-menu__heading">
                  <span>Template for this meeting</span>
                  <button type="button" className="n-icon-btn n-icon-btn--sm" aria-label="Search templates" title="Search templates" onClick={() => setSearching(true)}>
                    <IconSearch size={13} />
                  </button>
                </div>
              )}
              {preMeeting && searching && query.trim() && choices.length === 0 ? <p className="tpl-menu__note">No templates found</p> : null}
              {preMeeting ? (
                <button
                  type="button"
                  role="menuitem"
                  className="enh-menu__item"
                  onClick={() => {
                    close()
                    pickForNote(noteId, null, notesEditorFor(noteId))
                  }}
                >
                  <span className="enh-menu__glyph" aria-hidden="true" />
                  <span className="enh-menu__text">No template</span>
                  {temporaryId === null ? <IconCheck size={14} className="enh-menu__check" /> : null}
                </button>
              ) : null}
              {choices.map((t) => (
                <div key={t.slug} className="enh-menu__row">
                  <button type="button" role="menuitem" className="enh-menu__item" onClick={() => pickTemplate(t.slug)}>
                    {t.icon ? <TemplateIconView icon={t.icon} size={15} /> : <IconSparkle size={15} />}
                    <span className="enh-menu__text">{t.title}</span>
                    {preMeeting && t.slug === temporaryId ? <IconCheck size={14} className="enh-menu__check" /> : null}
                  </button>
                  {mayGenerate ? regenButton(current, t.slug) : null}
                </div>
              ))}
              {!generating ? (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className="enh-menu__item"
                    onClick={() => {
                      close()
                      openTemplateGallery({ mode: 'apply', noteId, editor: notesEditorFor(noteId) })
                    }}
                  >
                    <span className="enh-menu__glyph" aria-hidden="true" />
                    <span className="enh-menu__text">All templates…</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="enh-menu__item"
                    onClick={() => {
                      close()
                      openTemplateGallery({ mode: 'apply', noteId, editor: notesEditorFor(noteId), createNew: true })
                    }}
                  >
                    <IconPlus size={15} />
                    <span className="enh-menu__text">New template</span>
                  </button>
                </>
              ) : null}
            </>
          ) : null}
          {/* "Rate these notes", null unless `summaryFeedback.enabled`. */}
          {selectedPanelId ? <RateTheseNotesMenuItem panelId={selectedPanelId} /> : null}
        </div>
      ) : null}
    </div>
  )
}
