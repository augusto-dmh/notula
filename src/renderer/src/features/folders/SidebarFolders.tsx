// SPDX-License-Identifier: Apache-2.0
// The sidebar's folders:
// "Favorites" (when any), the "Spaces" heading and the "My notes" section, folders by
// title with subfolders collapsed, the top-folder block at 10 folders, "Folder options"
// (also on right-click), and drag and drop of notes and folders.
//
// Persisted in `folders.sidebar`: My notes expanded, Favorites open, Show all. Folder
// expansion is per session; only the section states persist.

import { useEffect, useState, type DragEvent, type JSX } from 'react'
import { MY_NOTES_SECTION_ID, NOTE_DRAG_MIME, type Folder } from '@shared/types/folders'
import type { Settings } from '@shared/types/settings'
import { IconPencil, IconPlus, IconSettings } from '../../app/icons'
import { navigate, useRoute } from '../../app/navigation'
import { closeSidebarOverlay } from '../../app/sidebar-state'
import { readViewState, saveViewState } from '../../app/scroll-memory'
import { ActionMenu, type ActionMenuEntry } from '../note-page/ActionMenu'
import { setPrefs, usePrefs } from '../settings/prefs-store'
import { openFolderIntegrations } from '../integrations'
import { IconTrash } from '../trash'
import { addNotesToFolder, moveFolder, setFavourite } from './actions'
import { confirmDeleteFolder, openCreateFolder, openFolderSettings } from './dialogs'
import {
  FolderGlyph,
  IconCaretDown,
  IconChevronRight,
  IconDots,
  IconFolderPlus,
  IconSpaces,
  IconStar
} from './icons'
import { useFolders } from './store'
import { ancestors, childrenOf, folderTitle, hasChildren, topFolders } from './tree'
import './folders.css'

/** H-internal drag type for folder rows. */
export const FOLDER_DRAG_MIME = 'application/x-notula-folder-id'

type SidebarState = Settings['folders.sidebar']
const DEFAULT_SIDEBAR: SidebarState = { myNotesExpanded: false, favoritesOpen: true, collapsedFolderIds: [], showAll: false }
const EXPANDED_KEY = 'folders.expanded'

function useSidebarState(): [SidebarState, (patch: Partial<SidebarState>) => void] {
  const prefs = usePrefs()
  const state = prefs?.['folders.sidebar'] ?? DEFAULT_SIDEBAR
  return [state, (patch) => setPrefs({ 'folders.sidebar': { ...state, ...patch } })]
}

/** Expanded parent folders (collapsed by default), kept for the session. */
function useExpanded(): [ReadonlySet<string>, (id: string, open: boolean) => void] {
  const [set, setSet] = useState<ReadonlySet<string>>(() => new Set(readViewState<string[]>(EXPANDED_KEY) ?? []))
  const update = (id: string, open: boolean): void =>
    setSet((prev) => {
      if (prev.has(id) === open) return prev
      const next = new Set(prev)
      if (open) next.add(id)
      else next.delete(id)
      saveViewState(EXPANDED_KEY, [...next])
      return next
    })
  return [set, update]
}

function dragHas(e: DragEvent, type: string): boolean {
  return e.dataTransfer.types.includes(type)
}

function readNoteIds(e: DragEvent): string[] {
  try {
    const v: unknown = JSON.parse(e.dataTransfer.getData(NOTE_DRAG_MIME))
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** The folder menu. `inHeader` hides the favourite toggle (the folder page's own menu). */
export function folderMenuEntries(folder: Folder, opts: { inHeader?: boolean } = {}): ActionMenuEntry[] {
  const entries: ActionMenuEntry[] = []
  if (folder.parent_id === null) {
    entries.push({
      kind: 'item',
      id: 'subfolder',
      label: 'Create subfolder',
      icon: <IconFolderPlus size={16} />,
      onSelect: () => openCreateFolder({ parentId: folder.id })
    })
  }
  if (!opts.inHeader) {
    entries.push({
      kind: 'item',
      id: 'favourite',
      label: folder.is_favourite ? 'Remove from favorites' : 'Add to favorites',
      icon: <IconStar size={16} filled={folder.is_favourite} />,
      onSelect: () => void setFavourite(folder, !folder.is_favourite)
    })
  }
  if (opts.inHeader) {
    // The folder options menu's "Integrations".
    entries.push({
      kind: 'item',
      id: 'integrations',
      label: 'Integrations',
      icon: <IconSettings size={16} />,
      onSelect: () => openFolderIntegrations(folder.id)
    })
  }
  entries.push(
    { kind: 'item', id: 'rename', label: 'Rename', icon: <IconPencil size={16} />, onSelect: () => openFolderSettings(folder.id) },
    { kind: 'divider', id: 'divider' },
    {
      kind: 'item',
      id: 'delete',
      label: 'Delete folder',
      icon: <IconTrash size={16} />,
      danger: true,
      onSelect: () => confirmDeleteFolder(folder.id)
    }
  )
  return entries
}

export function SidebarFolders(): JSX.Element | null {
  const view = useFolders()
  const prefs = usePrefs()
  const route = useRoute()
  const [sidebar, setSidebar] = useSidebarState()
  const [expanded, setExpanded] = useExpanded()
  const [menu, setMenu] = useState<{ folder: Folder; anchor: { point: { x: number; y: number } } } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const activeId = route.path.startsWith('/list/') ? (route.params['id'] ?? null) : null

  // "My notes" opens on its own when navigating to one of its folders, and
  // the parent of an open subfolder expands.
  useEffect(() => {
    if (!activeId || !view || activeId === MY_NOTES_SECTION_ID) return
    const folder = view.byId.get(activeId)
    if (!folder) return
    if (!sidebar.myNotesExpanded) setSidebar({ myNotesExpanded: true })
    for (const a of ancestors(view, folder.id)) setExpanded(a.id, true)
  }, [activeId, view])

  if (!view) {
    return (
      <div className="sidebar-folders" aria-busy="true">
        <div className="sidebar-folders__heading">Spaces</div>
        <div className="n-skeleton sidebar-folders__skeleton" />
        <div className="n-skeleton sidebar-folders__skeleton is-short" />
      </div>
    )
  }

  const uses = prefs?.['folders.useTimestamps'] ?? {}
  const favourites = view.folders.filter((f) => f.is_favourite && !(f.parent_id && view.byId.get(f.parent_id)?.is_favourite))
  favourites.sort((a, b) => folderTitle(a).localeCompare(folderTitle(b), undefined, { sensitivity: 'base' }))
  const top = childrenOf(view, null)
  const picks = topFolders(view, uses, top)
  const rest = picks ? top.filter((f) => !picks.includes(f)) : []
  const onMyNotesPage = activeId === MY_NOTES_SECTION_ID

  const openMenu = (folder: Folder, point: { x: number; y: number }): void => setMenu({ folder, anchor: { point } })

  // ---------- drag and drop ----------

  const canNest = (dragged: Folder | undefined, target: Folder): boolean =>
    !!dragged &&
    dragged.id !== target.id &&
    target.parent_id === null &&
    dragged.parent_id !== target.id &&
    !hasChildren(view, dragged.id)

  const folderDropProps = (target: Folder) => ({
    onDragOver: (e: DragEvent) => {
      if (dragHas(e, NOTE_DRAG_MIME) || (dragHas(e, FOLDER_DRAG_MIME) && target.parent_id === null)) {
        e.preventDefault()
        e.dataTransfer.dropEffect = dragHas(e, NOTE_DRAG_MIME) ? 'copy' : 'move'
        setDropTarget(target.id)
      }
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget((t) => (t === target.id ? null : t))
    },
    onDrop: (e: DragEvent) => {
      setDropTarget(null)
      if (dragHas(e, NOTE_DRAG_MIME)) {
        e.preventDefault()
        const ids = readNoteIds(e)
        if (ids.length) void addNotesToFolder(target.id, ids, 'dragged')
        return
      }
      if (dragHas(e, FOLDER_DRAG_MIME)) {
        e.preventDefault()
        const dragged = view.byId.get(e.dataTransfer.getData(FOLDER_DRAG_MIME))
        if (dragged && canNest(dragged, target)) {
          setExpanded(target.id, true)
          void moveFolder(dragged.id, target.id)
        }
      }
    }
  })

  const sectionDropProps = (kind: 'my-notes' | 'favorites') => ({
    onDragOver: (e: DragEvent) => {
      if (!dragHas(e, FOLDER_DRAG_MIME)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDropTarget(kind)
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget((t) => (t === kind ? null : t))
    },
    onDrop: (e: DragEvent) => {
      setDropTarget(null)
      if (!dragHas(e, FOLDER_DRAG_MIME)) return
      e.preventDefault()
      const dragged = view.byId.get(e.dataTransfer.getData(FOLDER_DRAG_MIME))
      if (!dragged) return
      if (kind === 'favorites') {
        if (!dragged.is_favourite) void setFavourite(dragged, true)
      } else if (dragged.parent_id !== null) {
        void moveFolder(dragged.id, null)
      }
    }
  })

  const renderFolder = (folder: Folder, depth: number, inFavourites: boolean): JSX.Element => {
    const kids = childrenOf(view, folder.id).filter((k) => !inFavourites || k.is_favourite)
    const open = expanded.has(folder.id)
    const active = activeId === folder.id
    const title = folderTitle(folder)
    return (
      <li key={`${inFavourites ? 'fav' : 'tree'}-${folder.id}`} className="sidebar-folders__item">
        <div
          className={`folder-row${active ? ' is-active' : ''}${dropTarget === folder.id && !inFavourites ? ' is-drop' : ''}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(FOLDER_DRAG_MIME, folder.id)
            e.dataTransfer.effectAllowed = 'move'
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            openMenu(folder, { x: e.clientX, y: e.clientY })
          }}
          {...(inFavourites ? {} : folderDropProps(folder))}
        >
          {kids.length > 0 ? (
            <button
              type="button"
              className="folder-row__chevron"
              aria-label={open ? 'Collapse folder' : 'Expand folder'}
              aria-expanded={open}
              onClick={() => setExpanded(folder.id, !open)}
            >
              {open ? <IconCaretDown size={13} /> : <IconChevronRight size={13} />}
            </button>
          ) : (
            <span className="folder-row__chevron is-empty" aria-hidden="true" />
          )}
          <button
            type="button"
            className="folder-row__link"
            aria-current={active ? 'page' : undefined}
            title={title}
            onClick={() => {
              navigate(`/list/${encodeURIComponent(folder.id)}`)
              closeSidebarOverlay()
            }}
            onKeyDown={(e) => {
              if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                e.preventDefault()
                const r = e.currentTarget.getBoundingClientRect()
                openMenu(folder, { x: r.left + 24, y: r.bottom })
              }
            }}
          >
            <FolderGlyph icon={folder.icon} size={15} />
            <span className={`folder-row__title${folder.title.trim() ? '' : ' is-untitled'}`}>{title}</span>
          </button>
          <button
            type="button"
            className="folder-row__more"
            aria-label="Folder options"
            aria-haspopup="menu"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              openMenu(folder, { x: r.left, y: r.bottom + 4 })
            }}
          >
            <IconDots size={15} />
          </button>
        </div>
        {kids.length > 0 && open ? <ul className="sidebar-folders__list">{kids.map((k) => renderFolder(k, depth + 1, inFavourites))}</ul> : null}
      </li>
    )
  }

  return (
    <div className="sidebar-folders">
      {favourites.length > 0 ? (
        <section className="sidebar-folders__section" aria-label="Favorites">
          <div className={`sidebar-section${dropTarget === 'favorites' ? ' is-drop' : ''}`} {...sectionDropProps('favorites')}>
            <button
              type="button"
              className="sidebar-section__title"
              aria-expanded={sidebar.favoritesOpen}
              onClick={() => setSidebar({ favoritesOpen: !sidebar.favoritesOpen })}
            >
              <IconStar size={15} />
              <span>Favorites</span>
              <span className="sidebar-section__chevron" aria-hidden="true">
                {sidebar.favoritesOpen ? <IconCaretDown size={13} /> : <IconChevronRight size={13} />}
              </span>
            </button>
          </div>
          {sidebar.favoritesOpen ? <ul className="sidebar-folders__list">{favourites.map((f) => renderFolder(f, 0, true))}</ul> : null}
        </section>
      ) : null}

      <div className="sidebar-folders__heading">Spaces</div>

      <section className="sidebar-folders__section" aria-label="My notes">
        <div className={`sidebar-section${onMyNotesPage ? ' is-active' : ''}${dropTarget === 'my-notes' ? ' is-drop' : ''}`} {...sectionDropProps('my-notes')}>
          <button
            type="button"
            className="sidebar-section__title"
            aria-current={onMyNotesPage ? 'page' : undefined}
            onClick={() => {
              // Navigates to the section's page, or toggles it when already there.
              if (onMyNotesPage) setSidebar({ myNotesExpanded: !sidebar.myNotesExpanded })
              else {
                navigate(`/list/${MY_NOTES_SECTION_ID}`)
                closeSidebarOverlay()
                if (!sidebar.myNotesExpanded) setSidebar({ myNotesExpanded: true })
              }
            }}
          >
            <IconSpaces size={15} />
            <span>My notes</span>
          </button>
          <button
            type="button"
            className="sidebar-section__icon-btn"
            aria-label={sidebar.myNotesExpanded ? 'Collapse section' : 'Expand section'}
            aria-expanded={sidebar.myNotesExpanded}
            onClick={() => setSidebar({ myNotesExpanded: !sidebar.myNotesExpanded })}
          >
            {sidebar.myNotesExpanded ? <IconCaretDown size={13} /> : <IconChevronRight size={13} />}
          </button>
          <span className="n-tooltip n-tooltip--end" data-tooltip="Create folder">
            <button
              type="button"
              className="sidebar-section__icon-btn"
              aria-label="Create folder"
              onClick={() => openCreateFolder({ parentId: null })}
            >
              <IconPlus size={14} />
            </button>
          </span>
        </div>
        {sidebar.myNotesExpanded ? (
          top.length === 0 ? (
            <button type="button" className="folder-row folder-row--add" onClick={() => openCreateFolder({ parentId: null })}>
              <IconPlus size={14} />
              Add folder
            </button>
          ) : (
            <>
              <ul className="sidebar-folders__list">{(picks ?? top).map((f) => renderFolder(f, 0, false))}</ul>
              {picks ? (
                <>
                  <button
                    type="button"
                    className="sidebar-folders__show-all"
                    aria-expanded={sidebar.showAll}
                    onClick={() => setSidebar({ showAll: !sidebar.showAll })}
                  >
                    <span>{sidebar.showAll ? 'Show less' : 'Show all'}</span>
                    {sidebar.showAll ? <span className="sidebar-folders__az">A-Z</span> : null}
                  </button>
                  {sidebar.showAll ? <ul className="sidebar-folders__list">{rest.map((f) => renderFolder(f, 0, false))}</ul> : null}
                </>
              ) : null}
            </>
          )
        ) : null}
      </section>

      {menu ? (
        <ActionMenu
          label="Folder options"
          anchor={menu.anchor}
          entries={folderMenuEntries(menu.folder)}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  )
}
