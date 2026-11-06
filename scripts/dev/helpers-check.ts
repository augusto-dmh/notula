// SPDX-License-Identifier: Apache-2.0
// Dev-only check for the on-demand desk helper: the ops script's idle stop (src/main/desk/idle.ts)
// and the dictation bar's full-screen source (src/main/desk/fullscreen.ts). Pure: no process, no
// hook, no window.
// Run: node scripts/dev/helpers-check.ts   (Node's type stripping; exits 1 on a failure)

import { idleDelay, OPS_IDLE_MS, OPS_STOPPED, opsStopped, requestEnded, requestStarted, shouldStopOps, type OpsState } from '../../src/main/desk/idle.ts'
import { foldFullscreen, fullscreenHost, parseFullscreen, type FullscreenHost, type FullscreenState, type HookPhase } from '../../src/main/desk/fullscreen.ts'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ok    ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? `: ${detail}` : ''}`)
  }
}

// ---------- the desk idle decision ----------

console.log('ops script idle stop')
const T0 = 1_000_000
/** One request at T0 that ended at once: running, idle since T0. */
const afterOne = (): OpsState => requestEnded(requestStarted(OPS_STOPPED, T0).state, T0)

check('the first request starts the script', requestStarted(OPS_STOPPED, T0).start)
check('a request while it runs does not start it again', !requestStarted(afterOne(), T0 + 1).start)
check('9 min 59 s idle: keep', !shouldStopOps(afterOne(), T0 + OPS_IDLE_MS - 1_000))
check('10 min idle: stop', shouldStopOps(afterOne(), T0 + OPS_IDLE_MS))
{
  const busy = requestStarted(afterOne(), T0).state
  check('10 min idle with a request in flight: keep', !shouldStopOps(busy, T0 + OPS_IDLE_MS) && idleDelay(busy, T0) === null)
}
{
  const ducked = requestEnded(requestStarted(OPS_STOPPED, T0).state, T0, true)
  check('10 min idle with a duck held: keep', !shouldStopOps(ducked, T0 + OPS_IDLE_MS) && ducked.duckHeld)
  const raised = requestEnded(requestStarted(ducked, T0 + 5_000).state, T0 + 5_000, false)
  check('an unduck releases it: stop 10 min later', !raised.duckHeld && shouldStopOps(raised, T0 + 5_000 + OPS_IDLE_MS))
  const failedUnduck = requestEnded(requestStarted(ducked, T0 + 5_000).state, T0 + 5_000)
  check('a failed unduck keeps the hold', failedUnduck.duckHeld && !shouldStopOps(failedUnduck, T0 + 5_000 + OPS_IDLE_MS))
}
{
  const watching: OpsState = { ...afterOne(), watching: true }
  check('10 min idle while hosting the watcher: keep', !shouldStopOps(watching, T0 + OPS_IDLE_MS))
}
{
  const stopped = opsStopped(afterOne())
  check('after a stop: nothing more to stop', !stopped.running && !shouldStopOps(stopped, T0 + 2 * OPS_IDLE_MS) && idleDelay(stopped, T0) === null)
  const again = requestStarted(stopped, T0 + 2 * OPS_IDLE_MS)
  check('after a stop, a new request starts it again', again.start && again.state.running)
  check('an exit drops the duck hold (the script raised it)', !opsStopped({ ...afterOne(), duckHeld: true }).duckHeld)
}
check('the idle timer is due exactly at 10 min', idleDelay(afterOne(), T0 + 60_000) === OPS_IDLE_MS - 60_000)
check('a later request restarts the wait', idleDelay(requestEnded(requestStarted(afterOne(), T0 + 300_000).state, T0 + 300_000), T0 + 300_000) === OPS_IDLE_MS)

// ---------- the full-screen host ----------

console.log('full-screen host')
const host = (platform: string, tracking: boolean, hook: HookPhase, current: FullscreenHost = 'none'): FullscreenHost =>
  fullscreenHost({ platform, tracking, hook, current })
/** Feeds hook phases in order, each step starting from the host the previous one chose. */
const walk = (phases: HookPhase[]): string => {
  let current: FullscreenHost = 'none'
  return phases.map((p) => (current = host('win32', true, p, current))).join(',')
}
check('not Windows: none', host('darwin', true, 'ready') === 'none' && host('linux', true, 'down') === 'none')
check('bar not tracking: none', host('win32', false, 'ready', 'hook') === 'none' && host('win32', false, 'down', 'desk') === 'none')
check('hook running: hook', host('win32', true, 'ready') === 'hook' && host('win32', true, 'ready', 'desk') === 'hook')
check('hook not running: desk', host('win32', true, 'down') === 'desk')
check('hook restarting: desk until ready, then hook', walk(['ready', 'down', 'starting', 'starting', 'ready']) === 'hook,desk,desk,desk,hook', walk(['ready', 'down', 'starting', 'starting', 'ready']))
check('arming (hook starting with the bar): no desk start, then hook', walk(['starting', 'ready']) === 'none,hook', walk(['starting', 'ready']))
check('a hook that fails to start: desk', walk(['starting', 'down']) === 'none,desk', walk(['starting', 'down']))

// ---------- the watcher's lines ----------

console.log('watcher lines')
const line = (o: Record<string, unknown>): Record<string, unknown> => ({ type: 'fullscreen', from: 'hook', ...o })
check('a full line parses', JSON.stringify(parseFullscreen(line({ full: true, x: -1920, y: 0 }))) === '{"full":true,"x":-1920,"y":0}')
check('a not-full line parses', parseFullscreen(line({ full: false, x: 0, y: 0 }))?.full === false)
const malformed: Array<Record<string, unknown>> = [
  line({}),
  line({ full: true }),
  line({ full: true, x: 0 }),
  line({ full: 'true', x: 0, y: 0 }),
  line({ full: true, x: '0', y: 0 }),
  line({ full: true, x: 1.5, y: 0 }),
  line({ full: null, x: 0, y: 0 })
]
check('malformed or partial lines are ignored', malformed.every((m) => parseFullscreen(m) === null))
{
  // Desk's fold: a state reaches the bar only when it differs; the bar refreshes only when "full" flips.
  const stream = [
    { full: false, x: 0, y: 0 },
    { full: false, x: 0, y: 0 },
    { full: true, x: 0, y: 0 },
    { bad: 1 },
    { full: true, x: 0, y: 0 },
    { full: true, x: 0 },
    { full: false, x: 0, y: 0 },
    { full: false, x: 0, y: 0 }
  ]
  let state: FullscreenState | null = null
  let delivered = 0
  let refreshes = 0
  let full = false
  for (const m of stream) {
    const s = parseFullscreen(line(m))
    if (!s) continue
    const r = foldFullscreen(state, s)
    state = r.state
    if (!r.notify) continue
    delivered++
    // The bar's own rule: refresh when its "full" flips.
    if (s.full !== full) {
      full = s.full
      refreshes++
    }
  }
  check('repeated identical states cause no refresh', delivered === 2 && refreshes === 2, `${delivered} delivered, ${refreshes} refreshes`)
}

console.log(failures ? `helpers-check: ${failures} failure(s)` : 'helpers-check: all passed')
process.exit(failures ? 1 : 0)
