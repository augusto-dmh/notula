// SPDX-License-Identifier: Apache-2.0
// NotulaEditor (its contract is types.ts): TipTap bound to the Yjs room through the IPC provider.
// `roomIdFor` is the contract's room-id format.

import { YDOC_ROOM_VERSION, type YdocContentType } from '@shared/types/ydoc'

export { NotulaEditor } from './NotulaEditor'
export type { EditorHandle, NotulaEditorProps } from './types'
export { normalizeMarkdown } from './schema'
// Copy and export, and the page scope every editor reads.
export { copyFlavors, copyHeaderFor, writeCopyFlavors, writeCopyText, type CopyFlavors, type CopyHeader } from './copy'
export { EditorScopeContext, type EditorScope } from './scope'
export { readRoomHtml } from './room'
// Thumbs on summary lines that state action items.
export { normalizeHeading, setActionItemThumbs, type ThumbClick, type ThumbDirection, type ThumbsSource } from './action-item-thumbs'

/** `'<contentType>:<version>:<contentId>'`, e.g. `notes:1:<noteId>`. */
export function roomIdFor(type: YdocContentType, id: string): string {
  return `${type}:${YDOC_ROOM_VERSION}:${id}`
}
