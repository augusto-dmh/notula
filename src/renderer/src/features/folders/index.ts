// SPDX-License-Identifier: Apache-2.0
// Folders and lists in the renderer: the sidebar folders, the folder page and the
// suggestion bar. The rest serves the command palette and the search page.

import { createElement, type JSX } from 'react'
import { FolderPageView } from './FolderPage'
import { SidebarFolders as Sidebar } from './SidebarFolders'
import { SuggestionBar } from './SuggestionBar'

/** `hidden`: folders shown elsewhere (course folders, under Courses). */
export function SidebarFolders({ hidden }: { hidden?: ReadonlySet<string> } = {}): JSX.Element | null {
  return createElement(Sidebar, { hidden })
}

/** `/list/:id`, including `/list/my-notes`. */
export function FolderPage({ id }: { id: string }): JSX.Element {
  return createElement(FolderPageView, { id })
}

/** Under the note header (NotePage, D): the recurring-series and AI folder suggestion. */
export function FolderSuggestionBar({ noteId }: { noteId: string }): JSX.Element | null {
  return createElement(SuggestionBar, { key: noteId, noteId })
}

export { addNotesToFolder, removeNoteFromFolder } from './actions'
export { FolderDialogsHost, openCreateFolder } from './dialogs'
export { FolderPreferencesRows } from './FolderPreferencesRows'
export { FolderGlyph, IconFolder, IconFolderMinus, IconFolderPlus, IconChevronRight, IconArrowLeft } from './icons'
export { anotherModalOpen } from './Modal'
export { NoteList } from './NoteList'
export { getFolders, useFolders, type FoldersView } from './store'
export { folderTitle, rankForAdding } from './tree'
