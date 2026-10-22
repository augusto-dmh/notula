// SPDX-License-Identifier: Apache-2.0
// The folder page: `/list/:id`, and the "My notes"
// section page `/list/my-notes` (its top-level folders, then every listable note of the
// user). Breadcrumb (the current folder appears after 48 px), icon, title and
// description (which open Folder Settings), the list-header chat input, the member
// notes (listable scope, per-event dedupe, newest first, by day; 100, then the rest
// within 300 px of the end), "Remove from folder", the empty state and "Add notes".
//
// A folder's page has Notes, People and Companies tabs; folders open on Notes.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type JSX } from 'react'
import { parseError } from '@shared/errors'
import { MY_NOTES_SECTION_ID, NOTE_DRAG_MIME, type Folder } from '@shared/types/folders'
import type { NoteListItem } from '@shared/types/notes'
import { IconPlus } from '../../app/icons'
import { navigate } from '../../app/navigation'
import { debugLog, isTextTarget } from '../../app/platform'
import { readViewState, saveViewState } from '../../app/scroll-memory'
import { ListChatInput } from '../chat'
import { FolderCompaniesTab } from '../companies'
import { FolderPeopleTab } from '../people'
import { SeriesFolderPanel } from '../sources'
import { FolderIntegrationsPanel } from '../integrations'
import { ActionMenu, type ActionMenuEntry } from '../note-page/ActionMenu'
import { NuxTip } from '../nux'
import { setPrefs, usePrefs } from '../settings/prefs-store'
import { IconOpen } from '../trash'
import { addNotesToFolder, removeNoteFromFolder } from './actions'
import { openAddNotes, openCreateFolder, openFolderSettings } from './dialogs'
import { FolderGlyph, IconChevronRight, IconDots, IconFolderMinus, IconSparkles, IconSpaces } from './icons'
import { IconPicker } from './IconPicker'
import { anotherModalOpen } from './Modal'
import { NoteList } from './NoteList'
import { folderMenuEntries } from './SidebarFolders'
import { foldersLoads, refreshFolders, useFolders, useFoldersLoads } from './store'
import { ancestors, childrenOf, folderTitle } from './tree'
import './folders.css'

const FIRST_PAGE = 100
const LOAD_MORE_PX = 300
const COMPACT_AFTER_PX = 48

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; items: NoteListItem[]; hasMore: boolean }

type FolderTab = 'notes' | 'people' | 'companies'

interface FolderViewState {
  scrollTop: number
  all: boolean
  tab?: FolderTab
}

const FOLDER_TABS: { value: FolderTab; label: string }[] = [
  { value: 'notes', label: 'Notes' },
  { value: 'people', label: 'People' },
  { value: 'companies', label: 'Companies' }
]

/** The page's scroll container (the shell's FramedPage `.page__scroll`). */
function useScrollContainer(): [(el: HTMLElement | null) => void, HTMLElement | null] {
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null)
  const attach = useCallback((el: HTMLElement | null) => {
    setScrollEl((el?.closest('.page__scroll') as HTMLElement | null) ?? null)
  }, [])
  return [attach, scrollEl]
}

export function FolderPageView({ id }: { id: string }): JSX.Element {
  const view = useFolders()
  const loads = useFoldersLoads()
  // A folder created a moment ago may not be in the mirror yet: decide only on a load
  // that started after this page mounted.
  const [mountedAt] = useState(() => foldersLoads())
  useEffect(() => {
    void refreshFolders()
  }, [id])
  const settled = loads > mountedAt
  const isSection = id === MY_NOTES_SECTION_ID
  const folder = isSection ? undefined : view?.byId.get(id)
  const viewKey = `folder:${id}`
  const saved = useRef(readViewState<FolderViewState>(viewKey))
  const [all, setAll] = useState(saved.current?.all ?? false)
  const [tab, setTab] = useState<FolderTab>(saved.current?.tab ?? 'notes')
  const [list, setList] = useState<ListState>({ status: 'loading' })
  const [attach, scrollEl] = useScrollContainer()
  const [compact, setCompact] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [dropping, setDropping] = useState(false)
  const iconRef = useRef<HTMLButtonElement>(null)
  const scrollTop = useRef(saved.current?.scrollTop ?? 0)
  const restored = useRef(false)
  const request = useRef(0)

  // An unknown id goes home once folders have loaded.
  const unknown = !isSection && settled && view !== null && !folder
  useEffect(() => {
    if (unknown) navigate('/', { replace: true })
  }, [unknown])

  useEffect(() => {
    debugLog('folder-opened', { id })
  }, [id])

  const load = useCallback(
    async (everything: boolean): Promise<void> => {
      const req = ++request.current
      try {
        const page = await window.notula.notes.list({
          scope: 'own',
          folderId: id,
          ...(everything ? {} : { limit: FIRST_PAGE })
        })
        if (req !== request.current) return
        setList({ status: 'ready', items: page.items, hasMore: page.hasMore })
      } catch (err) {
        if (req !== request.current) return
        const message = parseError(err).message
        setList((prev) => (prev.status === 'ready' ? prev : { status: 'error', message }))
      }
    },
    [id]
  )

  useEffect(() => {
    void load(all)
  }, [load, all])

  // Membership and notes change under the page: refresh on both pushes.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const again = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void load(all), 120)
    }
    const offNotes = window.notula.notes.onChanged((c) => {
      if (c.tables.includes('documents') || c.tables.includes('note_panels') || c.tables.includes('calendar_events')) again()
    })
    const offFolders = window.notula.folders.onChanged(() => again())
    return () => {
      offNotes()
      offFolders()
      if (timer) clearTimeout(timer)
    }
  }, [load, all])

  // Scroll: the compact header after 48 px, the rest of the notes within 300 px of the end.
  useEffect(() => {
    if (!scrollEl) return
    const onScroll = (): void => {
      scrollTop.current = scrollEl.scrollTop
      setCompact(scrollEl.scrollTop > COMPACT_AFTER_PX)
      if (!all && list.status === 'ready' && list.hasMore && scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < LOAD_MORE_PX) {
        setAll(true)
      }
    }
    onScroll()
    scrollEl.addEventListener('scroll', onScroll, { passive: true })
    return () => scrollEl.removeEventListener('scroll', onScroll)
  }, [scrollEl, all, list])

  useLayoutEffect(() => {
    if (restored.current || list.status !== 'ready' || !scrollEl) return
    restored.current = true
    if (scrollTop.current > 0) scrollEl.scrollTop = scrollTop.current
  }, [list.status, scrollEl])

  useEffect(
    () => () => saveViewState(viewKey, { scrollTop: scrollTop.current, all, tab } satisfies FolderViewState),
    [viewKey, all, tab]
  )

  // Escape goes home when no dialog or chat is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || anotherModalOpen() || isTextTarget(e.target)) return
      if (document.querySelector('.action-menu, .icon-picker')) return
      navigate('/')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!isSection && !folder) {
    return <div className="folder-page" ref={attach} aria-busy={!settled} />
  }

  const openNote = (noteId: string): void => {
    saveViewState(viewKey, { scrollTop: scrollTop.current, all, tab } satisfies FolderViewState)
    navigate(`/meeting/${encodeURIComponent(noteId)}?opened_from=list_page`)
  }

  const items = list.status === 'ready' ? list.items : []
  const crumbs = folder && view ? ancestors(view, folder.id) : []
  const subfolders = isSection && view ? childrenOf(view, null) : []

  const rowMenu = (item: NoteListItem): ActionMenuEntry[] => {
    const entries: ActionMenuEntry[] = [
      { kind: 'item', id: 'open', label: 'Open', icon: <IconOpen size={16} />, onSelect: () => openNote(item.id) }
    ]
    if (folder) {
      entries.push({
        kind: 'item',
        id: 'remove',
        label: 'Remove from folder',
        icon: <IconFolderMinus size={16} />,
        onSelect: () => void removeNoteFromFolder(folder.id, item.id)
      })
    }
    return entries
  }

  // Notes dragged onto the folder page join it.
  const dropProps = folder
    ? {
        onDragOver: (e: DragEvent) => {
          if (!e.dataTransfer.types.includes(NOTE_DRAG_MIME)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setDropping(true)
        },
        onDragLeave: (e: DragEvent) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
        },
        onDrop: (e: DragEvent) => {
          setDropping(false)
          if (!e.dataTransfer.types.includes(NOTE_DRAG_MIME)) return
          e.preventDefault()
          try {
            const ids: unknown = JSON.parse(e.dataTransfer.getData(NOTE_DRAG_MIME))
            if (Array.isArray(ids)) {
              const notes = ids.filter((x): x is string => typeof x === 'string')
              if (notes.length) void addNotesToFolder(folder.id, notes, 'dragged')
            }
          } catch {
            // Not a note list.
          }
        }
      }
    : {}

  const title = folder ? folderTitle(folder) : 'My notes'

  return (
    <div className={`folder-page${dropping ? ' is-drop' : ''}`} ref={attach} {...dropProps}>
      <div className={`folder-bar${compact ? ' is-compact' : ''}`}>
        <nav className="folder-bar__crumbs" aria-label="Breadcrumb">
          {folder ? (
            <>
              <button type="button" className="folder-bar__crumb" onClick={() => navigate(`/list/${MY_NOTES_SECTION_ID}`)}>
                My notes
              </button>
              {crumbs.map((c) => (
                <span key={c.id} className="folder-bar__step">
                  <IconChevronRight size={12} />
                  <button type="button" className="folder-bar__crumb" onClick={() => navigate(`/list/${encodeURIComponent(c.id)}`)}>
                    {folderTitle(c)}
                  </button>
                </span>
              ))}
              <span className="folder-bar__step folder-bar__current" aria-hidden={!compact}>
                <IconChevronRight size={12} />
                <FolderGlyph icon={folder.icon} size={14} />
                <span>{title}</span>
              </span>
            </>
          ) : (
            <span className="folder-bar__step folder-bar__current" aria-hidden={!compact}>
              <IconSpaces size={14} />
              <span>My notes</span>
            </span>
          )}
        </nav>
        <div className="folder-bar__actions">
          {folder ? (
            <>
              <button type="button" className="n-btn n-btn--ghost n-btn--sm" onClick={() => openAddNotes(folder.id)}>
                <IconPlus size={14} />
                Add notes
              </button>
              <button
                type="button"
                className="n-icon-btn n-icon-btn--sm"
                aria-label="Folder options"
                aria-haspopup="menu"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect()
                  setMenu({ x: r.right - 200, y: r.bottom + 4 })
                }}
              >
                <IconDots size={16} />
              </button>
            </>
          ) : (
            <button type="button" className="n-btn n-btn--ghost n-btn--sm" onClick={() => openCreateFolder({ parentId: null })}>
              <IconPlus size={14} />
              Create folder
            </button>
          )}
        </div>
      </div>

      <div className="folder-page__column">
        <header className="folder-head">
          {folder ? (
            <>
              <button
                ref={iconRef}
                type="button"
                className="folder-head__icon"
                aria-label="Change icon"
                onClick={() => setPickerOpen((o) => !o)}
              >
                <FolderGlyph icon={folder.icon} size={26} />
              </button>
              {pickerOpen && iconRef.current ? (
                <IconPicker
                  anchor={iconRef.current}
                  value={folder.icon}
                  onChange={(icon) => void updateIcon(folder, icon)}
                  onClose={() => setPickerOpen(false)}
                />
              ) : null}
              <button type="button" className="folder-head__title" onClick={() => openFolderSettings(folder.id)}>
                <h1 className={folder.title.trim() ? '' : 'is-untitled'}>{title}</h1>
              </button>
              <button
                type="button"
                className={`folder-head__description${folder.description ? '' : ' is-placeholder'}`}
                onClick={() => openFolderSettings(folder.id)}
              >
                {folder.description || 'Add description'}
              </button>
              {/* The folder's integrations (Slack, Zapier, Attio). */}
              <FolderIntegrationsPanel folderId={folder.id} />
            </>
          ) : (
            <>
              <span className="folder-head__icon is-static" aria-hidden="true">
                <IconSpaces size={24} />
              </span>
              <h1 className="folder-head__static-title">My notes</h1>
              <AiSuggestionsSwitch />
            </>
          )}
        </header>

        {folder ? (
          <div className="folder-page__chat">
            <ListChatInput place={{ kind: 'list', folderId: folder.id }} />
          </div>
        ) : null}

        {folder ? (
          <div className="folder-tabs" role="tablist" aria-label="Folder">
            {FOLDER_TABS.map((t) => (
              <button key={t.value} type="button" role="tab" aria-selected={tab === t.value} className="folder-tabs__tab" onClick={() => setTab(t.value)}>
                {t.label}
              </button>
            ))}
          </div>
        ) : null}

        {folder && tab === 'people' ? <FolderPeopleTab folderId={folder.id} /> : null}
        {folder && tab === 'companies' ? <FolderCompaniesTab folderId={folder.id} /> : null}

        {isSection && subfolders.length > 0 ? (
          <section className="folder-grid" aria-label="Folders">
            {subfolders.map((f) => (
              <FolderCard key={f.id} folder={f} count={view?.membership[f.id]?.length ?? 0} />
            ))}
          </section>
        ) : null}

        <div className="folder-page__notes" hidden={!!folder && tab !== 'notes'}>
          {/* A series folder's lessons in catalog order (content sources). */}
          {folder ? <SeriesFolderPanel folderId={folder.id} /> : null}
          {list.status === 'loading' ? (
            <div className="folder-page__loading" aria-busy="true" aria-label="Loading notes">
              <span className="n-spinner" />
            </div>
          ) : list.status === 'error' ? (
            <div className="folder-empty" role="alert">
              <p className="folder-empty__title">Couldn’t load the notes</p>
              <p className="folder-empty__hint">{list.message}</p>
              <button type="button" className="n-btn n-btn--sm" onClick={() => void load(all)}>
                Try again
              </button>
            </div>
          ) : items.length === 0 ? (
            folder ? (
              <div className="folder-empty">
                {/* The empty-folder tip, once per folder. */}
                <NuxTip id={`folder-empty:${folder.id}`} />
                <p className="folder-empty__title">No notes here yet</p>
                <p className="folder-empty__hint">Add notes to keep related meetings together</p>
                <button type="button" className="n-btn n-btn--sm" onClick={() => openAddNotes(folder.id)}>
                  <IconPlus size={14} />
                  Add notes
                </button>
              </div>
            ) : (
              <div className="folder-empty">
                <p className="folder-empty__title">No notes yet</p>
              </div>
            )
          ) : (
            <NoteList
              items={items}
              scrollEl={scrollEl}
              label={folder ? `Notes in ${title}` : 'My notes'}
              onOpen={openNote}
              menu={rowMenu}
              {...(folder
                ? {
                    action: {
                      label: 'Remove from folder',
                      icon: <IconFolderMinus size={15} />,
                      run: (item: NoteListItem) => void removeNoteFromFolder(folder.id, item.id)
                    }
                  }
                : {})}
            />
          )}
          {all && list.status === 'ready' && list.hasMore ? (
            <div className="folder-page__loading" aria-label="Loading more notes">
              <span className="n-spinner" />
            </div>
          ) : null}
        </div>
      </div>

      {menu && folder ? (
        <ActionMenu
          label="Folder options"
          anchor={{ point: menu }}
          entries={folderMenuEntries(folder, { inHeader: true })}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  )
}

async function updateIcon(folder: Folder, icon: Folder['icon']): Promise<void> {
  try {
    await window.notula.folders.update({ id: folder.id, patch: { icon } })
    refreshFolders()
  } catch (err) {
    debugLog('folders:icon-failed', { err: parseError(err) })
  }
}

function FolderCard({ folder, count }: { folder: Folder; count: number }): JSX.Element {
  return (
    <button type="button" className="folder-card" onClick={() => navigate(`/list/${encodeURIComponent(folder.id)}`)}>
      <FolderGlyph icon={folder.icon} size={18} />
      <span className={`folder-card__title${folder.title.trim() ? '' : ' is-untitled'}`}>{folderTitle(folder)}</span>
      <span className="folder-card__count">{count}</span>
    </button>
  )
}

/**
 * "Suggest folders with AI" (`folders.aiSuggestions`): off by default. On, a note's
 * title and the start of its summary go to the user's own AI provider after a summary
 * generates, to suggest one of their folders.
 */
function AiSuggestionsSwitch(): JSX.Element {
  const prefs = usePrefs()
  const on = prefs?.['folders.aiSuggestions'] ?? false
  return (
    <label className="ai-switch" title="Sends a note's title and the start of its summary to your AI provider">
      <IconSparkles size={15} />
      <span>Suggest folders with AI</span>
      <input
        type="checkbox"
        role="switch"
        className="ai-switch__input"
        checked={on}
        disabled={!prefs}
        onChange={(e) => setPrefs({ 'folders.aiSuggestions': e.target.checked })}
      />
    </label>
  )
}
