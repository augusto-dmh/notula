// SPDX-License-Identifier: Apache-2.0
// The folder dialogs: "Create
// folder" (with the template seed and the duplicate hint), "Folder Settings" (500 ms
// autosave), the delete confirmation, and the "Add notes" picker. One dialog at a time,
// opened imperatively and rendered by FolderDialogsHost (mounted with the palette host).

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type JSX, type KeyboardEvent } from 'react'
import { parseError } from '@shared/errors'
import type { Folder, FolderPresetId } from '@shared/types/folders'
import type { TemplateIcon } from '@shared/types/templates'
import { IconChevronLeft, IconClose } from '../../app/icons'
import { currentRoute, navigate } from '../../app/navigation'
import { debugLog, isMod } from '../../app/platform'
import { showToast } from '../../app/toast'
import { AddNotesDialog } from './AddNotesDialog'
import { FOLDER_PRESETS, FolderGlyph, GREY_FOLDER_ICON, IconChevronRight } from './icons'
import { IconPicker } from './IconPicker'
import { Modal } from './Modal'
import { refreshFolders, useFolders } from './store'
import { folderTitle, sameTitle, UNTITLED_FOLDER } from './tree'

export interface CreateFolderOptions {
  parentId?: string | null
  /** The suggestion bar's "Create": its subtitle, a prefilled name and the grey folder icon. */
  forSeries?: { title: string }
  /** Called with the new folder instead of navigating to it. */
  onCreated?(folder: Folder): void | Promise<void>
}

type DialogState =
  | { kind: 'create'; opts: CreateFolderOptions }
  | { kind: 'settings'; folderId: string }
  | { kind: 'delete'; folderId: string }
  | { kind: 'add-notes'; folderId: string }

const listeners = new Set<() => void>()
let current: DialogState | null = null

function show(next: DialogState | null): void {
  current = next
  for (const l of listeners) l()
}

export function openCreateFolder(opts: CreateFolderOptions = {}): void {
  show({ kind: 'create', opts })
}

export function openFolderSettings(folderId: string): void {
  show({ kind: 'settings', folderId })
}

export function confirmDeleteFolder(folderId: string): void {
  show({ kind: 'delete', folderId })
}

export function openAddNotes(folderId: string): void {
  show({ kind: 'add-notes', folderId })
}

export function FolderDialogsHost(): JSX.Element | null {
  const state = useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => current
  )
  const close = useCallback(() => show(null), [])
  if (!state) return null
  switch (state.kind) {
    case 'create':
      return <CreateFolderDialog key="create" opts={state.opts} onClose={close} />
    case 'settings':
      return <FolderSettingsDialog key={`settings-${state.folderId}`} folderId={state.folderId} onClose={close} />
    case 'delete':
      return <DeleteFolderDialog key={`delete-${state.folderId}`} folderId={state.folderId} onClose={close} />
    case 'add-notes':
      return <AddNotesDialog key={`add-${state.folderId}`} folderId={state.folderId} onClose={close} />
  }
}

// ---------- shared pieces ----------

/** The icon button inside a name field; opens the picker. */
function IconField({ icon, onChange, label }: { icon: TemplateIcon | null; onChange(icon: TemplateIcon): void; label: string }): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="folder-field__icon"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <FolderGlyph icon={icon} size={18} />
      </button>
      {open && ref.current ? <IconPicker anchor={ref.current} value={icon} onChange={onChange} onClose={close} /> : null}
    </>
  )
}

function DialogHeader({ title, subtitle, onClose }: { title: string; subtitle?: string; onClose(): void }): JSX.Element {
  return (
    <header className="h-modal__header">
      <div>
        <h2 className="h-modal__title">{title}</h2>
        {subtitle ? <p className="h-modal__subtitle">{subtitle}</p> : null}
      </div>
      <button type="button" className="n-icon-btn n-icon-btn--sm" aria-label="Close" onClick={onClose}>
        <IconClose size={15} />
      </button>
    </header>
  )
}

// ---------- Create folder ----------

function CreateFolderDialog({ opts, onClose }: { opts: CreateFolderOptions; onClose(): void }): JSX.Element {
  const view = useFolders()
  const parentId = opts.parentId ?? null
  const parent = parentId ? view?.byId.get(parentId) : undefined
  const forSeries = opts.forSeries
  const [name, setName] = useState(forSeries?.title ?? '')
  const [description, setDescription] = useState('')
  const [icon, setIcon] = useState<TemplateIcon | null>(forSeries ? GREY_FOLDER_ICON : null)
  const [preset, setPreset] = useState<FolderPresetId | null>(null)
  const [preview, setPreview] = useState<(typeof FOLDER_PRESETS)[number] | null>(null)
  const [busy, setBusy] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  const trimmed = name.trim()
  const duplicate = trimmed && view ? view.folders.find((f) => sameTitle(f.title, trimmed)) : undefined
  const canCreate = trimmed.length > 0 && !busy

  const submit = async (): Promise<void> => {
    if (!canCreate) return
    setBusy(true)
    try {
      const folder = await window.notula.folders.create({
        id: crypto.randomUUID(),
        title: trimmed,
        description: description.trim() ? description.trim() : null,
        icon,
        parentId,
        preset
      })
      await refreshFolders()
      debugLog(parentId ? 'subfolder-created' : 'folder-added', { id: folder.id, preset })
      onClose()
      if (opts.onCreated) await opts.onCreated(folder)
      else navigate(`/list/${encodeURIComponent(folder.id)}`)
    } catch (err) {
      setBusy(false)
      showToast({ kind: 'error', title: 'Couldn’t create the folder', description: parseError(err).message })
    }
  }

  const choosePreset = (p: (typeof FOLDER_PRESETS)[number]): void => {
    if (preset === p.id) {
      // Choosing it again clears the selection and the values it filled.
      setPreset(null)
      if (name === p.title) setName('')
      if (description === p.description) setDescription('')
      if (icon === p.icon) setIcon(null)
    } else {
      setPreset(p.id)
      setName(p.title)
      setDescription(p.description)
      setIcon(p.icon)
    }
    nameRef.current?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === 'Enter' && isMod(e)) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <Modal label="Create folder" className="folder-dialog" onClose={onClose}>
      <form
        className="h-modal__body"
        onKeyDown={onKeyDown}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <DialogHeader
          title="Create folder"
          subtitle={
            forSeries
              ? 'Make a folder that collects every meeting in this series'
              : parent
                ? `Inside ${folderTitle(parent)}`
                : undefined
          }
          onClose={onClose}
        />
        <label className="folder-field__label" htmlFor="create-folder-name">
          Name and icon
        </label>
        <div className="folder-field">
          <IconField icon={icon} onChange={setIcon} label="Choose an icon" />
          <input
            ref={nameRef}
            id="create-folder-name"
            className="folder-field__input"
            value={name}
            placeholder={preview?.title ?? UNTITLED_FOLDER}
            data-autofocus
            autoComplete="off"
            maxLength={500}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !isMod(e) && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void submit()
              }
            }}
          />
        </div>
        {duplicate ? (
          <div className="folder-duplicate" role="status">
            <span>
              <strong>{folderTitle(duplicate)}</strong> already exists.
            </span>
            <button
              type="button"
              className="n-btn n-btn--ghost n-btn--sm"
              onClick={() => {
                onClose()
                navigate(`/list/${encodeURIComponent(duplicate.id)}`)
              }}
            >
              Go to folder
            </button>
          </div>
        ) : null}
        {!parentId && !forSeries ? (
          <TemplateChips selected={preset} onChoose={choosePreset} onPreview={setPreview} />
        ) : null}
        <label className="folder-field__label" htmlFor="create-folder-description">
          Description
        </label>
        <textarea
          id="create-folder-description"
          className="folder-textarea"
          rows={3}
          value={description}
          maxLength={10_000}
          placeholder={preview?.description ?? (forSeries ? 'Optional description for this folder' : 'What is this folder for?')}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            // Enter submits instead of adding a line.
            if (e.key === 'Enter' && !e.shiftKey && !isMod(e)) {
              e.preventDefault()
              void submit()
            }
          }}
        />
        <footer className="h-modal__footer">
          <button type="button" className="n-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="n-btn n-btn--primary" disabled={!canCreate}>
            Create
          </button>
        </footer>
      </form>
    </Modal>
  )
}

/** "Or start from a template": a horizontally scrolling chip row with arrows on hover. */
function TemplateChips({
  selected,
  onChoose,
  onPreview
}: {
  selected: FolderPresetId | null
  onChoose(p: (typeof FOLDER_PRESETS)[number]): void
  onPreview(p: (typeof FOLDER_PRESETS)[number] | null): void
}): JSX.Element {
  const rowRef = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })

  const measure = useCallback(() => {
    const el = rowRef.current
    if (!el) return
    setEdges({ left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 })
  }, [])

  useEffect(() => {
    measure()
    const el = rowRef.current
    if (!el) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure])

  const scrollBy = (dx: number): void => rowRef.current?.scrollBy({ left: dx, behavior: 'smooth' })

  return (
    <div className="folder-templates">
      <span className="folder-field__label">Or start from a template</span>
      <div className="folder-templates__frame">
        {edges.left ? (
          <button type="button" className="folder-templates__arrow is-left" aria-label="Scroll left" tabIndex={-1} onClick={() => scrollBy(-220)}>
            <IconChevronLeft size={14} />
          </button>
        ) : null}
        <div ref={rowRef} className="folder-templates__row" onScroll={measure} onMouseLeave={() => onPreview(null)}>
          {FOLDER_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`folder-chip${selected === p.id ? ' is-selected' : ''}`}
              aria-pressed={selected === p.id}
              onMouseEnter={() => onPreview(p)}
              onFocus={() => onPreview(p)}
              onBlur={() => onPreview(null)}
              onClick={() => onChoose(p)}
            >
              <FolderGlyph icon={p.icon} size={15} />
              {p.title}
            </button>
          ))}
        </div>
        {edges.right ? (
          <button type="button" className="folder-templates__arrow is-right" aria-label="Scroll right" tabIndex={-1} onClick={() => scrollBy(220)}>
            <IconChevronRight size={14} />
          </button>
        ) : null}
      </div>
    </div>
  )
}

// ---------- Folder Settings ----------

function FolderSettingsDialog({ folderId, onClose }: { folderId: string; onClose(): void }): JSX.Element | null {
  const view = useFolders()
  const folder = view?.byId.get(folderId)
  const [title, setTitle] = useState(folder?.title ?? '')
  const [description, setDescription] = useState(folder?.description ?? '')
  const [icon, setIcon] = useState<TemplateIcon | null>(folder?.icon ?? null)
  const latest = useRef({ title, description, icon })
  latest.current = { title, description, icon }
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = useCallback(async (): Promise<void> => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (!dirty.current) return
    dirty.current = false
    const v = latest.current
    try {
      await window.notula.folders.update({
        id: folderId,
        patch: { title: v.title.trim(), description: v.description.trim() ? v.description : null, icon: v.icon }
      })
      refreshFolders()
    } catch (err) {
      showToast({ kind: 'error', title: 'Couldn’t save the folder', description: parseError(err).message })
    }
  }, [folderId])

  // Title, description and icon save together, debounced 500 ms.
  const edit = (): void => {
    dirty.current = true
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), 500)
  }

  const close = useCallback((): void => {
    void flush()
    onClose()
  }, [flush, onClose])

  // A folder deleted elsewhere closes its settings.
  const missing = view !== null && !folder
  useEffect(() => {
    if (missing) onClose()
  }, [missing, onClose])

  useEffect(
    () => () => {
      void flush()
    },
    [flush]
  )

  if (!folder) return null

  const onEnter = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      close()
    }
  }

  return (
    <Modal label="Folder Settings" className="folder-dialog" onClose={close}>
      <div className="h-modal__body">
        <DialogHeader title="Folder Settings" onClose={close} />
        <label className="folder-field__label" htmlFor="folder-settings-title">
          Title and icon
        </label>
        <div className="folder-field">
          <IconField
            icon={icon}
            label="Change icon"
            onChange={(next) => {
              setIcon(next)
              latest.current = { ...latest.current, icon: next }
              edit()
            }}
          />
          <input
            id="folder-settings-title"
            className="folder-field__input"
            value={title}
            placeholder={UNTITLED_FOLDER}
            data-autofocus
            autoComplete="off"
            maxLength={500}
            onChange={(e) => {
              setTitle(e.target.value)
              edit()
            }}
            onKeyDown={onEnter}
          />
        </div>
        <label className="folder-field__label" htmlFor="folder-settings-description">
          Description
        </label>
        <textarea
          id="folder-settings-description"
          className="folder-textarea"
          rows={3}
          value={description}
          maxLength={10_000}
          placeholder="Describe this folder so you and Notula's AI know what belongs here"
          onChange={(e) => {
            setDescription(e.target.value)
            edit()
          }}
          onKeyDown={onEnter}
        />
        <section className="folder-danger">
          <div>
            <p className="folder-danger__title">Delete folder</p>
            <p className="folder-danger__text">This permanently deletes the folder. Existing notes remain.</p>
          </div>
          <button
            type="button"
            className="n-btn n-btn--sm folder-danger__button"
            onClick={() => {
              void flush()
              confirmDeleteFolder(folderId)
            }}
          >
            Delete folder
          </button>
        </section>
      </div>
    </Modal>
  )
}

// ---------- Delete ----------

function DeleteFolderDialog({ folderId, onClose }: { folderId: string; onClose(): void }): JSX.Element | null {
  const view = useFolders()
  const folder = view?.byId.get(folderId)
  const [busy, setBusy] = useState(false)
  if (!folder) return null
  const parent = folder.parent_id ? view?.byId.get(folder.parent_id) : undefined
  const destination = parent ? folderTitle(parent) : 'My notes'

  const run = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await window.notula.folders.delete({ id: folder.id, confirmed: true })
      refreshFolders()
      onClose()
      const { path, params } = currentRoute()
      if (path.startsWith('/list/') && params['id'] === folder.id) navigate('/')
      showToast({ kind: 'success', title: 'Folder deleted successfully', durationMs: 3_000 })
    } catch (err) {
      setBusy(false)
      showToast({ kind: 'error', title: 'Couldn’t delete folder', description: parseError(err).message })
    }
  }

  return (
    <Modal label={`Delete ${folderTitle(folder)}?`} className="folder-dialog folder-dialog--confirm" onClose={() => !busy && onClose()}>
      <div className="h-modal__body">
        <h2 className="h-modal__title">Delete {folderTitle(folder)}?</h2>
        <p className="h-modal__text">This folder will be permanently deleted.</p>
        <p className="h-modal__text">The notes inside it move to {destination}.</p>
        <footer className="h-modal__footer">
          <button type="button" className="n-btn" disabled={busy} onClick={onClose} data-autofocus>
            Cancel
          </button>
          <button type="button" className="n-btn folder-danger__button" disabled={busy} onClick={() => void run()}>
            {busy ? 'Deleting…' : 'Delete folder'}
          </button>
        </footer>
      </div>
    </Modal>
  )
}
