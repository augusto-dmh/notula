// SPDX-License-Identifier: Apache-2.0
// Course apps: installed Chrome and Edge web apps, mapped from their media-session app id
// (`Chrome._crx_<id>`, an Edge app's AppUserModel ID) to browser, profile, app id, name and host.
// The mapping reads the browsers' own Web Applications folders and the Start menu and Desktop
// shortcuts, on demand, and is cached until an unknown app id appears.
//
// Not written yet: every app id answers `unmapped`, and the list is empty.

import type { AppMapping } from '@shared/types/sources'

/** The installed browser web apps (the reader's `apps` command). */
export async function listApps(): Promise<AppMapping[]> {
  return []
}

/** One app id's mapping; `ignored` for an id that isn't a browser web app. */
export async function mapApp(appUserModelId: string): Promise<AppMapping> {
  const browser: AppMapping['browser'] = appUserModelId.startsWith('Chrome') ? 'chrome' : 'edge'
  return { appUserModelId, browser, profile: null, appId: null, name: null, host: null, state: 'unmapped' }
}
