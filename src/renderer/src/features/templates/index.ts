// SPDX-License-Identifier: Apache-2.0
// Note templates in the renderer: the template chip in the note header, the gallery
// (manage and apply) and its host. This module holds the public signatures; the bodies
// live in the files below.

import { createElement, type JSX } from 'react'
import type { EditorHandle } from '../../editor/types'
import { TemplateChipView } from './TemplateChip'
import { GalleryHost, openGallery } from './TemplateGallery'

export type TemplateGalleryOptions =
  | { mode: 'manage' }
  | { mode: 'apply'; noteId: string; editor: EditorHandle | null; createNew?: boolean }

export function TemplateChip({
  noteId,
  hasSummary,
  editor
}: {
  noteId: string
  hasSummary: boolean
  editor: EditorHandle | null
}): JSX.Element | null {
  return createElement(TemplateChipView, { noteId, hasSummary, editor })
}

/** Mounted once in App; hosts the gallery dialog. */
export function TemplateGalleryHost(): JSX.Element | null {
  return createElement(GalleryHost)
}

export function openTemplateGallery(opts: TemplateGalleryOptions): void {
  openGallery(opts)
}

// For the AI notes menu.
export { pickForNote } from './apply'
export { displayTitle, quickPicks, searchTemplates } from './order'
export { TemplateIconView } from './icons'
export {
  notesEditorFor,
  temporaryTemplateId,
  useFavoriteIds,
  useTemplateUsage,
  useTemplates,
  useTemporaryTemplateId
} from './store'
