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
//   lists of up to 3 hook chords ("Ctrl+Win", validated with `parseChord`; a hands-free entry
//   may be a double tap) set through `shortcuts:set-list`, and Start or stop recording, an
//   accelerator. While no hands-free list is set, it is derived from the hold chords: each
//   one's double tap, plus chord+Space when the chord is all modifiers. Dictation applies all three.
// - A hook entry is refused when it is already in its list, used by the other mode, reserved
//   or another Notula shortcut (sides merged, Meta counted as Control), or recorded on macOS
//   without Accessibility.
//
// Handlers and pushes write their channel literal.

import { ipcMain, systemPreferences } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeRes, PushChannel } from '@shared/ipc'
import { DICTATION_LIMITS, type DictationHandsFreeEntry } from '@shared/types/dictation'
import { DEFAULT_SETTINGS, type SettingKey, type Settings } from '@shared/types/settings'
import { derivedHandsFree, parseChord, sameHookEntry, toHookEntry, type HookEntry } from '@shared/types/dictation-bar'
import {
  CUSTOMISABLE_SHORTCUTS,
  isHookShortcut,
  defaultShortcut,
  RESERVED_ACCELERATORS,
  SHORTCUTS,
  type CustomisableShortcutId,
  type HookShortcutId,
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
  usedBy: (label: string) => `${label} uses this shortcut. Pick another one.`,
  chord: 'Use two to four keys with at least one of Ctrl, Alt, Shift or the Windows key, plus at most one other key.',
  chordMac: 'Use two to four keys with at least one of ⌃, ⌥, ⇧ or ⌘, plus at most one other key.',
  inList: 'You added this one already.',
  listFull: 'You can add up to 3 shortcuts. Remove one to add another.',
  doubleTapMac: 'Double tap isn’t available on macOS yet.',
  doubleTapHold: 'A double tap can only start hands-free dictation.',
  accessibility: 'Allow accessibility access for Notula, then record the shortcut again.'
} as const

type Applier = (accelerator: string) => Promise<{ ok: boolean; error: string | null }>
type AppliedId = Exclude<CustomisableShortcutId, 'newNote'>

const CUSTOMISABLE_IDS = Object.keys(CUSTOMISABLE_SHORTCUTS) as CustomisableShortcutId[]
const SETTING_KEYS = new Set<SettingKey>([...CUSTOMISABLE_IDS.map((id) => CUSTOMISABLE_SHORTCUTS[id].settingKey), 'dictation.conflictShortcut'])
const FEATURE_KEYS = new Set<SettingKey>(SHORTCUTS.flatMap((s) => (s.featureKey ? [s.featureKey] : [])))

function isCustomisableId(v: unknown): v is CustomisableShortcutId {
  return typeof v === 'string' && (CUSTOMISABLE_IDS as readonly string[]).includes(v)
}

const canonical = (text: string): string | null => canonicalAccelerator(text, platform)

/** The text-editing combinations (the part of RESERVED_ACCELERATORS that is not a Notula row). */
const RESERVED = new Set(RESERVED_ACCELERATORS.map(canonical).filter((c): c is string => c !== null))

const MOD_KEYS = new Set(['commandorcontrol', 'cmdorctrl', 'ctrl', 'control', 'cmd', 'command', 'meta', 'super', 'win', 'windows', 'ctrl_r', 'win_r', 'rightctrl', 'rightwin'])
const ALT_KEYS = new Set(['alt', 'option', 'altgr', 'alt_r', 'rightalt', 'rightoption'])
const SHIFT_KEYS = new Set(['shift', 'shift_r', 'rightshift'])

/** A chord or an accelerator as one comparable key set: sides merged, Meta counted as Control. */
function mergedKeys(text: string): string {
  const keys = new Set<string>()
  for (const raw of text.split('+')) {
    const t = raw.trim().toLowerCase()
    if (!t) continue
    keys.add(MOD_KEYS.has(t) ? 'mod' : ALT_KEYS.has(t) ? 'alt' : SHIFT_KEYS.has(t) ? 'shift' : t)
  }
  return [...keys].sort().join('+')
}

/** The editing combinations as merged key sets (Notula's own rows are checked one by one). */
const RESERVED_EDIT = new Set(
  RESERVED_ACCELERATORS.filter((a) => !SHORTCUTS.some((s) => s.keys.darwin === a || s.keys.default === a)).map(mergedKeys)
)

/** Stored hands-free entries: a chord, or `{ keys, doubleTap: true }`. */
const storedEntry = (e: HookEntry): DictationHandsFreeEntry => (e.doubleTap ? { keys: e.keys, doubleTap: true } : e.keys)

export function registerShortcuts(ctx: MainContext): ShortcutsApi {
  let settings: Settings = { ...DEFAULT_SETTINGS }
  const appliers = new Map<AppliedId, Applier>()
  let queue: Promise<unknown> = Promise.resolve()

  /** The hook lists that apply now. */
  const holdList = (): string[] => settings['shortcuts.dictationHold'] ?? [defaultShortcut('dictationHold', platform)]
  const handsFreeSet = (): boolean => (settings['shortcuts.dictationHandsFree']?.length ?? 0) > 0
  const entries = (id: HookShortcutId): HookEntry[] => {
    if (id === 'dictationHold') return holdList().map((keys) => ({ keys, doubleTap: false }))
    const own = settings['shortcuts.dictationHandsFree']
    return own && own.length ? own.map(toHookEntry) : derivedHandsFree(holdList(), platform)
  }

  const stored = (id: CustomisableShortcutId): string | null => {
    if (isHookShortcut(id)) return null
    const v = settings[CUSTOMISABLE_SHORTCUTS[id].settingKey]
    return typeof v === 'string' && v.trim() !== '' ? v : null
  }
  /** A hook row's first single-press entry ('' = none); otherwise the accelerator. */
  const effective = (id: CustomisableShortcutId): string => {
    if (isHookShortcut(id)) return entries(id).find((e) => !e.doubleTap)?.keys ?? ''
    return stored(id) ?? defaultShortcut(id, platform)
  }

  /** What another row answers on this platform ('' = the row does not exist here). */
  const keysOf = (rowId: string, keys: { darwin: string; default: string }): string =>
    isCustomisableId(rowId) ? effective(rowId) : isMac ? keys.darwin : keys.default

  /** Two texts are the same shortcut for this row. */
  const sameShortcut = (id: CustomisableShortcutId, a: string, b: string): boolean => {
    if (isHookShortcut(id)) return (parseChord(a, platform)?.join('+') ?? a) === (parseChord(b, platform)?.join('+') ?? b)
    return canonical(a) === canonical(b)
  }

  /** One hook entry against the entries already accepted for its list. */
  function validateEntry(id: HookShortcutId, e: HookEntry, before: readonly HookEntry[]): string | null {
    const chord = parseChord(e.keys, platform)
    if (!chord) return isMac ? SHORTCUT_COPY.chordMac : SHORTCUT_COPY.chord
    if (e.doubleTap && id === 'dictationHold') return SHORTCUT_COPY.doubleTapHold
    if (e.doubleTap && isMac) return SHORTCUT_COPY.doubleTapMac
    if (isMac && !systemPreferences.isTrustedAccessibilityClient(false)) return SHORTCUT_COPY.accessibility
    if (before.some((b) => sameHookEntry(b, e, platform))) return SHORTCUT_COPY.inList
    const other: HookShortcutId = id === 'dictationHold' ? 'dictationHandsFree' : 'dictationHold'
    if (entries(other).some((b) => sameHookEntry(b, e, platform))) {
      return SHORTCUT_COPY.usedBy(other === 'dictationHold' ? 'Dictate (hold to talk)' : 'Dictate hands-free')
    }
    const mine = mergedKeys(e.keys)
    if (RESERVED_EDIT.has(mine)) return SHORTCUT_COPY.reserved
    for (const row of SHORTCUTS) {
      if (isHookShortcut(row.id)) continue
      const keys = keysOf(row.id, row.keys)
      if (keys !== '' && mergedKeys(keys) === mine) return SHORTCUT_COPY.usedBy(row.label)
    }
    return null
  }

  function validate(id: CustomisableShortcutId, accelerator: string): string | null {
    if (isHookShortcut(id)) {
      if (accelerator === '') return null
      return validateEntry(id, { keys: accelerator, doubleTap: false }, [])
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

  /** The row another app may also answer, until its stored value changes. */
  const conflictOn = (id: string): boolean => {
    const note = settings['dictation.conflictShortcut']
    if (!note || note.id !== id || !isCustomisableId(id)) return false
    return note.value === JSON.stringify(settings[CUSTOMISABLE_SHORTCUTS[id].settingKey] ?? null)
  }

  function rows(): ShortcutRow[] {
    return SHORTCUTS.map((def) => {
      const available = def.featureKey ? settings[def.featureKey] === true : true
      const conflict = conflictOn(def.id)
      if (isHookShortcut(def.id)) {
        const first = effective(def.id)
        const hold = settings['shortcuts.dictationHold']
        const holdDefault = hold === null || (hold.length === 1 && sameShortcut('dictationHold', hold[0]!, defaultShortcut('dictationHold', platform)))
        const isDefault = def.id === 'dictationHold' ? holdDefault : !handsFreeSet()
        return {
          ...def,
          effective: { darwin: first, default: first },
          isDefault,
          available,
          entries: entries(def.id),
          derived: def.id === 'dictationHandsFree' && !handsFreeSet(),
          conflict
        }
      }
      const own = isCustomisableId(def.id) ? stored(def.id) : null
      return {
        ...def,
        effective: own !== null ? { darwin: own, default: own } : { ...def.keys },
        isDefault: own === null,
        available,
        ...(conflict ? { conflict } : {})
      }
    })
  }

  function pushChanged(): void {
    for (const wc of ctx.windows.targets()) wc.send('shortcuts:changed' satisfies PushChannel)
  }

  /** A hook list: validated entry by entry; the defaults (or the derived list) store null. */
  async function setList(id: HookShortcutId, list: HookEntry[] | null): Promise<InvokeRes<'shortcuts:set-list'>> {
    let next: string[] | DictationHandsFreeEntry[] | null = null
    if (list !== null) {
      if (list.length > DICTATION_LIMITS.maxShortcutEntries) return { ok: false, error: SHORTCUT_COPY.listFull }
      const accepted: HookEntry[] = []
      for (const e of list) {
        const error = validateEntry(id, e, accepted)
        if (error) return { ok: false, error }
        accepted.push({ keys: e.keys, doubleTap: e.doubleTap })
      }
      if (id === 'dictationHold') {
        const isDefault = accepted.length === 1 && sameShortcut(id, accepted[0]!.keys, defaultShortcut('dictationHold', platform))
        next = isDefault ? null : accepted.map((e) => e.keys)
      } else {
        const derived = derivedHandsFree(holdList(), platform)
        const same = accepted.length === derived.length && accepted.every((e, i) => sameHookEntry(e, derived[i]!, platform))
        next = accepted.length === 0 || same ? null : accepted.map(storedEntry)
      }
    }
    const before = id === 'dictationHold' ? settings['shortcuts.dictationHold'] : settings['shortcuts.dictationHandsFree']
    if (JSON.stringify(next) === JSON.stringify(before ?? null)) return { ok: true, error: null }
    if (id === 'dictationHold') {
      await ctx.settings.set('shortcuts.dictationHold', next as string[] | null)
      settings = { ...settings, 'shortcuts.dictationHold': next as string[] | null }
    } else {
      await ctx.settings.set('shortcuts.dictationHandsFree', next as DictationHandsFreeEntry[] | null)
      settings = { ...settings, 'shortcuts.dictationHandsFree': next as DictationHandsFreeEntry[] | null }
    }
    log('info', 'shortcuts:set', { id, entries: next === null ? 'default' : next.length })
    pushChanged()
    return { ok: true, error: null }
  }

  async function set(id: CustomisableShortcutId, accelerator: string | null): Promise<InvokeRes<'shortcuts:set'>> {
    // A single chord on a list row sets the whole list ('' = off).
    if (isHookShortcut(id)) return setList(id, accelerator === null ? null : accelerator === '' ? [] : [{ keys: accelerator, doubleTap: false }])
    const fallback = defaultShortcut(id, platform)
    if (accelerator !== null) {
      const error = validate(id, accelerator)
      if (error) return { ok: false, error }
    }
    const target = accelerator ?? fallback
    // Recording the default stores null.
    const next = accelerator === null || sameShortcut(id, accelerator, fallback) ? null : accelerator
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
    const key = CUSTOMISABLE_SHORTCUTS[id].settingKey as 'shortcuts.quickAsk' | 'dictation.shortcut' | 'shortcuts.newNote' | 'shortcuts.recordToggle'
    await ctx.settings.set(key, next)
    settings = { ...settings, [key]: next }
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

  ipcMain.handle('shortcuts:set-list' satisfies InvokeChannel, (_e, p: unknown): Promise<InvokeRes<'shortcuts:set-list'>> => {
    const id = (p as { id?: unknown } | null)?.id
    const raw = (p as { entries?: unknown } | null)?.entries
    if (id !== 'dictationHold' && id !== 'dictationHandsFree') throw notulaError('invalid-input', 'unknown list shortcut')
    let list: HookEntry[] | null = null
    if (raw !== null) {
      if (!Array.isArray(raw) || raw.length > 10) throw notulaError('invalid-input', 'entries must be a list or null')
      list = raw.map((e: unknown) => {
        const keys = (e as { keys?: unknown } | null)?.keys
        if (typeof keys !== 'string' || keys.length > 60) throw notulaError('invalid-input', 'an entry needs keys')
        return { keys, doubleTap: (e as { doubleTap?: unknown }).doubleTap === true }
      })
    }
    const run = queue.then(() => setList(id, list))
    queue = run.catch(() => undefined)
    return run
  })

  return {
    effective,
    entries,
    validate,
    registerApplier: (id, apply) => {
      appliers.set(id, apply)
      return () => {
        if (appliers.get(id) === apply) appliers.delete(id)
      }
    }
  }
}
