// SPDX-License-Identifier: Apache-2.0
// The hold / hands-free shortcut engine: a pure state machine fed
// by the keyboard helper's key events. No Electron, no imports, no timers, so the dev harness
// (scripts/dev/chord-harness.ts) runs it directly with scripted key sequences.
//
// - Keys arrive by name with sides (`ctrl`, `ctrl_r`, `win_r`, …). A chord token without a side
//   (`ctrl`) matches either side; a right-side token (`ctrl_r`) only that side. The helper names
//   every modifier and the chords' keys; `other` is any other key while a modifier is down (it
//   never says which). Mouse buttons arrive as keys too (`mouse3` middle, `mouse4` back,
//   `mouse5` forward …), so a chord may be one bare button (`['mouse4']`) or modifiers plus one.
// - Up to 3 hold chords and 3 hands-free chords. A hold chord fully down (and nothing else) →
//   `start-hold`. Any of its keys up → `finish`, or `discard` when the press was a tap (under
//   `tapMs`, or under 300 ms for a chord that also has a double tap). A hands-free chord added
//   while holding → `lock`. `Esc` → `cancel`. Any other key while holding → `cancel` silently.
// - Double tap: a chord in `doubleTap` tapped, then pressed again within `doubleTapMs` (the OS
//   double-click interval) → `start-hands-free`.
// - A hands-free chord from idle → `start-hands-free`. While hands-free, any shortcut chord
//   pressed again after a release → `finish`. `Esc` → `cancel`.
// - After a cancel, discard or finish, nothing fires until every chord key is up (`cooldown`).
// - Start-menu masking: a `win` key-up after a chord containing `win` fired is masked
//   (`mask: true` on that step); the helper mirrors this rule natively.
// - `record`: the Start or stop recording chord, used only when `globalShortcut` could not
//   register it (Windows' Game Bar owns Win+Alt+M, if the user picks it); fires from idle or hands-free.

export type ChordEffect = 'start-hold' | 'start-hands-free' | 'lock' | 'finish' | 'discard' | 'cancel' | 'record'

export type ChordMode = 'idle' | 'hold' | 'handsFree' | 'cooldown'

export interface ChordConfig {
  /** Sorted normalised names per chord; [] when off. */
  hold: string[][]
  handsFree: string[][]
  /** Chords whose double tap starts hands-free. */
  doubleTap?: string[][]
  record?: string[] | null
  tapMs: number
  /** The OS double-click interval (400 ms when the platform can't say). */
  doubleTapMs?: number
}

export interface ChordState {
  mode: ChordMode
  /** Held keys with their sides. */
  held: string[]
  holdStartedAt: number
  /** The chord that started the session, joined with `+`. */
  chord: string | null
  /** Hands-free: the starting chord is still down, so it can't stop the session yet. */
  latched: boolean
  /** A chord containing `win` fired since `win` went down. */
  winFired: boolean
  suspended: boolean
  /** A double-tap chord down from idle that is not a hold chord. */
  press: { chord: string; at: number } | null
  /** The last tap of a double-tap chord: its release time. */
  tap: { chord: string; at: number } | null
}

export interface KeyEvent {
  key: string
  down: boolean
  at: number
}

export interface Step {
  state: ChordState
  effects: ChordEffect[]
  /** This key-up of `win` must be masked (Start menu). */
  mask: boolean
}

export const IDLE: ChordState = {
  mode: 'idle',
  held: [],
  holdStartedAt: 0,
  chord: null,
  latched: false,
  winFired: false,
  suspended: false,
  press: null,
  tap: null
}

/** A press shorter than this, on a chord that also has a double tap, is a tap. */
const DOUBLE_TAP_PRESS_MS = 300

/** `option` → `alt`; `super` → `win`; sides kept (`ctrl_r`). */
export function normaliseKey(key: string): string {
  const k = key.toLowerCase()
  if (k === 'option' || k === 'opt') return 'alt'
  if (k === 'super') return 'win'
  if (k === 'command') return 'cmd'
  if (k === 'escape') return 'esc'
  return k
}

const base = (k: string): string => k.replace(/_r$/, '')
const MODIFIERS = new Set(['ctrl', 'alt', 'shift', 'win', 'cmd'])
const idOf = (c: readonly string[]): string => c.join('+')

/** A chord token covers a held key: the same key, or the side-free token of a sided key. */
const covers = (token: string, key: string): boolean => token === key || token === base(key)

/** Every token has a held key and every held key a token. */
function matches(held: readonly string[], chord: readonly string[] | null | undefined): boolean {
  if (!chord || chord.length === 0 || held.length === 0) return false
  return chord.every((t) => held.some((k) => covers(t, k))) && held.every((k) => chord.some((t) => covers(t, k)))
}

/** Every token of the chord is still held. */
const allHeld = (chord: readonly string[], held: readonly string[]): boolean => chord.every((t) => held.some((k) => covers(t, k)))

function chordKeys(c: ChordConfig): Set<string> {
  const out = new Set<string>()
  for (const chord of [...c.hold, ...c.handsFree, ...(c.doubleTap ?? []), c.record ?? []]) for (const k of chord) out.add(base(k))
  return out
}

/** One key event. */
export function step(state: ChordState, cfg: ChordConfig, ev: KeyEvent): Step {
  const key = normaliseKey(ev.key)
  const effects: ChordEffect[] = []
  let mask = false
  let s: ChordState = { ...state }
  const doubleTap = cfg.doubleTap ?? []
  const doubleTapMs = cfg.doubleTapMs ?? 400

  // The held set: every modifier plus the chords' keys (the helper sends transitions only;
  // `other` and `esc` are never held). An extra modifier makes the chord not match.
  const tracked = chordKeys(cfg).has(base(key)) || MODIFIERS.has(base(key))
  if (tracked) {
    const held = new Set(s.held)
    if (ev.down) held.add(key)
    else held.delete(key)
    s.held = [...held].sort()
  }
  if (base(key) === 'win' && !ev.down) {
    mask = s.winFired
    s.winFired = false
  }

  const fire = (e: ChordEffect, chord: readonly string[] | null): void => {
    effects.push(e)
    if (chord?.some((k) => base(k) === 'win')) s.winFired = true
  }
  const anyChordKeyHeld = s.held.length > 0
  const find = (list: readonly string[][]): string[] | undefined => list.find((c) => matches(s.held, c))
  const chordOf = (id: string | null): string[] | null => (id ? id.split('+') : null)

  if (s.suspended) {
    if (s.mode !== 'idle' && s.mode !== 'cooldown') s.mode = 'cooldown'
    if (s.mode === 'cooldown' && !anyChordKeyHeld) s.mode = 'idle'
    return { state: s, effects, mask }
  }

  if (ev.down && tracked && (s.mode === 'idle' || s.mode === 'handsFree') && matches(s.held, cfg.record)) {
    fire('record', cfg.record ?? null)
    return { state: s, effects, mask }
  }

  switch (s.mode) {
    case 'cooldown':
      if (!anyChordKeyHeld) s.mode = 'idle'
      break

    case 'idle': {
      if (!ev.down) {
        // A double-tap chord released quickly is the first tap.
        if (s.press && chordOf(s.press.chord)!.some((t) => covers(t, key))) {
          if (ev.at - s.press.at < DOUBLE_TAP_PRESS_MS) s.tap = { chord: s.press.chord, at: ev.at }
          s.press = null
        }
        break
      }
      if (!tracked) break
      const dt = find(doubleTap)
      if (dt && s.tap && s.tap.chord === idOf(dt) && ev.at - s.tap.at <= doubleTapMs) {
        s.mode = 'handsFree'
        s.latched = true
        s.chord = idOf(dt)
        s.tap = null
        s.press = null
        fire('start-hands-free', dt)
        break
      }
      const hf = find(cfg.handsFree)
      const hold = find(cfg.hold)
      if (hf) {
        s.mode = 'handsFree'
        s.latched = true
        s.chord = idOf(hf)
        fire('start-hands-free', hf)
      } else if (hold) {
        s.mode = 'hold'
        s.holdStartedAt = ev.at
        s.chord = idOf(hold)
        fire('start-hold', hold)
      } else if (dt) {
        s.press = { chord: idOf(dt), at: ev.at }
      }
      break
    }

    case 'hold': {
      const chord = chordOf(s.chord)
      if (ev.down) {
        const hf = tracked ? find(cfg.handsFree) : undefined
        if (key === 'esc') {
          s.mode = 'cooldown'
          fire('cancel', null)
        } else if (hf) {
          s.mode = 'handsFree'
          s.latched = true
          s.chord = idOf(hf)
          fire('lock', hf)
        } else if (!(tracked && chord?.some((t) => covers(t, key)))) {
          // Ctrl+Win+<key>: another shortcut, not a dictation.
          s.mode = 'cooldown'
          fire('cancel', null)
        }
      } else if (tracked && chord?.some((t) => covers(t, key))) {
        const canDouble = !!s.chord && doubleTap.some((c) => idOf(c) === s.chord)
        const tapLimit = canDouble ? Math.max(cfg.tapMs, DOUBLE_TAP_PRESS_MS) : cfg.tapMs
        const tapped = ev.at - s.holdStartedAt < tapLimit
        if (tapped && canDouble) s.tap = { chord: s.chord!, at: ev.at }
        s.mode = anyChordKeyHeld ? 'cooldown' : 'idle'
        fire(tapped ? 'discard' : 'finish', null)
      }
      break
    }

    case 'handsFree':
      if (ev.down && key === 'esc') {
        s.mode = 'cooldown'
        s.latched = false
        fire('cancel', null)
        break
      }
      if (s.latched) {
        const chord = chordOf(s.chord)
        if (!chord || !allHeld(chord, s.held)) s.latched = false
        break
      }
      if (ev.down && tracked) {
        const again = find(cfg.handsFree) ?? find(cfg.hold) ?? find(doubleTap)
        if (again) {
          s.mode = 'cooldown'
          fire('finish', again)
        }
      }
      break
  }
  if (s.mode === 'cooldown' && !s.held.length) s.mode = 'idle'
  if (s.mode === 'idle') s.chord = null
  return { state: s, effects, mask }
}

/** The session ended some other way (click, error, pill): stop tracking it. */
export function sessionEnded(state: ChordState): ChordState {
  if (state.mode === 'hold' || state.mode === 'handsFree') return { ...state, mode: state.held.length ? 'cooldown' : 'idle', latched: false, chord: null }
  return state
}

/** A session started some other way (mic click, the fallback toggle): Esc and the shortcut chords can end it. */
export function sessionStartedElsewhere(state: ChordState): ChordState {
  if (state.mode === 'idle' || state.mode === 'cooldown') return { ...state, mode: 'handsFree', latched: false, chord: null }
  return state
}

export function setSuspended(state: ChordState, suspended: boolean): ChordState {
  return { ...state, suspended, mode: suspended && (state.mode === 'hold' || state.mode === 'handsFree') ? 'cooldown' : state.mode }
}

/** The OS stopped sending key-ups (a lock screen, a lost hook): forget what is held and re-arm. */
export function rearm(state: ChordState): ChordState {
  const ended = state.mode === 'cooldown' ? 'idle' : state.mode
  return { ...state, held: [], mode: ended, press: null, latched: false }
}
