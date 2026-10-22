// SPDX-License-Identifier: Apache-2.0
// The Salesforce, Pipedrive and Ashby cards, share items and folder rows.

import { registerIntegrationSlot } from '../../app/slots'
import { mountDialogHost, PlusFolderRow, PlusSettingsCard, PlusShareItem } from './Cards'

let registered = false

/** Registers the cards, share items and folder rows in app/slots.ts; called once by App. */
export function registerIntegrationPlusSlots(): void {
  if (registered) return
  registered = true
  for (const p of ['salesforce', 'pipedrive', 'ashby'] as const) {
    registerIntegrationSlot('settings-card', p, PlusSettingsCard)
    registerIntegrationSlot('share-item', p, PlusShareItem)
    registerIntegrationSlot('folder-row', p, PlusFolderRow)
  }
  mountDialogHost()
}
