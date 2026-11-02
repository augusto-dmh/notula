// SPDX-License-Identifier: Apache-2.0
// Course apps: installed Chrome and Edge web apps, mapped from their media-session app id
// (`Chrome._crx_<id>`, an Edge app's AppUserModel ID) to browser, profile, app id, name and host.
// The reader's `apps` command lists the browsers' app shortcuts (Start menus, Desktops) and the
// folder names under each profile's Web Applications folder, on demand; the parsing and matching
// live in `app-map.ts`, the cache and its refresh rules in `app-cache.ts`.
//
// - The inventory is cached. An app id it doesn't know refreshes it, at most once a minute; a
//   failed read waits 10 s.
// - Mappings are cached by app id until the inventory changes; one that isn't `mapped` is asked
//   again after a minute (an app installed since).
// - Logs carry counts and states only: never names, hosts or app ids.

import type { AppMapping } from '@shared/types/sources'
import { log } from '../log'
import { createAppCache } from './app-cache'
import { mediaReader } from './host'

const cache = createAppCache({
  readApps: () => mediaReader.apps(),
  log: (event, data) => log('debug', event, data)
})

/** The installed browser web apps (the reader's `apps` command). */
export async function listApps(): Promise<AppMapping[]> {
  return cache.listApps()
}

/** The cached mapping of an app id, or undefined before `mapApp` has answered for it. */
export function cachedMapping(appUserModelId: string): AppMapping | undefined {
  return cache.cachedMapping(appUserModelId)
}

/** One app id's mapping; `ignored` for an id that isn't a browser web app. */
export async function mapApp(appUserModelId: string): Promise<AppMapping> {
  return cache.mapApp(appUserModelId)
}

/**
 * A session line's mapping of an app id, without waiting: undefined before the first answer.
 * `changed` runs later, once, when a missing or stale mapping is answered differently.
 */
export function resolveApp(appUserModelId: string, changed: () => void): AppMapping | undefined {
  return cache.resolve(appUserModelId, changed)
}
