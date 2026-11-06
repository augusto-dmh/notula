// SPDX-License-Identifier: Apache-2.0
// Key chips and the shortcut recorder's key reading. Glyphs on macOS, words elsewhere; every
// chip has a spoken name for screen readers. A mouse button (`Mouse4`) is a chip with a small
// mouse drawn beside its name.

import { mouseButtonLabel, mouseButtonOf } from '@shared/types/dictation-bar'
import { isMac } from '../../app/platform'

export interface Chip {
  text: string
  /** The accessible name. */
  name: string
  /** A mouse button chip: its number (3 middle, 4 back, 5 forward). */
  mouse?: number
}

const MAC: Record<string, Chip> = {
  Cmd: { text: '⌘', name: 'Command' },
  Ctrl: { text: '⌃', name: 'Control' },
  Alt: { text: '⌥', name: 'Option' },
  Shift: { text: '⇧', name: 'Shift' },
  Enter: { text: '⏎', name: 'Return' },
  Backspace: { text: '⌫', name: 'Delete' },
  Delete: { text: '⌦', name: 'Forward Delete' },
  Tab: { text: '⇥', name: 'Tab' },
  Escape: { text: '⎋', name: 'Escape' },
  Capslock: { text: '⇪', name: 'Caps Lock' }
}

const WIN: Record<string, Chip> = {
  Cmd: { text: 'Win', name: 'Windows' },
  Ctrl: { text: 'Ctrl', name: 'Control' },
  Alt: { text: 'Alt', name: 'Alt' },
  Shift: { text: 'Shift', name: 'Shift' },
  Enter: { text: 'Enter', name: 'Enter' },
  Backspace: { text: 'Backspace', name: 'Backspace' },
  Delete: { text: 'Delete', name: 'Delete' },
  Tab: { text: 'Tab', name: 'Tab' },
  Escape: { text: 'Esc', name: 'Escape' },
  Capslock: { text: 'Caps Lock', name: 'Caps Lock' }
}

const ARROWS: Record<string, Chip> = {
  Up: { text: '↑', name: 'Up Arrow' },
  Down: { text: '↓', name: 'Down Arrow' },
  Left: { text: '←', name: 'Left Arrow' },
  Right: { text: '→', name: 'Right Arrow' }
}

const ORDER = ['Ctrl', 'Alt', 'Shift', 'Cmd']

/** An Electron accelerator as chips for this platform; [] for an empty accelerator. */
export function chipsFor(accelerator: string): Chip[] {
  if (!accelerator) return []
  const table = isMac ? MAC : WIN
  const mods = new Set<string>()
  let key: string | null = null
  for (const raw of accelerator.split('+')) {
    const t = raw.trim().toLowerCase()
    if (t === 'commandorcontrol' || t === 'cmdorctrl') mods.add(isMac ? 'Cmd' : 'Ctrl')
    else if (t === 'command' || t === 'cmd' || t === 'super' || t === 'meta' || t === 'win') mods.add('Cmd')
    else if (t === 'control' || t === 'ctrl') mods.add('Ctrl')
    else if (t === 'alt' || t === 'option' || t === 'altgr') mods.add('Alt')
    else if (t === 'shift') mods.add('Shift')
    else key = raw.trim()
  }
  const chips = ORDER.filter((m) => mods.has(m)).map((m) => table[m]!)
  if (key) {
    const named = ARROWS[key] ?? table[key]
    if (named) chips.push(named)
    else if (key === 'Plus') chips.push({ text: '+', name: 'Plus' })
    else if (key === 'Space') chips.push({ text: 'Space', name: 'Space' })
    else chips.push({ text: key.length === 1 ? key.toUpperCase() : key, name: key.length === 1 ? key.toUpperCase() : key })
  }
  return chips
}

const CODE_KEYS: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`'
}

/** The non-modifier key of a key event as an accelerator key, or null (modifier or unsupported). */
function keyOf(e: KeyboardEvent): string | null {
  const c = e.code
  if (/^Key[A-Z]$/.test(c)) return c.slice(3)
  if (/^Digit[0-9]$/.test(c)) return c.slice(5)
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(c)) return c
  return CODE_KEYS[c] ?? null
}

export type Recorded =
  | { kind: 'modifiers' }
  | { kind: 'escape' }
  | { kind: 'needs-modifier' }
  | { kind: 'reserved' }
  | { kind: 'unsupported' }
  | { kind: 'combo'; accelerator: string }

/** The editing combinations (copy, paste, undo, …): ignored while recording (recording keeps listening). */
function isReservedEdit(mod: boolean, shift: boolean, alt: boolean, key: string): boolean {
  if (alt && !mod && key === 'Tab') return true
  if (!mod || alt) return false
  if (key === 'Z') return true
  return !shift && ['Y', 'X', 'C', 'V', 'A', 'Tab', 'W', 'Q'].includes(key)
}

// ---------- hook chords ----------

const CHORD_ORDER = ['Ctrl', 'RightCtrl', 'Win', 'RightWin', 'Cmd', 'Option', 'Alt', 'RightAlt', 'Shift', 'RightShift']

/**
 * One key of a hook chord, by physical key (`KeyboardEvent.code`), as Notula's key name, or null
 * when it can't be used. The right-side modifiers and the numpad digits stay their own keys
 * on Windows; the macOS helper doesn't tell them apart yet.
 */
export function chordKeyOf(e: KeyboardEvent): string | null {
  const c = e.code
  if (c === 'ControlLeft') return 'Ctrl'
  if (c === 'ControlRight') return isMac ? 'Ctrl' : 'RightCtrl'
  if (c === 'AltLeft') return isMac ? 'Option' : 'Alt'
  if (c === 'AltRight') return isMac ? 'Option' : 'RightAlt'
  if (c === 'ShiftLeft') return 'Shift'
  if (c === 'ShiftRight') return isMac ? 'Shift' : 'RightShift'
  if (c === 'MetaLeft' || c === 'OSLeft') return isMac ? 'Cmd' : 'Win'
  if (c === 'MetaRight' || c === 'OSRight') return isMac ? 'Cmd' : 'RightWin'
  if (c === 'Space') return 'Space'
  if (/^Key[A-Z]$/.test(c)) return c.slice(3)
  if (/^Digit[0-9]$/.test(c)) return c.slice(5)
  if (/^Numpad[0-9]$/.test(c) && !isMac) return `Num${c.slice(6)}`
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(c)) return c
  return null
}

/**
 * A mouse press in the settings window as a chord key (`Mouse3` middle, `Mouse4` back, `Mouse5`
 * forward), or null for the primary and secondary buttons, which stay free for clicking.
 */
export function mouseKeyOf(e: MouseEvent): string | null {
  if (e.button === 1) return 'Mouse3'
  if (e.button === 3) return 'Mouse4'
  if (e.button === 4) return 'Mouse5'
  return null
}

/** Chord keys as stored text: modifiers first ("Ctrl+Win+Space"), a mouse button last. */
export function chordText(keys: readonly string[]): string {
  const mods = CHORD_ORDER.filter((m) => keys.includes(m))
  const rest = keys.filter((k) => !CHORD_ORDER.includes(k))
  const isMouse = (k: string): boolean => mouseButtonOf(k) !== null
  return [...mods, ...rest.filter((k) => !isMouse(k)), ...rest.filter(isMouse)].join('+')
}

const CHORD_CHIPS: Record<string, { mac: Chip; win: Chip }> = {
  ctrl: { mac: { text: '⌃', name: 'Control' }, win: { text: 'Ctrl', name: 'Control' } },
  control: { mac: { text: '⌃', name: 'Control' }, win: { text: 'Ctrl', name: 'Control' } },
  rightctrl: { mac: { text: 'Right ⌃', name: 'Right Control' }, win: { text: 'Right Ctrl', name: 'Right Control' } },
  alt: { mac: { text: '⌥', name: 'Option' }, win: { text: 'Alt', name: 'Alt' } },
  option: { mac: { text: '⌥', name: 'Option' }, win: { text: 'Alt', name: 'Alt' } },
  rightalt: { mac: { text: 'Right ⌥', name: 'Right Option' }, win: { text: 'Right Alt', name: 'Right Alt' } },
  shift: { mac: { text: '⇧', name: 'Shift' }, win: { text: 'Shift', name: 'Shift' } },
  rightshift: { mac: { text: 'Right ⇧', name: 'Right Shift' }, win: { text: 'Right Shift', name: 'Right Shift' } },
  win: { mac: { text: 'Win', name: 'Windows' }, win: { text: 'Win', name: 'Windows' } },
  rightwin: { mac: { text: 'Right Win', name: 'Right Windows' }, win: { text: 'Right Win', name: 'Right Windows' } },
  cmd: { mac: { text: '⌘', name: 'Command' }, win: { text: 'Cmd', name: 'Command' } },
  space: { mac: { text: 'Space', name: 'Space' }, win: { text: 'Space', name: 'Space' } }
}

/** A hook chord ("Ctrl+RightAlt+Num1") as chips for this platform. */
export function chordChips(keys: string): Chip[] {
  return keys
    .split('+')
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const t = raw.toLowerCase()
      const named = CHORD_CHIPS[t] ?? CHORD_CHIPS[t.replace(/^(ctrl|alt|shift|win)_r$/, 'right$1')]
      if (named) return isMac ? named.mac : named.win
      if (/^num[0-9]$/.test(t)) return { text: `Num ${t.slice(3)}`, name: `Numpad ${t.slice(3)}` }
      const button = mouseButtonOf(t)
      if (button !== null) {
        const label = mouseButtonLabel(button)
        return { text: button <= 5 ? label : `Button ${button}`, name: button <= 5 ? label.replace(' button', ' mouse button') : label, mouse: button }
      }
      const text = raw.length === 1 ? raw.toUpperCase() : raw
      return { text, name: text }
    })
}

/** Reads one keydown in the settings window. */
export function readKey(e: KeyboardEvent): Recorded {
  if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) return { kind: 'escape' }
  if (['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'OS'].includes(e.key)) return { kind: 'modifiers' }
  const key = keyOf(e)
  if (!key) return { kind: 'unsupported' }
  // Mod = ⌘ on macOS and Ctrl elsewhere; ⌃ on macOS and the Windows key stay their own.
  const mod = isMac ? e.metaKey : e.ctrlKey
  const parts: string[] = []
  if (mod) parts.push('CommandOrControl')
  if (isMac && e.ctrlKey) parts.push('Control')
  if (!isMac && e.metaKey) parts.push('Super')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (parts.length === 0 && !/^F\d+$/.test(key)) return { kind: 'needs-modifier' }
  if (isReservedEdit(mod, e.shiftKey, e.altKey, key)) return { kind: 'reserved' }
  return { kind: 'combo', accelerator: [...parts, key].join('+') }
}
