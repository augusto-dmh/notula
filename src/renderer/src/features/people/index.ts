// SPDX-License-Identifier: Apache-2.0
// People: `/people`, `/person/:email` and the sidebar's
// People and Companies buttons, plus the folder page's People tab.

import { createElement, type JSX } from 'react'
import { PeoplePageView } from './PeoplePage'
import { PersonPageView } from './PersonPage'
import { SidebarPeopleButtonsView } from './SidebarPeopleButtons'
import './people.css'

/** `/people`. */
export function PeoplePage(): JSX.Element {
  return createElement(PeoplePageView)
}

/** `/person/:email`. */
export function PersonPage({ email }: { email: string }): JSX.Element {
  return createElement(PersonPageView, { key: email, email })
}

/** The sidebar footer: People and Companies icon buttons, before Trash. */
export function SidebarPeopleButtons(): JSX.Element {
  return createElement(SidebarPeopleButtonsView)
}

export { FolderPeopleTab } from './FolderPeopleTab'
export {
  DirectoryEmpty,
  DirectoryHeader,
  DirectoryLoading,
  DirectoryTable,
  lastNoteLabel,
  relativeDay,
  usePeopleChanged,
  useScrollContainer,
  useSort,
  type Column
} from './directory'
export { DomainLink, NotesSwitch, useCompact, useScopedNotes } from './PersonPage'
export { IconBuilding, IconStar } from './icons'
