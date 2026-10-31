// SPDX-License-Identifier: Apache-2.0
// The bubble's shared state for the other live-meeting modules: captions and snapshots read the bubble's
// document and window, and ask for a card inside the bubble (the inactivity warning, the
// screen-snapshot notices, off the record). One process-wide instance; `registerBubble` fills it.

import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import type { BubbleDocument, BubbleOffRecord } from '@shared/types/bubble'

interface HubEvents {
  /** The main window sent a new bubble document. */
  document: [BubbleDocument | null]
  /** A module changed what the bubble's card or the hover panel should show. */
  'side-card': []
  /** The bubble was shown or hidden. */
  visible: [boolean]
}

class BubbleHub extends EventEmitter<HubEvents> {
  doc: BubbleDocument | null = null
  visible = false
  bubble: BrowserWindow | null = null
  /** Captions own the hover: while active, the hover panel shows its compact form. */
  captionsActive = false
  /** Screen snapshots have a notice for the bubble's card. */
  snapshotNotice = false
  /**
   * Set by the off-the-record module while its prompt waits for an answer; it emits
   * `side-card` after each change. The card shows the bubble even over a focused main
   * window, unless that window shows this very note.
   */
  offRecord: BubbleOffRecord | null = null
}

export const bubbleHub = new BubbleHub()
