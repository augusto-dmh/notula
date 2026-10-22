// SPDX-License-Identifier: Apache-2.0
// The template editor: icon, name, owner actions
// ("Template options": Duplicate, Delete template) or, for a template the user does
// not own, "View only", "Edit a copy" and the favourite toggle; "Meeting Context"; and
// "Sections" with drag reordering, "Add Section" and a confirmed delete. Every edit of
// an editable template autosaves one second after the last change; a
// failed save shows "Couldn't save template" and keeps the edit.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type TextareaHTMLAttributes
} from 'react'
import { parseError } from '@shared/errors'
import type { NoteTemplate, TemplateIcon, TemplateSection } from '@shared/types/templates'
import { IconPlus } from '../../app/icons'
import { debugLog } from '../../app/platform'
import { showToast } from '../../app/toast'
import { ActionMenu, type ActionMenuAnchor } from '../note-page/ActionMenu'
import { TemplateFeedbackSection } from '../summary-feedback'
import { confirmDialog } from './confirm'
import { IconPicker } from './IconPicker'
import { TemplateIconView } from './icons'
import { displayTitle } from './order'
import { putLocalTemplate } from './store'
import { IconCopy, IconGrip, IconLock, IconMore, IconStar, IconTrashSmall } from './ui-icons'

const AUTOSAVE_MS = 1_000
const MEETING_CONTEXT_PLACEHOLDER = 'Tell Notula what this meeting is about and what you want from it'

interface Draft {
  title: string
  description: string
  sections: TemplateSection[]
  icon: TemplateIcon | null
}

function fresh(t: NoteTemplate): Draft {
  // Every section gets a fresh id when the editor loads the template.
  return {
    title: t.title,
    description: t.description,
    sections: t.sections.map((s) => ({ ...s, id: crypto.randomUUID() })),
    icon: t.icon
  }
}

/** A textarea that grows with its text. */
function AutoTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [props.value])
  return <textarea ref={ref} rows={1} {...props} />
}

export interface TemplateEditorProps {
  template: NoteTemplate
  editable: boolean
  favorite: boolean
  /** The owner's display name for the byline. */
  ownerName: string
  onDuplicate(): void
  onDelete(): void
  onToggleFavorite(): void
}

export function TemplateEditor({
  template,
  editable,
  favorite,
  ownerName,
  onDuplicate,
  onDelete,
  onToggleFavorite
}: TemplateEditorProps): JSX.Element {
  const [draft, setDraft] = useState<Draft>(() => fresh(template))
  const [picker, setPicker] = useState(false)
  const [menu, setMenu] = useState<ActionMenuAnchor | null>(null)
  const menuButton = useRef<HTMLButtonElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  // ---------- autosave ----------
  const draftRef = useRef(draft)
  draftRef.current = draft
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirty = useRef(false)
  const version = useRef(0)

  const save = useCallback((): void => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    if (!dirty.current || !editable) return
    dirty.current = false
    const v = ++version.current
    const d = draftRef.current
    window.notula.templates
      .update({ id: template.id, patch: { title: d.title, description: d.description, sections: d.sections, icon: d.icon } })
      .then((saved) => {
        // A newer edit is on its way: its own save confirms it.
        if (v === version.current && !dirty.current) putLocalTemplate(saved, { pending: false })
      })
      .catch((err: unknown) => {
        debugLog('template-save-failed', { id: template.id, err: parseError(err) })
        showToast({ id: `template-save-${template.id}`, kind: 'error', title: 'Couldn’t save template', description: parseError(err).message })
      })
  }, [editable, template.id])

  const change = useCallback(
    (fn: (d: Draft) => Draft): void => {
      if (!editable) return
      const next = fn(draftRef.current)
      if (next === draftRef.current) return
      draftRef.current = next
      setDraft(next)
      putLocalTemplate({ ...template, ...next, updated_at: new Date().toISOString() }, { pending: true })
      dirty.current = true
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(save, AUTOSAVE_MS)
    },
    [editable, save, template]
  )

  // Leaving the template (another selection, closing the gallery) saves at once.
  useEffect(() => () => save(), [save])

  // A brand-new template starts with its name selected.
  useEffect(() => {
    if (editable && !template.updated_at && template.title === 'Untitled template') titleRef.current?.select()
  }, [])

  // ---------- sections ----------
  const [focusSection, setFocusSection] = useState<string | null>(null)
  const addSection = (): void => {
    const id = crypto.randomUUID()
    change((d) => ({ ...d, sections: [...d.sections, { id, heading: '', section_hint: '' }] }))
    setFocusSection(id)
  }
  const updateSection = (id: string, patch: Partial<TemplateSection>): void =>
    change((d) => ({ ...d, sections: d.sections.map((s) => (s.id === id ? { ...s, ...patch } : s)) }))
  const moveSection = (from: number, to: number): void =>
    change((d) => {
      if (from === to || from < 0 || to < 0 || from >= d.sections.length || to >= d.sections.length) return d
      const sections = [...d.sections]
      const [moved] = sections.splice(from, 1)
      if (moved) sections.splice(to, 0, moved)
      return { ...d, sections }
    })
  const deleteSection = async (id: string): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Are you sure?',
      body: 'This permanently removes the section from this template.',
      confirmLabel: 'Delete',
      danger: true
    })
    if (ok) change((d) => ({ ...d, sections: d.sections.filter((s) => s.id !== id) }))
  }

  // Drag reordering: the handle arms its card, which is then the drag source (vertical only).
  const [armed, setArmed] = useState<string | null>(null)
  const [drop, setDrop] = useState<{ index: number; after: boolean } | null>(null)
  const dragFrom = useRef<number | null>(null)
  const onDragOver = (e: ReactDragEvent<HTMLElement>, index: number): void => {
    if (dragFrom.current === null) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const r = e.currentTarget.getBoundingClientRect()
    const after = e.clientY > r.top + r.height / 2
    setDrop((p) => (p && p.index === index && p.after === after ? p : { index, after }))
  }
  const onDrop = (e: ReactDragEvent<HTMLElement>): void => {
    e.preventDefault()
    const from = dragFrom.current
    if (from !== null && drop) {
      let to = drop.index + (drop.after ? 1 : 0)
      if (from < to) to -= 1
      moveSection(from, to)
    }
    dragFrom.current = null
    setDrop(null)
    setArmed(null)
  }

  const visibleSections = editable ? draft.sections : draft.sections.filter((s) => s.heading.trim())
  const showContext = editable || draft.description.length > 1

  return (
    <div className="tpl-editor">
      <div className="tpl-editor__head">
        <div className="tpl-editor__icon-wrap">
          {editable ? (
            <button
              type="button"
              className="tpl-editor__icon"
              aria-label="Change icon"
              aria-haspopup="dialog"
              aria-expanded={picker}
              onClick={() => setPicker((o) => !o)}
            >
              <TemplateIconView icon={draft.icon} size={26} />
            </button>
          ) : (
            <span className="tpl-editor__icon tpl-editor__icon--static">
              <TemplateIconView icon={draft.icon} size={26} />
            </span>
          )}
          {picker ? (
            <IconPicker
              icon={draft.icon}
              onChange={(icon, close) => {
                change((d) => ({ ...d, icon }))
                if (close) setPicker(false)
              }}
              onClose={() => setPicker(false)}
            />
          ) : null}
        </div>
        <div className="tpl-editor__actions">
          {editable ? (
            <>
              <button
                type="button"
                ref={menuButton}
                className="n-icon-btn"
                aria-label="Template options"
                title="Template options"
                aria-haspopup="menu"
                aria-expanded={menu !== null}
                onClick={(e) => setMenu(menu ? null : { rect: e.currentTarget.getBoundingClientRect(), align: 'end' })}
              >
                <IconMore size={18} />
              </button>
              {menu ? (
                <ActionMenu
                  label="Template options"
                  anchor={menu}
                  owner={menuButton.current}
                  onClose={(refocus) => {
                    setMenu(null)
                    if (refocus) menuButton.current?.focus()
                  }}
                  entries={[
                    { kind: 'item', id: 'duplicate', label: 'Duplicate', icon: <IconCopy size={15} />, onSelect: onDuplicate },
                    { kind: 'item', id: 'delete', label: 'Delete template', icon: <IconTrashSmall size={15} />, danger: true, onSelect: onDelete }
                  ]}
                />
              ) : null}
            </>
          ) : (
            <>
              <button type="button" className="n-btn n-btn--sm" onClick={onDuplicate}>
                <IconCopy size={14} />
                Edit a copy
              </button>
              <button
                type="button"
                className={`n-btn n-btn--sm tpl-fav${favorite ? ' is-on' : ''}`}
                aria-pressed={favorite}
                onClick={onToggleFavorite}
              >
                <IconStar size={14} filled={favorite} />
                {favorite ? 'Remove from my templates' : 'Add to my templates'}
              </button>
            </>
          )}
        </div>
      </div>

      {editable ? (
        <input
          ref={titleRef}
          className="tpl-editor__title"
          placeholder="Template name"
          aria-label="Template name"
          value={draft.title}
          maxLength={200}
          onChange={(e) => change((d) => ({ ...d, title: e.target.value }))}
        />
      ) : (
        <h2 className="tpl-editor__title tpl-editor__title--static">{displayTitle(draft)}</h2>
      )}

      <div className="tpl-editor__byline">
        {template.is_builtin ? (
          <>
            <span className="tpl-avatar tpl-avatar--notula" aria-hidden="true">
              N
            </span>
            <span>Notula</span>
          </>
        ) : (
          <>
            <span className="tpl-avatar" aria-hidden="true">
              {(ownerName.trim()[0] ?? 'Y').toUpperCase()}
            </span>
            <span>{`${ownerName.trim() || 'You'} (me)`}</span>
          </>
        )}
        {!editable ? (
          <span className="tpl-badge">
            <IconLock size={12} />
            View only
          </span>
        ) : null}
      </div>

      {showContext ? (
        <section className="tpl-editor__block">
          <h3 className="tpl-editor__label">Meeting context</h3>
          {editable ? (
            <AutoTextarea
              className="tpl-field tpl-field--context"
              placeholder={MEETING_CONTEXT_PLACEHOLDER}
              aria-label="Meeting context"
              value={draft.description}
              maxLength={20_000}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => change((d) => ({ ...d, description: e.target.value }))}
            />
          ) : (
            <p className="tpl-editor__text">{draft.description}</p>
          )}
        </section>
      ) : null}

      <section className="tpl-editor__block">
        <h3 className="tpl-editor__label">Sections</h3>
        <ol className="tpl-sections">
          {visibleSections.map((s, index) =>
            editable ? (
              <li
                key={s.id}
                className={`tpl-section${armed === s.id ? ' is-armed' : ''}${
                  drop?.index === index ? (drop.after ? ' drop-after' : ' drop-before') : ''
                }`}
                draggable={armed === s.id}
                onDragStart={(e) => {
                  dragFrom.current = index
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', s.heading)
                }}
                onDragOver={(e) => onDragOver(e, index)}
                onDrop={onDrop}
                onDragEnd={() => {
                  dragFrom.current = null
                  setDrop(null)
                  setArmed(null)
                }}
              >
                <button
                  type="button"
                  className="tpl-section__grip"
                  aria-label={`Move section ${s.heading || index + 1}`}
                  title="Drag to reorder"
                  onPointerDown={() => setArmed(s.id)}
                  onPointerUp={() => setArmed(null)}
                  onKeyDown={(e: ReactKeyboardEvent<HTMLButtonElement>) => {
                    if (e.key === 'ArrowUp' && index > 0) {
                      e.preventDefault()
                      moveSection(index, index - 1)
                    } else if (e.key === 'ArrowDown' && index < visibleSections.length - 1) {
                      e.preventDefault()
                      moveSection(index, index + 1)
                    }
                  }}
                >
                  <IconGrip size={14} />
                </button>
                <div className="tpl-section__fields">
                  <input
                    className="tpl-field tpl-field--heading"
                    placeholder="Section title"
                    aria-label="Section title"
                    value={s.heading}
                    maxLength={300}
                    autoFocus={focusSection === s.id}
                    onChange={(e) => updateSection(s.id, { heading: e.target.value })}
                  />
                  <AutoTextarea
                    className="tpl-field tpl-field--instructions"
                    placeholder="Instructions for Notula…"
                    aria-label="Instructions for Notula"
                    value={s.section_hint}
                    maxLength={5_000}
                    onChange={(e: ChangeEvent<HTMLTextAreaElement>) => updateSection(s.id, { section_hint: e.target.value })}
                  />
                </div>
                <button
                  type="button"
                  className="n-icon-btn n-icon-btn--sm tpl-section__delete"
                  aria-label="Delete section"
                  title="Delete section"
                  onClick={() => void deleteSection(s.id)}
                >
                  <IconTrashSmall size={14} />
                </button>
              </li>
            ) : (
              <li key={s.id} className="tpl-section tpl-section--static">
                <div className="tpl-section__fields">
                  <p className="tpl-section__heading">{s.heading}</p>
                  {s.section_hint.trim() ? <p className="tpl-section__instructions">{s.section_hint}</p> : null}
                </div>
              </li>
            )
          )}
        </ol>
        {editable ? (
          <button type="button" className="n-btn n-btn--ghost n-btn--sm tpl-add-section" onClick={addSection}>
            <IconPlus size={14} />
            Add section
          </button>
        ) : visibleSections.length === 0 ? (
          <p className="tpl-editor__empty">This template has no sections.</p>
        ) : null}
      </section>
      {/* The ratings for this template and the suggested edits. */}
      <TemplateFeedbackSection templateSlug={template.id} />
    </div>
  )
}
