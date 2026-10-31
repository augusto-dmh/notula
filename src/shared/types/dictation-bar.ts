// SPDX-License-Identifier: Apache-2.0
// The dictation bar: the always-visible bar mode of the dictation
// pill, and the hook-mechanism shortcuts (hold and hands-free dictation) behind it.
// Chord helpers are pure: main, the renderer and the dev harness share them.

export type DictationBarLayout = 'compact' | 'wide'
export type DictationBarMode = 'resting' | 'ready' | 'hold' | 'handsFree' | 'processing' | 'recording' | 'error' | 'hidden'
export type DictationBarCaptureReady = 'ready' | 'permission' | 'unavailable'

/** `dictation-bar:state`, main → the pill window. */
export interface DictationBarState {
  /** `dictationBar.enabled` inside the Voice typing gate; false = the pill behaves as before. */
  enabled: boolean
  layout: DictationBarLayout
  mode: DictationBarMode
  captureReady: DictationBarCaptureReady
  /** Display strings (empty = no shortcut) for the tooltips' keytips. */
  shortcuts: { dictate: string; handsFree: string; record: string }
  /** Capture running: its start time, for the elapsed timer. */
  recordingSince: string | null
  /** Whether the notes button is shown (Scratchpad on, or a capture running). */
  notes: boolean
  error?: string
}

/** `dictation-bar:action`. `reset-position` is the double-click. */
export type DictationBarAction = 'dictate' | 'record' | 'notes' | 'menu' | 'snooze' | 'hide' | 'reset-position'

/** A row's leading glyph in the bar menu. */
export type DictationBarMenuIcon = 'record' | 'stop' | 'mic' | 'notes' | 'snooze' | 'hide' | 'settings'

export type DictationBarMenuEntry =
  | { kind: 'item'; id: string; label: string; icon?: DictationBarMenuIcon; checked?: boolean; disabled?: boolean; submenu?: DictationBarMenuEntry[] }
  | { kind: 'separator' }

/** `dictation-bar:menu`, main → the menu overlay. `anchor` is overlay-relative DIP: the opener's
 *  centre x, and the panel's bottom edge as a distance from the overlay's bottom. */
export interface DictationBarMenu {
  open: boolean
  items: DictationBarMenuEntry[]
  anchor: { x: number; bottom: number }
}

export interface DictationBarRect {
  x: number
  y: number
  width: number
  height: number
}

/** `shortcuts:hook-status`. */
export interface HookStatus {
  available: boolean
  lost?: boolean
  reason?: 'unsupported' | 'helper-failed' | 'permission' | 'secure-input'
}

export const DICTATION_BAR_LIMITS = {
  /** A hold shorter than this is an accidental tap. */
  tapMs: 150,
  dragThresholdPx: 3,
  /** Bar bottom above the work area. */
  bottomGapDip: 12,
  /** Tooltip delay on a button; 0 when a tooltip is already showing. */
  tooltipDelayMs: 50,
  /** The mic tooltip after the bar expands. */
  bubbleTooltipDelayMs: 150,
  /** A hover change applies at once, then holds further changes this long. */
  hoverLockMs: 100,
  /** The menu panel's bottom edge above the expanded bar's top. */
  menuGapPx: 6,
  /** The expanded bar's height. */
  barHeightPx: 30,
  /** Close the menu when the cursor moves to another display (polled). */
  menuDisplayPollMs: 400,
  /** After the menu closes, collapse the bar if the cursor is off it. */
  menuCollapseMs: 50,
  /** The expand's longest transition (the record button's 200 ms spring), plus a frame. */
  expandSettleMs: 210,
  errorMs: 4_000,
  snoozeMs: 3_600_000,
  fullscreenPollMs: 2_000
} as const

/**
 * Hook-mechanism shortcut defaults: the hold chord, and the hands-free chord its derived list
 * shows first. Stored null = these defaults; a stored [] hold list = off.
 */
export const HOOK_SHORTCUT_DEFAULTS = {
  dictationHold: { darwin: 'Ctrl+Option', default: 'Ctrl+Win' },
  dictationHandsFree: { darwin: 'Ctrl+Option+Space', default: 'Ctrl+Win+Space' }
} as const

/** Normalised key names: modifiers (either side), then the named keys. */
export const CHORD_MODIFIERS = ['ctrl', 'alt', 'shift', 'win', 'cmd'] as const
export type ChordModifier = (typeof CHORD_MODIFIERS)[number]
/** Right-side modifiers, kept apart so a chord can ask for that side only (`ctrl_r`). */
export const CHORD_RIGHT_MODIFIERS = ['ctrl_r', 'alt_r', 'shift_r', 'win_r'] as const
const ALL_MODIFIERS: readonly string[] = [...CHORD_MODIFIERS, ...CHORD_RIGHT_MODIFIERS]

/** A key name with its side merged (`ctrl_r` → `ctrl`). */
export const chordBase = (k: string): string => k.replace(/_r$/, '')

const TOKENS: Record<string, string> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
  win: 'win',
  super: 'win',
  windows: 'win',
  cmd: 'cmd',
  command: 'cmd',
  space: 'space',
  rightctrl: 'ctrl_r',
  ctrl_r: 'ctrl_r',
  rightalt: 'alt_r',
  rightoption: 'alt_r',
  alt_r: 'alt_r',
  rightshift: 'shift_r',
  shift_r: 'shift_r',
  rightwin: 'win_r',
  win_r: 'win_r'
}

/**
 * A hook chord ("Ctrl+Win", "Ctrl+Option+Space") as sorted normalised key names, or null.
 * Rules: 2–4 keys, at least one modifier, at most one other key (Space, a letter, a digit
 * or F1–F24), never Escape. `win` is Windows-only and `cmd` macOS-only.
 */
export function parseChord(text: string, platform: string): string[] | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 60) return null
  const keys = new Set<string>()
  let others = 0
  for (const raw of text.split('+')) {
    const t = raw.trim().toLowerCase()
    let k = TOKENS[t]
    if (!k && /^[a-z0-9]$/.test(t)) k = t
    if (!k && /^f([1-9]|1[0-9]|2[0-4])$/.test(t)) k = t
    if (!k && /^num[0-9]$/.test(t)) k = t
    if (!k) return null
    if (chordBase(k) === 'win' && platform === 'darwin') return null
    if (k === 'cmd' && platform !== 'darwin') return null
    // The macOS helper doesn't tell sides apart.
    if (k.endsWith('_r') && platform === 'darwin') return null
    if (!ALL_MODIFIERS.includes(k)) others++
    keys.add(k)
  }
  if (keys.size < 2 || keys.size > 4 || others > 1 || others === keys.size) return null
  return [...keys].sort()
}

const DISPLAY: Record<string, { win: string; mac: string }> = {
  ctrl: { win: 'Ctrl', mac: 'Ctrl' },
  alt: { win: 'Alt', mac: 'Option' },
  shift: { win: 'Shift', mac: 'Shift' },
  win: { win: 'Win', mac: 'Win' },
  cmd: { win: 'Cmd', mac: '⌘' },
  space: { win: 'Space', mac: 'Space' },
  ctrl_r: { win: 'Right Ctrl', mac: 'Right Ctrl' },
  alt_r: { win: 'Right Alt', mac: 'Right Option' },
  shift_r: { win: 'Right Shift', mac: 'Right Shift' },
  win_r: { win: 'Right Win', mac: 'Right Win' }
}
const DISPLAY_ORDER = ['ctrl', 'ctrl_r', 'win', 'win_r', 'cmd', 'alt', 'alt_r', 'shift', 'shift_r']

/** "Ctrl + Win + Space" / "Win + Alt + M": a chord or an Electron accelerator, for keytips. */
export function shortcutLabel(text: string, platform: string): string {
  if (!text) return ''
  const mac = platform === 'darwin'
  const mods = new Set<string>()
  let key = ''
  for (const raw of text.split('+')) {
    const t = raw.trim().toLowerCase()
    if (t === 'commandorcontrol' || t === 'cmdorctrl') mods.add(mac ? 'cmd' : 'ctrl')
    else if (t === 'meta' || t === 'super' || t === 'win' || t === 'windows') mods.add(mac ? 'cmd' : 'win')
    else if (t === 'command' || t === 'cmd') mods.add('cmd')
    else if (TOKENS[t] && t !== 'space') mods.add(TOKENS[t]!)
    else key = raw.trim().length === 1 ? raw.trim().toUpperCase() : raw.trim()
  }
  const parts = DISPLAY_ORDER.filter((m) => mods.has(m)).map((m) => DISPLAY[m]![mac ? 'mac' : 'win'])
  if (key) parts.push(key.toLowerCase() === 'space' ? 'Space' : /^num[0-9]$/i.test(key) ? `Num ${key.slice(3)}` : key)
  return parts.join(' + ')
}

// ---------- shortcut lists ----------

/** A hands-free entry as the lists show it. */
export interface HookEntry {
  keys: string
  doubleTap: boolean
}

export const toHookEntry = (e: string | { keys: string; doubleTap: true }): HookEntry =>
  typeof e === 'string' ? { keys: e, doubleTap: false } : { keys: e.keys, doubleTap: true }

/** Every key of the chord is a modifier ("Ctrl+Win"). */
export function allModifiers(chord: readonly string[]): boolean {
  return chord.length > 0 && chord.every((k) => ALL_MODIFIERS.includes(k))
}

/**
 * The hands-free entries a hold list implies: each chord's double tap, plus chord+Space when it
 * is all modifiers. A list holds at most 3 entries, so the first 3 apply.
 */
export function derivedHandsFree(hold: readonly string[], platform: string): HookEntry[] {
  const out: HookEntry[] = []
  for (const text of hold) {
    const chord = parseChord(text, platform)
    if (!chord) continue
    // Double tap waits for the macOS helper.
    if (platform !== 'darwin') out.push({ keys: text, doubleTap: true })
    if (allModifiers(chord) && chord.length < 4) out.push({ keys: `${text}+Space`, doubleTap: false })
  }
  return out.slice(0, 3)
}

/** "Ctrl + Win, twice" for a double tap. */
export function hookEntryLabel(e: HookEntry, platform: string): string {
  const keys = shortcutLabel(e.keys, platform)
  return e.doubleTap ? `${keys}, twice` : keys
}

/** Same entry: the same keys (sides kept) and the same press. */
export function sameHookEntry(a: HookEntry, b: HookEntry, platform: string): boolean {
  return a.doubleTap === b.doubleTap && (parseChord(a.keys, platform)?.join('+') ?? a.keys) === (parseChord(b.keys, platform)?.join('+') ?? b.keys)
}
