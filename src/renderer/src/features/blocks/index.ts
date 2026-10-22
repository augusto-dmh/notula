// SPDX-License-Identifier: Apache-2.0
// The draft-block cards. App calls `registerBlockCards()` once; chat's Conversation
// renders the registered card for a tool call.

import { registerToolCard } from '../../app/slots'
import { CalendarDraftCard } from '../calendar-write'
import { ConnectorActionCard, GoogleDocCard } from '../file-connectors'
import { EmailDraftCard } from '../mail'

let registered = false

/** Registers the tool cards in app/slots.ts; called once by App. */
export function registerBlockCards(): void {
  if (registered) return
  registered = true
  registerToolCard('proposeEvent', CalendarDraftCard)
  registerToolCard('draftFollowUpEmail', EmailDraftCard)
  registerToolCard('readDriveDoc', GoogleDocCard)
  for (const key of ['google_drive', 'onedrive', 'dropbox']) {
    registerToolCard(`files_search_${key}`, ConnectorActionCard)
    registerToolCard(`files_read_${key}`, ConnectorActionCard)
  }
}
