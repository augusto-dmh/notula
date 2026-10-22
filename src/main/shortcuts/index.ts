// SPDX-License-Identifier: Apache-2.0
// registerShortcuts(): the one shortcut registry: validation,
// the owners' appliers and the New note menu accelerator; the `shortcuts:*` IPC. Returns
// `ctx.shortcuts`.
//
// - The fixed SHORTCUTS table feeds the app menu, the owners' global registrations and
//   Settings ▸ Keyboard shortcuts, so they cannot drift.
// - Three rows are customisable. Quick ask and voice typing register their
//   own global shortcuts and hand an applier to `registerApplier`; New note is the Window ▸
//   New menu accelerator, which this module rebuilds.
// - `shortcuts:set` validates (known id, a key with modifiers, no clash with another Notula
//   row, not reserved), asks the owner to apply it, persists it and pushes
//   `shortcuts:changed`. A null accelerator, or the default itself, stores null (Reset).
// - There is no channel that registers an arbitrary global shortcut.
// - The dictation bar adds hold and hands-free dictation, stored as
//   hook chords ("Ctrl+Win"; '' = off; validated with `parseChord`), and Start or stop
//   recording, an accelerator. Dictation applies all three.
//
// Handlers and pushes write their channel literal.

import { ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeRes, PushChannel } from '@shared/ipc'
import { DEFAULT_SETTINGS, type SettingKey, type Settings } from '@shared/types/settings'
import { parseChord } from '@shared/types/dictation-bar'
import {
  CUSTOMISABLE_SHORTCUTS,
  isHookShortcut,
  defaultShortcut,
  RESERVED_ACCELERATORS,
  SHORTCUTS,
  type CustomisableShortcutId,
  type ShortcutRow
} from '@shared/types/shortcuts'
import type { MainContext, ShortcutsApi } from '../context'
import { log } from '../log'
import { rebuildApplicationMenu } from '../shell'
import { canonicalAccelerator, isFunctionKey, parseAccelerator } from './accelerator'

const platform = process.platform
const isMac = platform === 'darwin'

/** The recorder's error messages. */
export const SHORTCUT_COPY = {
  invalid: 'Notula can’t use that combination. Try another.',
  modifierOnly: 'Add a letter, number or function key.',
  needsModifier: isMac ? 'Add ⌘, ⌥, ⌃ or ⇧ to that key.' : 'Add Ctrl, Alt or Shift to that key.',
  escape: 'Escape can’t be part of a shortcut.',
  reserved: 'That combination is reserved for editing. Try another.',
  usedByOtherApp: 'This shortcut is used by another app.',
  usedBy: (label: string) => `Already used by ${label}.`,
  chord: 'Use two to four keys with at least one of Ctrl, Alt, Shift or the Windows key, plus at most one other key.',
  chordMac: 'Use two to four keys with at least one of ⌃, ⌥, ⇧ or ⌘, plus at most one other key.'
} as const

type Applier = (accelerator: string) => Promise<{ ok: boolean; error: string | null }>
type AppliedId = Exclude<CustomisableShortcutId, 'newNote'>

const CUSTOMISABLE_IDS = Object.keys(CUSTOMISABLE_SHORTCUTS) as CustomisableShortcutId[]
const SETTING_KEYS = new Set<SettingKey>(CUSTOMISABLE_IDS.map((id) => CUSTOMISABLE_SHORTCUTS[id].settingKey))
const FEATURE_KEYS = new Set<SettingKey>(SHORTCUTS.flatMap((s) => (s.featureKey ? [s.featureKey] : [])))

function isCustomisableId(v: unknown): v is CustomisableShortcutId {
  return typeof v === 'string' && (CUSTOMISABLE_IDS as readonly string[]).includes(v)
}

const canonical = (text: string): string | null => canonicalAccelerator(text, platform)

/** The text-editing combinations (the part of RESERVED_ACCELERATORS that is not a Notula row). */
const RESERVED = new Set(RESERVED_ACCELERATORS.map(canonical).filter((c): c is string => c !== null))

export function registerShortcuts(ctx: MainContext): ShortcutsApi {
  let settings: Settings = { ...DEFAULT_SETTINGS }
  const appliers = new Map<AppliedId, Applier>()
  let queue: Promise<unknown> = Promise.resolve()

  const stored = (id: CustomisableShortcutId): string | null => {
    const v = settings[CUSTOMISABLE_SHORTCUTS[id].settingKey]
    // A hook chord stores '' for "off".
    return typeof v === 'string' && (v.trim() !== '' || isHookShortcut(id)) ? v : null
  }
  const effective = (id: CustomisableShortcutId): string => stored(id) ?? defaultShortcut(id, platform)

  /** What another row answers on this platform ('' = the row does not exist here). */
  const keysOf = (rowId: string, keys: { darwin: string; default: string }): string =>
    isCustomisableId(rowId) ? effective(rowId) : isMac ? keys.darwin : keys.default

  /** Two texts are the same shortcut for this row. */
  const sameShortcut = (id: CustomisableShortcutId, a: string, b: string): boolean => {
    if (isHookShortcut(id)) return (parseChord(a, platform)?.join('+') ?? a) === (parseChord(b, platform)?.join('+') ?? b)
    return canonical(a) === canonical(b)
  }

  function validate(id: CustomisableShortcutId, accelerator: string): string | null {
    if (isHookShortcut(id)) {
      if (accelerator === '') return null
      const chord = parseChord(accelerator, platform)
      if (!chord) return isMac ? SHORTCUT_COPY.chordMac : SHORTCUT_COPY.chord
      const other = id === 'dictationHold' ? 'dictationHandsFree' : 'dictationHold'
      const theirs = parseChord(effective(other), platform)
      if (theirs && theirs.join('+') === chord.join('+')) return SHORTCUT_COPY.usedBy(other === 'dictationHold' ? 'Dictate (hold to talk)' : 'Dictate hands-free')
      return null
    }
    const parsed = parseAccelerator(accelerator, platform)
    if (!parsed) return SHORTCUT_COPY.invalid
    if (parsed.key === null) return SHORTCUT_COPY.modifierOnly
    if (parsed.key === 'Escape') return SHORTCUT_COPY.escape
    if (parsed.modifiers.length === 0 && !isFunctionKey(parsed.key)) return SHORTCUT_COPY.needsModifier
    const mine = canonical(accelerator)
    // Quick ask owns Alt+Space on every platform.
    if (id === 'dictation' && mine === canonical('Alt+Space')) return SHORTCUT_COPY.usedBy('Quick ask')
    for (const row of SHORTCUTS) {
      if (row.id === id || isHookShortcut(row.id)) continue
      const keys = keysOf(row.id, row.keys)
      if (keys !== '' && canonical(keys) === mine) return SHORTCUT_COPY.usedBy(row.label)
    }
    // A row's own default stays allowed for that row (Reset).
    if (mine !== null && RESERVED.has(mine) && mine !== canonical(defaultShortcut(id, platform))) return SHORTCUT_COPY.reserved
    return null
  }

  function rows(): ShortcutRow[] {
    return SHORTCUTS.map((def) => {
      const own = isCustomisableId(def.id) ? stored(def.id) : null
      return {
        ...def,
        effective: own !== null ? { darwin: own, default: own } : { ...def.keys },
        isDefault: own === null,
        available: def.featureKey ? settings[def.featureKey] === true : true
      }
    })
  }

  function pushChanged(): void {
    for (const wc of ctx.windows.targets()) wc.send('shortcuts:changed' satisfies PushChannel)
  }

  async function set(id: CustomisableShortcutId, accelerator: string | null): Promise<InvokeRes<'shortcuts:set'>> {
    const fallback = defaultShortcut(id, platform)
    if (accelerator !== null) {
      const error = validate(id, accelerator)
      if (error) return { ok: false, error }
    }
    const target = accelerator ?? fallback
    // Recording the default stores null.
    const next = accelerator === null || (accelerator !== '' && sameShortcut(id, accelerator, fallback)) ? null : accelerator
    if (next === stored(id)) return { ok: true, error: null }

    if (id !== 'newNote') {
      const apply = appliers.get(id)
      if (apply) {
        let result: { ok: boolean; error: string | null }
        try {
          result = await apply(target)
        } catch (err) {
          log('warn', 'shortcuts:apply-failed', { id, err })
          result = { ok: false, error: null }
        }
        if (!result.ok) return { ok: false, error: result.error ?? SHORTCUT_COPY.usedByOtherApp }
      }
    }
    await ctx.settings.set(CUSTOMISABLE_SHORTCUTS[id].settingKey, next)
    settings = { ...settings, [CUSTOMISABLE_SHORTCUTS[id].settingKey]: next }
    if (id === 'newNote') rebuildApplicationMenu(ctx)
    log('info', 'shortcuts:set', { id, customised: next !== null })
    pushChanged()
    return { ok: true, error: null }
  }

  function absorb(next: Settings, keys: readonly SettingKey[]): void {
    const before = effective('newNote')
    settings = next
    if (effective('newNote') !== before) rebuildApplicationMenu(ctx)
    if (keys.some((k) => SETTING_KEYS.has(k) || FEATURE_KEYS.has(k))) pushChanged()
  }

  void ctx.settings
    .getAll()
    .then((all) => absorb(all, []))
    .catch((err: unknown) => log('warn', 'shortcuts:read-failed', { err }))
  ctx.bus.on('settings:changed', (e) => absorb(e.settings, e.keys))

  ipcMain.handle('shortcuts:list' satisfies InvokeChannel, (): ShortcutRow[] => rows())

  ipcMain.handle('shortcuts:set' satisfies InvokeChannel, (_e, p: unknown): Promise<InvokeRes<'shortcuts:set'>> => {
    const id = (p as { id?: unknown } | null)?.id
    const accelerator = (p as { accelerator?: unknown } | null)?.accelerator
    if (!isCustomisableId(id)) throw notulaError('invalid-input', 'unknown shortcut')
    if (accelerator !== null && (typeof accelerator !== 'string' || accelerator.length > 100)) {
      throw notulaError('invalid-input', 'accelerator must be a string or null')
    }
    // One change at a time: a validation reads the others' effective keys.
    const run = queue.then(() => set(id, accelerator))
    queue = run.catch(() => undefined)
    return run
  })

  return {
    effective,
    validate,
    registerApplier: (id, apply) => {
      appliers.set(id, apply)
      return () => {
        if (appliers.get(id) === apply) appliers.delete(id)
      }
    }
  }
}
