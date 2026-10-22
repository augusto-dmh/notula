// SPDX-License-Identifier: Apache-2.0
// The bubble's shared state for the other live-meeting modules: captions and snapshots read the bubble's
// document and window, and ask for the side card (the inactivity window, which also shows the
// screen-snapshot notices). One process-wide instance; `registerBubble` fills it.

import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import type { BubbleDocument } from '@shared/types/bubble'

interface HubEvents {
  /** The main window sent a new bubble document. */
  document: [BubbleDocument | null]
  /** A module changed what the side card or the hover panel should show. */
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
  /** Screen snapshots have a notice for the side card. */
  snapshotNotice = false
}

export const bubbleHub = new BubbleHub()
