// SPDX-License-Identifier: Apache-2.0
// Course apps: installed Chrome and Edge web apps, mapped from their media-session app id
// (`Chrome._crx_<id>`, an Edge app's AppUserModel ID) to browser, profile, app id, name and host.
// The reader's `apps` command lists the browsers' app shortcuts (Start menus, Desktops) and the
// folder names under each profile's Web Applications folder, on demand; the parsing and matching
// live in `app-map.ts`.
//
// - The inventory is cached. An app id it doesn't know refreshes it, at most once a minute.
// - Mappings are cached by app id until the inventory changes; one that isn't `mapped` is asked
//   again after a minute (an app installed since).
// - Logs carry counts and states only: never names, hosts or app ids.

import type { AppMapping } from '@shared/types/sources'
import { log } from '../log'
import { inventoryFromRecord, listFromInventory, mapFromInventory, type AppInventory } from './app-map'
import { mediaReader } from './host'

const REFRESH_MS = 60_000
const RETRY_MS = 10_000

let inventory: AppInventory | null = null
let readAt = 0
let failedAt = 0
let reading: Promise<AppInventory | null> | null = null
const mapped = new Map<string, { m: AppMapping; at: number }>()

async function refresh(): Promise<AppInventory | null> {
  if (reading) return reading
  // A reader that didn't answer is asked again 10 s later, not on every sessions line.
  if (Date.now() - failedAt < RETRY_MS) return null
  reading = (async () => {
    const t0 = Date.now()
    const rec = await mediaReader.apps()
    const inv = rec ? inventoryFromRecord(rec) : null
    // A reader that isn't running leaves the cache as it was.
    if (!inv) failedAt = Date.now()
    if (inv) {
      inventory = inv
      readAt = Date.now()
      mapped.clear()
    }
    log('debug', 'media:apps', { shortcuts: inv?.shortcuts.length ?? 0, folders: inv?.folders.length ?? 0, ms: Date.now() - t0, ok: !!inv })
    return inv
  })().finally(() => {
    reading = null
  })
  return reading
}

/** The installed browser web apps (the reader's `apps` command). */
export async function listApps(): Promise<AppMapping[]> {
  const inv = (await refresh()) ?? inventory
  return inv ? listFromInventory(inv) : []
}

/** The cached mapping of an app id, or undefined before `mapApp` has answered for it. */
export function cachedMapping(appUserModelId: string): AppMapping | undefined {
  return mapped.get(appUserModelId)?.m
}

/** One app id's mapping; `ignored` for an id that isn't a browser web app. */
export async function mapApp(appUserModelId: string): Promise<AppMapping> {
  const hit = mapped.get(appUserModelId)
  if (hit && (hit.m.state === 'mapped' || Date.now() - hit.at < REFRESH_MS)) return hit.m
  let inv = inventory
  let m = inv ? mapFromInventory(inv, appUserModelId) : null
  if ((!m || m.state !== 'mapped') && (!inv || Date.now() - readAt >= REFRESH_MS)) {
    inv = (await refresh()) ?? inv
    m = inv ? mapFromInventory(inv, appUserModelId) : null
  }
  const result = m ?? mapFromInventory({ shortcuts: [], folders: [] }, appUserModelId)
  // Without an inventory nothing is known yet: answer, but don't keep it.
  if (inv) mapped.set(appUserModelId, { m: result, at: Date.now() })
  log('debug', 'media:app-mapped', { state: result.state })
  return result
}
