// SPDX-License-Identifier: Apache-2.0
// Paths to Notula's own icons under `resources/` (tray, jump list, join icons).
// Packaged builds copy the folder next to app.asar (electron-builder `extraResources`);
// dev and unpackaged runs read it from the project root.

import { join } from 'node:path'
import { app } from 'electron'

export function resourcePath(name: string): string {
  return app.isPackaged ? join(process.resourcesPath, 'resources', name) : join(app.getAppPath(), 'resources', name)
}
