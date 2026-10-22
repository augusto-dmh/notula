// SPDX-License-Identifier: Apache-2.0
// The template chip in the note header. It shows while the note has no summary and has
// a temporary template: the template's icon and title. Its menu: "No template"; a
// "Templates" heading whose search button turns into "Search templates" (≤ 5 results,
// "No templates found"); up to 5 quick picks by recent use; "All templates…" and
// "New template". Deleting every inserted heading clears the temporary template.

import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { TEMPLATE_QUICK_PICKS } from '@shared/types/templates'
import { IconCheck, IconChevronDown, IconClose, IconPlus, IconSearch } from '../../app/icons'
import type { EditorHandle } from '../../editor/types'
import { pickForNote } from './apply'
import { TemplateIconView } from './icons'
import { displayTitle, quickPicks, searchTemplates } from './order'
import {
  isApplyingHeadings,
  registerNotesEditor,
  setTemporaryTemplate,
  temporaryTemplateId,
  useFavoriteIds,
  useTemplateUsage,
  useTemplates,
  useTemporaryTemplateId
} from './store'
import { openGallery } from './TemplateGallery'
import './templates.css'

export function TemplateChipView({
  noteId,
  hasSummary,
  editor
}: {
  noteId: string
  hasSummary: boolean
  editor: EditorHandle | null
}): JSX.Element | null {
  const templateId = useTemporaryTemplateId(noteId)
  const { templates } = useTemplates()

  // The gallery and the notes menu reach this note's editor through the registry.
  useEffect(() => registerNotesEditor(noteId, editor), [noteId, editor])

  // Deleting every inserted heading clears the temporary template.
  useEffect(() => {
    if (!editor) return
    return editor.subscribeTemplateHeadings((present) => {
      if (!present && !isApplyingHeadings() && temporaryTemplateId(noteId)) setTemporaryTemplate(noteId, null)
    })
  }, [editor, noteId])

  // Once the note has its summary, the template picked before the meeting has done its job.
  useEffect(() => {
    if (hasSummary && temporaryTemplateId(noteId)) setTemporaryTemplate(noteId, null)
  }, [hasSummary, noteId])

  if (hasSummary || !templateId) return null
  const template = templates.find((t) => t.id === templateId) ?? null
  return <Chip noteId={noteId} editor={editor} templateId={templateId} label={template ? displayTitle(template) : 'Template'} icon={template?.icon ?? null} />
}

function Chip({
  noteId,
  editor,
  templateId,
  label,
  icon
}: {
  noteId: string
  editor: EditorHandle | null
  templateId: string
  label: string
  icon: Parameters<typeof TemplateIconView>[0]['icon']
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div className="tpl-chip" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="tpl-chip__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <TemplateIconView icon={icon} size={14} />
        <span className="tpl-chip__label">{label}</span>
        <IconChevronDown size={13} />
      </button>
      {open ? (
        <TemplateMenu
          noteId={noteId}
          editor={editor}
          currentId={templateId}
          onClose={(refocus) => {
            setOpen(false)
            if (refocus) triggerRef.current?.focus()
          }}
        />
      ) : null}
    </div>
  )
}

/** The chip's menu. */
function TemplateMenu({
  noteId,
  editor,
  currentId,
  onClose
}: {
  noteId: string
  editor: EditorHandle | null
  currentId: string | null
  onClose(refocus: boolean): void
}): JSX.Element {
  const { templates } = useTemplates()
  const favorites = useFavoriteIds()
  const usage = useTemplateUsage()
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)

  const picks = useMemo(() => quickPicks(templates, favorites, usage, currentId), [templates, favorites, usage, currentId])
  const results = useMemo(
    () => (searching && query.trim() ? searchTemplates(templates, query, TEMPLATE_QUICK_PICKS) : null),
    [searching, query, templates]
  )

  useEffect(() => {
    if (!searching) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [searching])

  const choose = (id: string | null): void => {
    onClose(true)
    pickForNote(noteId, id ? (templates.find((t) => t.id === id) ?? null) : null, editor)
  }

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (searching) {
        setSearching(false)
        setQuery('')
      } else onClose(true)
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"], .tpl-menu__search-input') ?? [])
    const i = items.indexOf(document.activeElement as HTMLElement)
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
  }

  const list = results ?? picks
  return (
    <div className="tpl-menu" role="menu" aria-label="Template" ref={menuRef} onKeyDown={onKey}>
      <button type="button" role="menuitem" className="tpl-menu__item" onClick={() => choose(null)}>
        <span className="tpl-menu__text">No template</span>
        {currentId === null ? <IconCheck size={14} className="tpl-menu__check" /> : null}
      </button>
      <div className="tpl-menu__divider" role="separator" />
      {searching ? (
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
          <span>Templates</span>
          <button type="button" className="n-icon-btn n-icon-btn--sm" aria-label="Search templates" title="Search templates" onClick={() => setSearching(true)}>
            <IconSearch size={13} />
          </button>
        </div>
      )}
      {results && results.length === 0 ? <p className="tpl-menu__note">No templates found</p> : null}
      {list.map((t) => (
        <button key={t.id} type="button" role="menuitem" className="tpl-menu__item" onClick={() => choose(t.id)}>
          <TemplateIconView icon={t.icon} size={15} />
          <span className="tpl-menu__text">{displayTitle(t)}</span>
          {t.id === currentId ? <IconCheck size={14} className="tpl-menu__check" /> : null}
        </button>
      ))}
      <div className="tpl-menu__divider" role="separator" />
      <button
        type="button"
        role="menuitem"
        className="tpl-menu__item"
        onClick={() => {
          onClose(false)
          openGallery({ mode: 'apply', noteId, editor })
        }}
      >
        <span className="tpl-menu__text">All templates…</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="tpl-menu__item"
        onClick={() => {
          onClose(false)
          openGallery({ mode: 'apply', noteId, editor, createNew: true })
        }}
      >
        <IconPlus size={14} />
        <span className="tpl-menu__text">New template</span>
      </button>
    </div>
  )
}
