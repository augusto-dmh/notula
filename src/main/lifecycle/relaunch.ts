// SPDX-License-Identifier: Apache-2.0
// The relaunch argument filter.
//
// A relaunch keeps the current arguments after the executable, minus inspector
// arguments and task arguments (`--notula-task=<task>` and the bare `--notula-task`).
// In a packaged build, any of the risky Chromium switches below means the relaunch
// gets no arguments at all.
//
// Notula also drops its own deep-link URLs: Notula acts on a link a cold start was
// launched with, so keeping it would run the link again.

import { APP_TASK_ARG_PREFIX } from '@shared/types/app'

/** Chromium switch names, matched as `--name` or `--name=value`. */
const RISKY_SWITCHES = [
  'remote-debugging-port',
  'remote-debugging-pipe',
  'ignore-certificate-errors',
  'ignore-certificate-errors-spki-list',
  'ignore-urlfetcher-cert-requests',
  'proxy-server',
  'proxy-pac-url',
  'proxy-bypass-list',
  'proxy-auto-detect',
  'proxy-resolver-rules',
  'host-resolver-rules',
  'host-rules',
  'ssl-key-log-file',
  'log-net-log',
  'net-log-capture-mode'
] as const

const INSPECTOR_ARG = /^--inspect(-brk|-port|-publish-uid)?(=.*)?$/
const BARE_TASK_ARG = APP_TASK_ARG_PREFIX.slice(0, -1)

function switchName(arg: string): string | null {
  if (!arg.startsWith('--')) return null
  const eq = arg.indexOf('=')
  return (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).toLowerCase()
}

export function hasRiskySwitch(args: readonly string[]): boolean {
  return args.some((a) => {
    const name = switchName(a)
    return name !== null && (RISKY_SWITCHES as readonly string[]).includes(name)
  })
}

/**
 * The arguments for `app.relaunch({ args })`: `args` are the current ones after the
 * executable; `schemes` are the deep-link schemes to drop (`notula:` / `notula-dev:`).
 */
export function relaunchArgs(args: readonly string[], packaged: boolean, schemes: readonly string[]): string[] {
  if (packaged && hasRiskySwitch(args)) return []
  return args.filter((a) => {
    if (INSPECTOR_ARG.test(a)) return false
    if (a === BARE_TASK_ARG || a.startsWith(APP_TASK_ARG_PREFIX)) return false
    const lower = a.toLowerCase()
    return !schemes.some((s) => lower.startsWith(`${s}:`))
  })
}
