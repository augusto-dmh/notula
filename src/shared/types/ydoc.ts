// SPDX-License-Identifier: Apache-2.0
// The Yjs update log. Room id format: '<contentType>:<version>:<contentId>', e.g.
// `notes:1:<noteId>` or `summary:1:<panelId>`.

export type YdocContentType = 'notes' | 'summary'

export const YDOC_ROOM_VERSION = 1

/** The XmlFragment name the editor binds to. */
export const YDOC_FRAGMENT = 'prosemirror'

export interface YdocState {
  /** Every row of the room merged, or null for an empty room. */
  update: Uint8Array | null
  /** The highest applied seq. */
  seq: number
}

export interface YdocUpdated {
  roomId: string
  update: Uint8Array
  seq: number
  origin: string
}
