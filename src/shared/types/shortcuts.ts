// SPDX-License-Identifier: Apache-2.0
// The one shortcut registry.
// It feeds the app menu, main's global registrations and Settings ▸ Keyboard
// shortcuts, so they cannot drift. Keys are Electron accelerators; an empty key means
// the row does not exist on that platform. Only shortcuts Notula ships are listed.
// The dictation bar adds two hook-mechanism rows, whose keys
// are chords ("Ctrl+Win") matched by the keyboard helper, not accelerators.

import { HOOK_SHORTCUT_DEFAULTS } from './dictation-bar'
import type { LabsSettingKey } from './labs'
import type { SettingKey } from './settings'

export type ShortcutScope = 'global' | 'menu' | 'app'
export type ShortcutGroup = 'global' | 'general' | 'notes' | 'lists' | 'search' | 'chat'
export type CustomisableShortcutId = 'quickAsk' | 'dictation' | 'newNote' | 'dictationHold' | 'dictationHandsFree' | 'recordToggle'
/** Rows matched by the keyboard helper (chords, empty = off) instead of `globalShortcut`. */
export type HookShortcutId = 'dictationHold' | 'dictationHandsFree'
export const HOOK_SHORTCUT_IDS: readonly HookShortcutId[] = ['dictationHold', 'dictationHandsFree']

export function isHookShortcut(id: string): id is HookShortcutId {
  return (HOOK_SHORTCUT_IDS as readonly string[]).includes(id)
}

export interface ShortcutDef {
  id: string
  label: string
  group: ShortcutGroup
  scope: ShortcutScope
  keys: { darwin: string; default: string }
  customisable: boolean
  /** Where a customised accelerator is stored (null = the default). */
  settingKey: SettingKey | null
  /** The Labs switch the row's feature sits behind ("Off — turn on in Labs"). */
  featureKey: LabsSettingKey | null
}

/** `shortcuts:list`: a row with what applies now. */
export type ShortcutRow = ShortcutDef & {
  effective: { darwin: string; default: string }
  isDefault: boolean
  available: boolean
}

const MOD = 'CommandOrControl'

function both(keys: string): { darwin: string; default: string } {
  return { darwin: keys, default: keys }
}

function row(
  id: string,
  label: string,
  group: ShortcutGroup,
  scope: ShortcutScope,
  keys: { darwin: string; default: string },
  extra: Partial<Pick<ShortcutDef, 'customisable' | 'settingKey' | 'featureKey'>> = {}
): ShortcutDef {
  return { id, label, group, scope, keys, customisable: false, settingKey: null, featureKey: null, ...extra }
}

export const SHORTCUTS: readonly ShortcutDef[] = [
  // Global
  row('quickAsk', 'Quick ask', 'global', 'global', { darwin: 'Alt+Space', default: 'Control+Alt+Space' }, {
    customisable: true,
    settingKey: 'shortcuts.quickAsk',
    featureKey: 'quickAsk.enabled'
  }),
  row('dictation', 'Voice typing', 'global', 'global', both(`${MOD}+Shift+Space`), {
    customisable: true,
    settingKey: 'dictation.shortcut',
    featureKey: 'voiceTyping.enabled'
  }),
  // The dictation bar: hold, hands-free (hook chords) and record.
  row('dictationHold', 'Dictate (hold to talk)', 'global', 'global', { ...HOOK_SHORTCUT_DEFAULTS.dictationHold }, {
    customisable: true,
    settingKey: 'shortcuts.dictationHold',
    featureKey: 'voiceTyping.enabled'
  }),
  row('dictationHandsFree', 'Dictate hands-free', 'global', 'global', { ...HOOK_SHORTCUT_DEFAULTS.dictationHandsFree }, {
    customisable: true,
    settingKey: 'shortcuts.dictationHandsFree',
    featureKey: 'voiceTyping.enabled'
  }),
  row('recordToggle', 'Start or stop recording', 'global', 'global', { darwin: 'Command+Alt+M', default: 'Control+Alt+M' }, {
    customisable: true,
    settingKey: 'shortcuts.recordToggle',
    featureKey: 'voiceTyping.enabled'
  }),
  // General: the menu accelerators Notula ships, plus the sidebar toggle.
  row('newNote', 'New note', 'general', 'menu', both('CmdOrCtrl+Shift+N'), {
    customisable: true,
    settingKey: 'shortcuts.newNote'
  }),
  row('settings', 'Open Settings', 'general', 'menu', both('CmdOrCtrl+,')),
  row('hide', 'Hide Notula', 'general', 'menu', { darwin: 'CmdOrCtrl+H', default: '' }),
  row('quit', 'Quit', 'general', 'menu', both('CmdOrCtrl+Q')),
  row('reload', 'Reload', 'general', 'menu', both('CmdOrCtrl+R')),
  row('closeWindow', 'Close window', 'general', 'menu', both('CmdOrCtrl+W')),
  row('minimize', 'Minimize', 'general', 'menu', both('CmdOrCtrl+M')),
  row('toggleSidebar', 'Show or hide the sidebar', 'general', 'app', both(`${MOD}+S`)),
  // Notes and editor
  row('bold', 'Bold', 'notes', 'app', both(`${MOD}+B`)),
  row('italic', 'Italic', 'notes', 'app', both(`${MOD}+I`)),
  row('underline', 'Underline', 'notes', 'app', both(`${MOD}+U`)),
  row('bulletList', 'Bulleted list', 'notes', 'app', both(`${MOD}+Shift+8`)),
  row('orderedList', 'Numbered list', 'notes', 'app', both(`${MOD}+Shift+7`)),
  row('quote', 'Quote', 'notes', 'app', both(`${MOD}+Shift+B`)),
  row('undo', 'Undo', 'notes', 'app', both(`${MOD}+Z`)),
  row('redo', 'Redo', 'notes', 'app', both(`${MOD}+Shift+Z`)),
  row('pastePlain', 'Paste as plain text', 'notes', 'app', both(`${MOD}+Shift+V`)),
  row('find', 'Find in note', 'notes', 'app', both(`${MOD}+F`)),
  row('findNext', 'Next match', 'notes', 'app', both(`${MOD}+G`)),
  row('findPrevious', 'Previous match', 'notes', 'app', both(`${MOD}+Shift+G`)),
  row('rewriteWithAi', 'Rewrite the selection with AI', 'notes', 'app', both(`${MOD}+J`)),
  row('regenerate', 'Regenerate enhanced notes', 'notes', 'app', both(`${MOD}+Shift+G`)),
  // Search
  row('commandPalette', 'Open the command palette', 'search', 'app', both(`${MOD}+K`)),
  row('commandPaletteAlt', 'Open the command palette (alternative)', 'search', 'app', both(`${MOD}+/`)),
  row('searchHome', 'Search notes from home', 'search', 'app', both(`${MOD}+F`)),
  // Chat and composers
  row('newChat', 'New chat', 'chat', 'app', both(`${MOD}+N`)),
  row('quickAskSubmit', 'Send in quick ask', 'chat', 'app', both('Enter'), { featureKey: 'quickAsk.enabled' }),
  row('quickAskDismiss', 'Dismiss quick ask', 'chat', 'app', both('Escape'), { featureKey: 'quickAsk.enabled' }),
  row('followUpSend', 'Open a follow-up email in your mail app', 'chat', 'app', both(`${MOD}+Enter`), {
    featureKey: 'followUpEmail.enabled'
  })
]

/** Where each customisable row is stored, and its default accelerator per platform. */
export const CUSTOMISABLE_SHORTCUTS: Record<
  CustomisableShortcutId,
  {
    settingKey:
      | 'shortcuts.quickAsk'
      | 'dictation.shortcut'
      | 'shortcuts.newNote'
      | 'shortcuts.dictationHold'
      | 'shortcuts.dictationHandsFree'
      | 'shortcuts.recordToggle'
    keys: { darwin: string; default: string }
  }
> = {
  quickAsk: { settingKey: 'shortcuts.quickAsk', keys: { darwin: 'Alt+Space', default: 'Control+Alt+Space' } },
  dictation: { settingKey: 'dictation.shortcut', keys: both(`${MOD}+Shift+Space`) },
  newNote: { settingKey: 'shortcuts.newNote', keys: both('CmdOrCtrl+Shift+N') },
  dictationHold: { settingKey: 'shortcuts.dictationHold', keys: { ...HOOK_SHORTCUT_DEFAULTS.dictationHold } },
  dictationHandsFree: { settingKey: 'shortcuts.dictationHandsFree', keys: { ...HOOK_SHORTCUT_DEFAULTS.dictationHandsFree } },
  recordToggle: { settingKey: 'shortcuts.recordToggle', keys: { darwin: 'Command+Alt+M', default: 'Control+Alt+M' } }
}

/** A customisable row's default on this platform. */
export function defaultShortcut(id: CustomisableShortcutId, platform: NodeJS.Platform): string {
  const keys = CUSTOMISABLE_SHORTCUTS[id].keys
  return platform === 'darwin' ? keys.darwin : keys.default
}

/**
 * Combinations a customisable row may never take (validated by `ctx.shortcuts`): the
 * standard editing and window combinations (META counts as CTRL), plus every SHORTCUTS
 * default. A row's own default stays allowed for that row (Reset).
 */
export const RESERVED_ACCELERATORS: readonly string[] = [
  ...new Set([
    `${MOD}+Z`,
    `${MOD}+Shift+Z`,
    `${MOD}+Y`,
    `${MOD}+X`,
    `${MOD}+C`,
    `${MOD}+V`,
    `${MOD}+A`,
    `${MOD}+Tab`,
    'Alt+Tab',
    `${MOD}+W`,
    `${MOD}+Q`,
    ...SHORTCUTS.flatMap((s) => [s.keys.darwin, s.keys.default]).filter((k) => k !== '')
  ])
]
