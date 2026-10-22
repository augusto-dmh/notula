// SPDX-License-Identifier: Apache-2.0
// Integrations: Settings ▸ Integrations, the
// dialogs host, the note's Share menu and the folder panel.

import { requestFolderPanel } from './store'

export { IntegrationsSettings } from './Settings'
export { IntegrationsDialogsHost } from './dialogs'
export { NoteShareMenu } from './ShareMenu'
export { FolderIntegrationsPanel } from './FolderPanel'

/** The folder options menu's "Integrations": opens and scrolls to the folder's panel. */
export function openFolderIntegrations(folderId: string): void {
  requestFolderPanel(folderId)
}
