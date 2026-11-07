// SPDX-License-Identifier: Apache-2.0
// When the desk helper's ops script (resources/desk/desk.ps1) runs: pure, so
// scripts/dev/helpers-check.ts can check it. The script starts with the first request that needs
// it and stops after a quiet period, but never while a request is in flight, while a duck it made
// is still held (it raises what it holds as it exits, which would undo a dictation's duck), or
// while it runs the dictation bar's full-screen watcher.

/** The ops script stops this long after its last request. */
export const OPS_IDLE_MS = 10 * 60_000

export interface OpsState {
  /** Started or starting (on macOS, where each op is its own call: in use). */
  running: boolean
  /** When the last request started or ended. */
  lastRequestAt: number
  inFlight: number
  /** A duck succeeded with entries and no unduck has followed. */
  duckHeld: boolean
  /** The script hosts the full-screen watcher. */
  watching: boolean
}

export const OPS_STOPPED: OpsState = { running: false, lastRequestAt: 0, inFlight: 0, duckHeld: false, watching: false }

/** A request goes out; `start` = the script has to start for it. */
export function requestStarted(s: OpsState, now: number): { state: OpsState; start: boolean } {
  return { state: { ...s, running: true, inFlight: s.inFlight + 1, lastRequestAt: now }, start: !s.running }
}

/** A request got its reply, or gave up waiting. `duck`: a duck that held entries (true) or an unduck that worked (false). */
export function requestEnded(s: OpsState, now: number, duck?: boolean): OpsState {
  return { ...s, inFlight: Math.max(0, s.inFlight - 1), lastRequestAt: now, duckHeld: duck ?? s.duckHeld }
}

/** The script exited (or was stopped): it raised what it held on the way out. */
export function opsStopped(s: OpsState): OpsState {
  return { ...s, running: false, duckHeld: false, watching: false }
}

/**
 * The script exited on its own. The helper has already failed what that script had taken, so a
 * request still waiting is headed to the fresh script the helper starts for it: the state stays
 * running, and that script gets its idle stop.
 */
export function opsExited(s: OpsState, stillWaiting: boolean): OpsState {
  return { ...opsStopped(s), running: stillWaiting }
}

/** A script came up: whatever main thought before, it is running and needs its idle stop. */
export function opsReady(s: OpsState): OpsState {
  return s.running ? s : { ...s, running: true }
}

export function shouldStopOps(s: OpsState, now: number): boolean {
  return s.running && s.inFlight === 0 && !s.duckHeld && !s.watching && now - s.lastRequestAt >= OPS_IDLE_MS
}

/** How long until the idle stop could apply; null while something holds the script. */
export function idleDelay(s: OpsState, now: number): number | null {
  if (!s.running || s.inFlight > 0 || s.duckHeld || s.watching) return null
  return Math.max(0, OPS_IDLE_MS - (now - s.lastRequestAt))
}
