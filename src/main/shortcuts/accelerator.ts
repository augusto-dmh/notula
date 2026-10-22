// SPDX-License-Identifier: Apache-2.0
// Electron accelerator parsing for the shortcut registry and the shortcut recorder's rules.
// Accelerators are compared in a
// canonical form for the current platform, so `CmdOrCtrl+K`, `CommandOrControl+K` and
// `Control+K` are the same combination on Windows. META counts as CTRL off macOS.

export type Modifier = 'Cmd' | 'Ctrl' | 'Alt' | 'AltGr' | 'Shift' | 'Super'

const MODIFIER_ORDER: readonly Modifier[] = ['Cmd', 'Ctrl', 'Alt', 'AltGr', 'Shift', 'Super']

/** Named keys Electron accepts, keyed by lower case. */
const NAMED_KEYS: Record<string, string> = {
  space: 'Space',
  tab: 'Tab',
  enter: 'Enter',
  return: 'Enter',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  escape: 'Escape',
  esc: 'Escape',
  plus: 'Plus',
  capslock: 'Capslock',
  numlock: 'Numlock',
  scrolllock: 'Scrolllock',
  printscreen: 'PrintScreen'
}

const PUNCTUATION = new Set([',', '.', '/', ';', "'", '[', ']', '\\', '-', '=', '`'])

export interface ParsedAccelerator {
  modifiers: Modifier[]
  /** The non-modifier key, or null for a modifier-only combination. */
  key: string | null
}

function modifierOf(token: string, platform: NodeJS.Platform): Modifier | null {
  const mac = platform === 'darwin'
  switch (token.toLowerCase()) {
    case 'command':
    case 'cmd':
      return mac ? 'Cmd' : 'Ctrl'
    case 'commandorcontrol':
    case 'cmdorctrl':
      return mac ? 'Cmd' : 'Ctrl'
    case 'control':
    case 'ctrl':
      return 'Ctrl'
    case 'alt':
    case 'option':
      return 'Alt'
    case 'altgr':
      return 'AltGr'
    case 'shift':
      return 'Shift'
    case 'super':
    case 'meta':
      return mac ? 'Cmd' : 'Ctrl'
    default:
      return null
  }
}

function keyOf(token: string): string | null {
  if (token.length === 1) {
    if (/^[a-z0-9]$/i.test(token)) return token.toUpperCase()
    return PUNCTUATION.has(token) ? token : null
  }
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(token)) return token.toUpperCase()
  return NAMED_KEYS[token.toLowerCase()] ?? null
}

/** Null when the text is not an accelerator Notula accepts. */
export function parseAccelerator(text: string, platform: NodeJS.Platform): ParsedAccelerator | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 100) return null
  // `+` itself is written `Plus`, so a plain split is exact.
  const tokens = text.split('+').map((t) => t.trim())
  if (tokens.some((t) => t === '')) return null
  const modifiers = new Set<Modifier>()
  let key: string | null = null
  for (const t of tokens) {
    const mod = modifierOf(t, platform)
    if (mod) {
      modifiers.add(mod)
      continue
    }
    if (key !== null) return null
    key = keyOf(t)
    if (key === null) return null
  }
  return { modifiers: MODIFIER_ORDER.filter((m) => modifiers.has(m)), key }
}

/** The canonical form used for comparisons; null when unparsable. */
export function canonicalAccelerator(text: string, platform: NodeJS.Platform): string | null {
  const p = parseAccelerator(text, platform)
  if (!p) return null
  return [...p.modifiers, p.key ?? ''].join('+')
}

export function isFunctionKey(key: string): boolean {
  return /^F([1-9]|1[0-9]|2[0-4])$/.test(key)
}
