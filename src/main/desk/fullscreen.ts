// SPDX-License-Identifier: Apache-2.0
// The dictation bar's full-screen source (resources/desk/foreground-watch.cs): which helper runs
// the watcher, and how its lines read. Pure, so scripts/dev/helpers-check.ts can check it.
//
// The key hook's process hosts it while the hook is up and ready; otherwise the desk helper's ops
// script does, also while the hook restarts. A hook that is starting keeps the host it has, so
// arming (the hook starts with the bar) never starts the ops script for the second it takes.
// Off Windows there is no watcher.

export type FullscreenHost = 'none' | 'hook' | 'desk'

export interface FullscreenState {
  full: boolean
  /** The covered monitor's top-left in physical pixels (0 when not full). */
  x: number
  y: number
}

/** The key hook process: up and ready, spawned and not ready yet, or not running. */
export type HookPhase = 'ready' | 'starting' | 'down'

export function fullscreenHost(o: { platform: string; tracking: boolean; hook: HookPhase; current: FullscreenHost }): FullscreenHost {
  if (o.platform !== 'win32' || !o.tracking) return 'none'
  if (o.hook === 'ready') return 'hook'
  if (o.hook === 'down') return 'desk'
  return o.current === 'desk' ? 'desk' : 'none'
}

/** A watcher line, or null for anything malformed or partial. */
export function parseFullscreen(m: Record<string, unknown>): FullscreenState | null {
  const { full, x, y } = m
  if (typeof full !== 'boolean' || !Number.isInteger(x) || !Number.isInteger(y)) return null
  return { full, x: x as number, y: y as number }
}

export function sameFullscreen(a: FullscreenState | null, b: FullscreenState | null): boolean {
  return a === b || (!!a && !!b && a.full === b.full && a.x === b.x && a.y === b.y)
}

/** The state after a new one, and whether the listener hears of it: a change to or from full screen. */
export function foldFullscreen(prev: FullscreenState | null, next: FullscreenState | null): { state: FullscreenState | null; notify: boolean } {
  if (sameFullscreen(prev, next)) return { state: prev, notify: false }
  return { state: next, notify: next?.full === true || prev?.full === true }
}
