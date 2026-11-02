// SPDX-License-Identifier: Apache-2.0
// Course apps, the cache half: the installed-app inventory and each app id's mapping, kept between
// the reader's `apps` answers. The reader call, the clock and the log come in as dependencies, so
// the dev harness (scripts/dev/media-replay.mjs) runs it with a fake reader and a fake clock;
// `apps.ts` holds the one instance of this app run.
//
// - The inventory is read on demand. An app id it doesn't map is read again at most once a
//   minute; a read that failed (no answer, an error, a reader not running) waits 10 s.
// - Every mapping is kept, with or without an inventory, so a session line never asks twice for
//   the same id within those gaps. One that isn't `mapped` is asked again after its gap; every
//   mapping is redone once a new inventory arrives.
// - `resolve` never waits and never calls back synchronously: it answers what it knows, checks a
//   stale mapping in the background, and calls `changed` only when a mapping arrives or changes.
//   Mapping an app can never trigger itself (the main-process loop found in review).

import type { AppMapping } from '../../shared/types/sources'
import { inventoryFromRecord, listFromInventory, mapFromInventory, type AppInventory } from './app-map'

/** An app id the inventory doesn't map reads it again after this long. */
export const APP_REFRESH_MS = 60_000
/** A failed inventory read is tried again after this long. */
export const APP_RETRY_MS = 10_000

const EMPTY: AppInventory = { shortcuts: [], folders: [] }

export interface AppCacheDeps {
  /** The reader's `apps` record; null when it didn't answer. */
  readApps: () => Promise<Record<string, unknown> | null>
  now?: () => number
  /** Counts and states only. */
  log?: (event: string, data: Record<string, unknown>) => void
}

export interface AppCache {
  /** The installed browser web apps. */
  listApps(): Promise<AppMapping[]>
  /** The last mapping of an app id, whatever its age; undefined before the first. */
  cachedMapping(appUserModelId: string): AppMapping | undefined
  /** One app id's mapping, read again when stale; `ignored` for an id that isn't a browser web app. */
  mapApp(appUserModelId: string): Promise<AppMapping>
  /**
   * The mapping a session line uses now: the last one known, or undefined before the first. A
   * missing or stale one is checked in the background; `changed` runs later, once, when that
   * check gives a different answer.
   */
  resolve(appUserModelId: string, changed: () => void): AppMapping | undefined
}

interface Entry {
  m: AppMapping
  at: number
  /** The inventory generation it was mapped from (0: none read yet). */
  gen: number
  /** How long an answer that isn't `mapped` stands. */
  ttl: number
}

function sameMapping(a: AppMapping | undefined, b: AppMapping | undefined): boolean {
  if (!a || !b) return a === b
  return a.state === b.state && a.browser === b.browser && a.profile === b.profile && a.appId === b.appId && a.name === b.name && a.host === b.host
}

export function createAppCache(deps: AppCacheDeps): AppCache {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => undefined)
  let inventory: AppInventory | null = null
  let gen = 0
  let readAt = 0
  let failedAt = Number.NEGATIVE_INFINITY
  let reading: Promise<AppInventory | null> | null = null
  const mapped = new Map<string, Entry>()
  const checking = new Set<string>()

  function fresh(e: Entry): boolean {
    return e.gen === gen && (e.m.state === 'mapped' || now() - e.at < e.ttl)
  }

  function refresh(): Promise<AppInventory | null> {
    if (reading) return reading
    // A reader that didn't answer is asked again 10 s later, not on every sessions line.
    if (now() - failedAt < APP_RETRY_MS) return Promise.resolve(null)
    reading = (async () => {
      const t0 = now()
      let rec: Record<string, unknown> | null = null
      try {
        rec = await deps.readApps()
      } catch {
        rec = null
      }
      // A reader that failed its scan answers an empty list with `error`: no inventory either.
      const inv = rec && rec['error'] !== true ? inventoryFromRecord(rec) : null
      if (inv) {
        inventory = inv
        gen++
        readAt = now()
      } else {
        // The cache stays as it was.
        failedAt = now()
      }
      log('media:apps', { shortcuts: inv?.shortcuts.length ?? 0, folders: inv?.folders.length ?? 0, ms: now() - t0, ok: !!inv })
      return inv
    })().finally(() => {
      reading = null
    })
    return reading
  }

  async function mapApp(appUserModelId: string): Promise<AppMapping> {
    const hit = mapped.get(appUserModelId)
    if (hit && fresh(hit)) return hit.m
    let inv = inventory
    let m = inv ? mapFromInventory(inv, appUserModelId) : null
    if ((!m || m.state !== 'mapped') && (!inv || now() - readAt >= APP_REFRESH_MS)) {
      inv = (await refresh()) ?? inv
      m = inv ? mapFromInventory(inv, appUserModelId) : null
    }
    const result = m ?? mapFromInventory(EMPTY, appUserModelId)
    // Kept even without an inventory: the next try waits for the retry gap, not the next line.
    mapped.set(appUserModelId, { m: result, at: now(), gen: inv ? gen : 0, ttl: inv ? APP_REFRESH_MS : APP_RETRY_MS })
    if (mapped.size > 256) mapped.delete(mapped.keys().next().value as string)
    log('media:app-mapped', { state: result.state })
    return result
  }

  function resolve(appUserModelId: string, changed: () => void): AppMapping | undefined {
    const hit = mapped.get(appUserModelId)
    if ((hit && fresh(hit)) || checking.has(appUserModelId)) return hit?.m
    checking.add(appUserModelId)
    const before = hit?.m
    mapApp(appUserModelId)
      .then(
        (m) => {
          checking.delete(appUserModelId)
          if (!sameMapping(before, m)) changed()
        },
        (err: unknown) => {
          checking.delete(appUserModelId)
          log('media:app-map-failed', { err: err instanceof Error ? err.name : 'error' })
        }
      )
    return before
  }

  return {
    async listApps() {
      const inv = (await refresh()) ?? inventory
      return inv ? listFromInventory(inv) : []
    },
    cachedMapping(appUserModelId) {
      return mapped.get(appUserModelId)?.m
    },
    mapApp,
    resolve
  }
}
