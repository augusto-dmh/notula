// SPDX-License-Identifier: Apache-2.0
// Content sources in the renderer: the note header's source chip, the new-note flow's sources
// branch, the `source-detected` card, Settings ▸ Sources and a series folder's view. Each export
// is a slot; the files behind it hold the views.

import { createElement, type JSX } from 'react'
import { SourceChipView } from './note/SourceChip'
import { SeriesFolderPanelView } from './series/SeriesFolderPanel'
import { SourcesSettingsPage } from './settings/SourcesSettings'

export { openSourceNote } from './note/open-source-note'
export { SourceDetectedCard } from './note/SourceDetectedCard'

/** The note header, below the attendees. */
export function SourceChip({ noteId }: { noteId: string }): JSX.Element {
  return createElement(SourceChipView, { noteId })
}

/** Settings ▸ Sources (the page, with its named rows). */
export function SourcesSettings(): JSX.Element {
  return createElement(SourcesSettingsPage)
}

/** The folder page of a series folder. */
export function SeriesFolderPanel({ folderId }: { folderId: string }): JSX.Element {
  return createElement(SeriesFolderPanelView, { folderId })
}
