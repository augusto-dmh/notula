// SPDX-License-Identifier: Apache-2.0
// createSettings(): typed preferences, the defaults merged with the stored rows
// (settings live in SQLite). Every change emits
// `settings:changed` on the bus; the IPC module forwards it as `prefs:changed`, so
// main-side writes (capture's input preference, the permission record) reach the
// renderer too.
//
// Writes are validated per key; an unchanged value is skipped. Unreadable stored
// rows are moved to `settings_rejected` by the storage worker.

import { notulaError, parseError } from '@shared/errors'
import {
  DEFAULT_SETTINGS,
  MAIN_ONLY_SETTING_KEYS,
  type SettingKey,
  type Settings,
  type SettingsPatch
} from '@shared/types/settings'
import type { MainBus } from '../bus'
import type { SettingsApi } from '../context'
import { log } from '../log'
import type { StorageApi } from '../storage/api'
import { isSettingKey, isValidSetting, sameValue } from './schema'

interface SettingsInternals {
  applyPatch(patch: unknown, opts: { fromRenderer: boolean }): Promise<SettingKey[]>
  /** The device lock's verification for the protected transitions; set once by index.ts. */
  confirm: ((target: ProtectedSettingKey) => Promise<boolean>) | null
}

/** Turning these on hides meeting cards, so it needs the device owner first. */
const PROTECTED_KEYS = ['notifications.scheduledBlocked', 'notifications.autoDetectedBlocked'] as const
type ProtectedSettingKey = (typeof PROTECTED_KEYS)[number]

/** index.ts: `ctx.deviceLock.confirmProtectedChange`, read at call time. */
export function bindProtectedChanges(settings: SettingsApi, confirm: (target: ProtectedSettingKey) => Promise<boolean>): void {
  const i = internals.get(settings)
  if (i) i.confirm = confirm
}

const internals = new WeakMap<SettingsApi, SettingsInternals>()

const MAIN_ONLY = new Set<string>(MAIN_ONLY_SETTING_KEYS)

/**
 * The `prefs:set` path: a per-key merge from the renderer. Unknown,
 * main-only, invalid and unchanged keys are dropped (and logged); the rest are
 * written, then one `settings:changed` names them. Resolves with the written keys.
 */
export function applyRendererPatch(settings: SettingsApi, patch: unknown): Promise<SettingKey[]> {
  const i = internals.get(settings)
  return i ? i.applyPatch(patch, { fromRenderer: true }) : Promise.resolve([])
}

function merged(raw: Partial<Settings>): Settings {
  return { ...structuredClone(DEFAULT_SETTINGS), ...structuredClone(raw) }
}

export function createSettings(storage: StorageApi, bus: MainBus): SettingsApi {
  /** Writes run one at a time, so "unchanged" is judged against the latest state. */
  let queue: Promise<unknown> = Promise.resolve()

  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn)
    queue = run.catch(() => undefined)
    return run
  }

  async function getAll(): Promise<Settings> {
    try {
      return merged(await storage.getSettingsRaw())
    } catch (err) {
      // While storage needs recovery nothing else runs; readers get the defaults.
      if (parseError(err).code === 'storage-unavailable') return merged({})
      throw err
    }
  }

  const own: SettingsInternals = { applyPatch, confirm: null }

  /** The protected transitions in a patch that the device owner did not confirm. */
  async function unconfirmed(patch: Record<string, unknown>): Promise<ProtectedSettingKey[]> {
    const turningOn = PROTECTED_KEYS.filter((k) => patch[k] === true)
    if (turningOn.length === 0 || !own.confirm) return []
    const current = await getAll()
    const denied: ProtectedSettingKey[] = []
    for (const k of turningOn) {
      if (current[k] === true) continue
      if (!(await own.confirm(k))) denied.push(k)
    }
    return denied
  }

  async function applyPatch(patch: unknown, opts: { fromRenderer: boolean }): Promise<SettingKey[]> {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      log('warn', 'settings:patch-dropped', { reason: 'not-an-object' })
      return []
    }
    const denied = await unconfirmed(patch as Record<string, unknown>)
    if (denied.length) {
      if (!opts.fromRenderer) throw notulaError('invalid-input', 'Not verified')
      log('info', 'settings:protected-change-denied', { keys: denied })
      const rest = { ...(patch as Record<string, unknown>) }
      for (const k of denied) delete rest[k]
      patch = rest
    }
    return serial(async () => {
      const current = merged(await storage.getSettingsRaw())
      const written: SettingKey[] = []
      const dropped: { key: string; reason: string }[] = []
      for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
        if (!isSettingKey(key)) dropped.push({ key, reason: 'unknown-key' })
        else if (opts.fromRenderer && MAIN_ONLY.has(key)) dropped.push({ key, reason: 'main-only' })
        else if (!isValidSetting(key, value)) dropped.push({ key, reason: 'invalid-value' })
        else if (sameValue(current[key], value)) continue
        else {
          await storage.setSettingRaw(key, value as Settings[typeof key])
          written.push(key)
        }
      }
      if (dropped.length) log('warn', 'settings:keys-dropped', { dropped })
      if (written.length) {
        const settings = merged(await storage.getSettingsRaw())
        bus.emit('settings:changed', { keys: written, settings })
      }
      return written
    })
  }

  const api: SettingsApi = {
    getAll,
    get: async (key) => (await getAll())[key],
    set: async (key, value) => {
      if (!isSettingKey(key)) throw notulaError('invalid-input', `unknown setting ${String(key)}`)
      if (!isValidSetting(key, value)) throw notulaError('invalid-input', `invalid value for ${key}`)
      await applyPatch({ [key]: value } satisfies SettingsPatch, { fromRenderer: false })
      return getAll()
    }
  }
  internals.set(api, own)
  return api
}
