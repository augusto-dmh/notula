// SPDX-License-Identifier: Apache-2.0
// Tips and What's new: the `nux:*` IPC; notes in whats-new.json.
//
// - Tip state lives in the encrypted settings: `nux.dismissed` (tip id → time) and
//   `nux.counters` (counter id → number), both main-only, changed only by these channels. Writes are
//   serialized, so quick sends never lose one another.
// - A counter that reaches its limit (`NUX_COUNTER_LIMITS`: the slash menu at 3) also
//   dismisses its tip.
// - "Reset tips" empties both maps. What's new dismissals are kept: the card is an announcement,
//   not a tip, and it shows once per version.
// - What's new: `whats-new.json` is keyed by version. The card shows when the
//   version changed since the last start and has an entry, until it is dismissed as
//   `whats-new:<version>`. A fresh profile has no version change, so it never sees the card.
// Nothing is reported: at most a debug log line.

import { app, ipcMain } from 'electron'
import type { InvokeChannel, InvokeRes, SendChannel } from '@shared/ipc'
import type { IsoTime } from '@shared/types/common'
import { NUX_COUNTER_LIMITS, type WhatsNewEntry } from '@shared/types/nux'
import type { MainContext } from '../context'
import { log } from '../log'
import notes from './whats-new.json'

const ID = /^[a-z0-9][a-z0-9:._-]{0,199}$/i
const DISMISSED_MAX = 2_000
const COUNTERS_MAX = 100
const COUNTER_MAX = 1_000_000
const WHATS_NEW_PREFIX = 'whats-new:'
/** Tips that can come back (a new calendar failure), so each dismissal records its own time. */
const REPEATABLE = new Set(['calendar-error'])

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function idOf(req: unknown): string | null {
  const id = isObject(req) ? req['id'] : null
  return typeof id === 'string' && ID.test(id) ? id : null
}

/** The bundled entry for `version`, trimmed to the card's shape (≤ 3 lines). */
export function whatsNewEntry(version: string): WhatsNewEntry | null {
  const raw = (notes as Record<string, unknown>)[version]
  if (!isObject(raw) || typeof raw['title'] !== 'string' || !Array.isArray(raw['lines'])) return null
  const lines = raw['lines'].filter((l): l is string => typeof l === 'string' && l.trim() !== '').slice(0, 3)
  return { version, title: raw['title'], lines }
}

/** Keeps the newest `max` entries of a dismissal map. */
function capDismissed(map: Record<string, IsoTime>): Record<string, IsoTime> {
  const keys = Object.keys(map)
  if (keys.length <= DISMISSED_MAX) return map
  const kept = keys.sort((a, b) => (map[b] ?? '').localeCompare(map[a] ?? '')).slice(0, DISMISSED_MAX)
  return Object.fromEntries(kept.map((k) => [k, map[k] as IsoTime]))
}

export interface NuxApi {
  dismiss(id: string): Promise<void>
  increment(id: string): Promise<void>
  reset(): Promise<void>
  whatsNew(): Promise<WhatsNewEntry | null>
}

export function createNux(ctx: MainContext): NuxApi {
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => undefined)
    return next
  }
  const now = (): IsoTime => new Date().toISOString() as IsoTime

  const dismissNow = async (id: string): Promise<void> => {
    const map = await ctx.settings.get('nux.dismissed')
    if (map[id] && !REPEATABLE.has(id)) return
    await ctx.settings.set('nux.dismissed', capDismissed({ ...map, [id]: now() }))
    log('debug', 'nux:dismissed', { id })
  }

  return {
    dismiss: (id) => serial(() => dismissNow(id)),
    increment: (id) =>
      serial(async () => {
        const counters = await ctx.settings.get('nux.counters')
        if (!(id in counters) && Object.keys(counters).length >= COUNTERS_MAX) return
        const n = Math.min(COUNTER_MAX, (counters[id] ?? 0) + 1)
        await ctx.settings.set('nux.counters', { ...counters, [id]: n })
        const limit = (NUX_COUNTER_LIMITS as Record<string, number>)[id]
        if (limit !== undefined && n >= limit) await dismissNow(id)
      }),
    reset: () =>
      serial(async () => {
        const map = await ctx.settings.get('nux.dismissed')
        const kept = Object.fromEntries(Object.entries(map).filter(([k]) => k.startsWith(WHATS_NEW_PREFIX)))
        await ctx.settings.set('nux.dismissed', kept)
        await ctx.settings.set('nux.counters', {})
        log('debug', 'nux:reset')
      }),
    whatsNew: async () => {
      const version = app.getVersion()
      const entry = whatsNewEntry(version)
      if (!entry) return null
      const dismissed = await ctx.settings.get('nux.dismissed')
      return dismissed[`${WHATS_NEW_PREFIX}${version}`] ? null : entry
    }
  }
}

/** On a version change the card may show; a fresh profile records its version and skips it. */
async function noteVersion(ctx: MainContext, nux: NuxApi): Promise<void> {
  const version = app.getVersion()
  const last = await ctx.settings.get('nux.lastSeenVersion')
  if (last === version) return
  if (last === null) await nux.dismiss(`${WHATS_NEW_PREFIX}${version}`)
  await ctx.settings.set('nux.lastSeenVersion', version)
  log('debug', 'nux:version', { from: last, to: version })
}

export function registerNux(ctx: MainContext): void {
  const nux = createNux(ctx)
  const version = (): void => {
    void noteVersion(ctx, nux).catch((err: unknown) => log('debug', 'nux:version-deferred', { err: err instanceof Error ? err.message : String(err) }))
  }
  version()
  ctx.bus.on('storage:status', (s) => {
    if (s.state === 'ready') version()
  })

  ipcMain.on('nux:dismiss' satisfies SendChannel, (_e, req: unknown) => {
    const id = idOf(req)
    if (id) void nux.dismiss(id).catch((err: unknown) => log('warn', 'nux:dismiss-failed', { err }))
  })
  ipcMain.on('nux:increment' satisfies SendChannel, (_e, req: unknown) => {
    const id = idOf(req)
    if (id) void nux.increment(id).catch((err: unknown) => log('warn', 'nux:increment-failed', { err }))
  })
  ipcMain.handle('nux:reset' satisfies InvokeChannel, (): Promise<InvokeRes<'nux:reset'>> => nux.reset())
  ipcMain.handle('nux:whats-new' satisfies InvokeChannel, (): Promise<InvokeRes<'nux:whats-new'>> => nux.whatsNew())
}
