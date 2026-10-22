// SPDX-License-Identifier: Apache-2.0
// The hold / hands-free shortcut engine: a pure state machine fed
// by the keyboard helper's key events. No Electron, no imports, no timers, so the dev harness
// (scripts/dev/chord-harness.ts) runs it directly with scripted key sequences.
//
// - Keys arrive by name with sides (`ctrl`, `ctrl_r`, `win_r`, …); chords match side-agnostic
//   sets of held keys. The helper names every modifier and the chords' keys; `other` is any
//   other key while a modifier is down (it never says which).
// - Hold chord fully down (and nothing else) → `start-hold`. Any chord key up → `finish`, or
//   `discard` when the press lasted under `tapMs`. `Space` added → `lock` (hands-free).
//   `Esc` → `cancel`. Any other key while holding → `cancel` silently.
// - Hands-free chord from idle → `start-hands-free` (when the hold chord is a subset of it, the
//   hold starts first and the last key locks it, which ends in the same place). The same chord
//   pressed again after a release → `finish`. `Esc` → `cancel`.
// - After a cancel, discard or finish, nothing fires until every chord key is up (`cooldown`).
// - Start-menu masking: a `win` key-up after a chord containing `win` fired is masked
//   (`mask: true` on that step); the helper mirrors this rule natively.
// - `record`: the Start or stop recording chord, used only when `globalShortcut` could not
//   register it (Windows' Game Bar owns Win+Alt+M, if the user picks it); fires from idle or hands-free.

export type ChordEffect = 'start-hold' | 'start-hands-free' | 'lock' | 'finish' | 'discard' | 'cancel' | 'record'

export type ChordMode = 'idle' | 'hold' | 'handsFree' | 'cooldown'

export interface ChordConfig {
  /** Sorted normalised names, or null when off. */
  hold: string[] | null
  handsFree: string[] | null
  record?: string[] | null
  tapMs: number
}

export interface ChordState {
  mode: ChordMode
  held: string[]
  holdStartedAt: number
  /** Hands-free: the starting chord is still down, so it can't stop the session yet. */
  latched: boolean
  /** A chord containing `win` fired since `win` went down. */
  winFired: boolean
  suspended: boolean
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

export const IDLE: ChordState = { mode: 'idle', held: [], holdStartedAt: 0, latched: false, winFired: false, suspended: false }

/** `ctrl_r` → `ctrl`; `option` → `alt`; `super` → `win`. */
export function normaliseKey(key: string): string {
  const k = key.toLowerCase().replace(/_r$/, '')
  if (k === 'option' || k === 'opt') return 'alt'
  if (k === 'super') return 'win'
  if (k === 'command') return 'cmd'
  if (k === 'escape') return 'esc'
  return k
}

const MODIFIERS = new Set(['ctrl', 'alt', 'shift', 'win', 'cmd'])
const same = (a: readonly string[], b: readonly string[] | null): boolean => !!b && a.length === b.length && a.every((k, i) => k === b[i])
const subset = (a: readonly string[] | null, b: readonly string[]): boolean => !!a && a.every((k) => b.includes(k))
const chordKeys = (c: ChordConfig): Set<string> => new Set([...(c.hold ?? []), ...(c.handsFree ?? []), ...(c.record ?? [])])

/** One key event. */
export function step(state: ChordState, cfg: ChordConfig, ev: KeyEvent): Step {
  const key = normaliseKey(ev.key)
  const effects: ChordEffect[] = []
  let mask = false
  let s: ChordState = { ...state }

  // The held set: every modifier plus the chords' keys (the helper sends transitions only;
  // `other` and `esc` are never held). An extra modifier makes the chord not match.
  const tracked = chordKeys(cfg).has(key) || MODIFIERS.has(key)
  if (tracked) {
    const held = new Set(s.held)
    if (ev.down) held.add(key)
    else held.delete(key)
    s.held = [...held].sort()
  }
  if (key === 'win' && !ev.down) {
    mask = s.winFired
    s.winFired = false
  }

  const fire = (e: ChordEffect, chord: string[] | null): void => {
    effects.push(e)
    if (chord?.includes('win')) s.winFired = true
  }
  const anyChordKeyHeld = s.held.length > 0

  if (s.suspended) {
    if (s.mode !== 'idle' && s.mode !== 'cooldown') s.mode = 'cooldown'
    if (s.mode === 'cooldown' && !anyChordKeyHeld) s.mode = 'idle'
    return { state: s, effects, mask }
  }

  if (ev.down && tracked && (s.mode === 'idle' || s.mode === 'handsFree') && same(s.held, cfg.record ?? null)) {
    fire('record', cfg.record ?? null)
    return { state: s, effects, mask }
  }

  switch (s.mode) {
    case 'cooldown':
      if (!anyChordKeyHeld) s.mode = 'idle'
      break

    case 'idle':
      if (!ev.down || !tracked) break
      if (same(s.held, cfg.handsFree)) {
        s.mode = 'handsFree'
        s.latched = true
        fire('start-hands-free', cfg.handsFree)
      } else if (same(s.held, cfg.hold)) {
        s.mode = 'hold'
        s.holdStartedAt = ev.at
        fire('start-hold', cfg.hold)
      }
      break

    case 'hold':
      if (ev.down) {
        if (key === 'esc') {
          s.mode = 'cooldown'
          fire('cancel', null)
        } else if (tracked && same(s.held, cfg.handsFree)) {
          s.mode = 'handsFree'
          s.latched = true
          fire('lock', cfg.handsFree)
        } else if (!(tracked && cfg.hold?.includes(key))) {
          // Ctrl+Win+<key>: another shortcut, not a dictation.
          s.mode = 'cooldown'
          fire('cancel', null)
        }
      } else if (tracked && cfg.hold?.includes(key)) {
        s.mode = anyChordKeyHeld ? 'cooldown' : 'idle'
        fire(ev.at - s.holdStartedAt < cfg.tapMs ? 'discard' : 'finish', null)
      }
      break

    case 'handsFree':
      if (ev.down && key === 'esc') {
        s.mode = 'cooldown'
        s.latched = false
        fire('cancel', null)
        break
      }
      if (s.latched) {
        if (!subset(cfg.handsFree, s.held)) s.latched = false
        break
      }
      if (ev.down && tracked && same(s.held, cfg.handsFree)) {
        s.mode = 'cooldown'
        fire('finish', cfg.handsFree)
      }
      break
  }
  if (s.mode === 'cooldown' && !s.held.length) s.mode = 'idle'
  return { state: s, effects, mask }
}

/** The session ended some other way (click, error, pill): stop tracking it. */
export function sessionEnded(state: ChordState): ChordState {
  if (state.mode === 'hold' || state.mode === 'handsFree') return { ...state, mode: state.held.length ? 'cooldown' : 'idle', latched: false }
  return state
}

/** A session started some other way (mic click, the fallback toggle): Esc and the hands-free chord can end it. */
export function sessionStartedElsewhere(state: ChordState): ChordState {
  if (state.mode === 'idle' || state.mode === 'cooldown') return { ...state, mode: 'handsFree', latched: false }
  return state
}

export function setSuspended(state: ChordState, suspended: boolean): ChordState {
  return { ...state, suspended, mode: suspended && (state.mode === 'hold' || state.mode === 'handsFree') ? 'cooldown' : state.mode }
}
