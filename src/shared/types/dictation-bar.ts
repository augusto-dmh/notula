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
  tooltipDelayMs: 400,
  errorMs: 4_000,
  snoozeMs: 3_600_000,
  fullscreenPollMs: 2_000
} as const

/** Hook-mechanism shortcut defaults. Stored null = this default; '' = off. */
export const HOOK_SHORTCUT_DEFAULTS = {
  dictationHold: { darwin: 'Ctrl+Option', default: 'Ctrl+Win' },
  dictationHandsFree: { darwin: 'Ctrl+Option+Space', default: 'Ctrl+Win+Space' }
} as const

/** Normalised key names (left/right merged): modifiers, then the named keys. */
export const CHORD_MODIFIERS = ['ctrl', 'alt', 'shift', 'win', 'cmd'] as const
export type ChordModifier = (typeof CHORD_MODIFIERS)[number]

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
  space: 'space'
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
    if (!k) return null
    if (k === 'win' && platform === 'darwin') return null
    if (k === 'cmd' && platform !== 'darwin') return null
    if (!(CHORD_MODIFIERS as readonly string[]).includes(k)) others++
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
  space: { win: 'Space', mac: 'Space' }
}
const DISPLAY_ORDER = ['ctrl', 'win', 'cmd', 'alt', 'shift']

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
  if (key) parts.push(key.toLowerCase() === 'space' ? 'Space' : key)
  return parts.join(' + ')
}
