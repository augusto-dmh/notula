// SPDX-License-Identifier: Apache-2.0
// registerMeetings(): meeting detection, the mic-app list and the detected-meeting
// notification; the `meetings:*` IPC and bus `meetings:mic-apps`.
//
// The `notula-micmon` utility process (micmon-worker.ts) runs while detection is on
// (`meetings.detectionEnabled`) and reports raw ids; main maps them to known apps
// (apps.ts), publishes changes and drives the "Meeting detected" card (detect.ts).
// Restarts: 2 s doubling to 60 s, 6 attempts, reset after 15 s healthy.
//
// Only a monitor report can say that an app left the microphone. When
// the monitor exits, the last list is kept until the restarted monitor reports again,
// so a crash neither stops the meeting (the app-left rule) nor shows a fresh card for
// the same call. When detection is turned off or the monitor gives up, the list is
// cleared with an empty `previous`: nothing was seen leaving.

import { join } from 'node:path'
import { app, ipcMain, utilityProcess, type UtilityProcess } from 'electron'
import type { InvokeChannel, InvokeRes, PushChannel } from '@shared/ipc'
import type { MeetingDetectionStatus, MicApp } from '@shared/types/meetings'
import type { MainContext } from '../context'
import { log } from '../log'
import { mapRawIds } from './apps'
import { DetectedMeetingNotifier } from './detect'
import type { MicmonEvent, MicmonStart } from './micmon-worker'

const RESTART_FIRST_MS = 2_000
const RESTART_MAX_MS = 60_000
const RESTART_ATTEMPTS = 6
const HEALTHY_AFTER_MS = 15_000
/** macOS: an empty list is published only after 2 s, so a quick re-acquire does not flap. */
const MAC_EMPTY_DEBOUNCE_MS = 2_000
/** macOS: no sensor-indicator line this long after Notula takes the mic = detection unavailable. */
const MAC_PROBE_MS = 10_000
const STOP_GRACE_MS = 1_000

const SUPPORTED: readonly NodeJS.Platform[] = ['win32', 'darwin']

const sameApps = (a: MicApp[], b: MicApp[]): boolean => a.length === b.length && a.every((x, i) => x.appId === b[i]?.appId)

export function registerMeetings(ctx: MainContext): void {
  const platform = process.platform
  let apps: MicApp[] = []
  let status: MeetingDetectionStatus = { state: 'disabled', detail: null, platform }
  let enabled = false
  let proc: UtilityProcess | null = null
  let attempt = 0
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  let healthyTimer: ReturnType<typeof setTimeout> | null = null
  let emptyTimer: ReturnType<typeof setTimeout> | null = null
  let probeTimer: ReturnType<typeof setTimeout> | null = null
  let sawMacLine = false
  const unknownLogged = new Set<string>()
  const notifier = new DetectedMeetingNotifier(ctx, () => apps)

  function setStatus(next: MeetingDetectionStatus): void {
    if (next.state === status.state && next.detail === status.detail) return
    status = next
    log('info', 'meetings:status', { state: next.state, detail: next.detail })
  }

  /** A monitor report changed the list. */
  function publish(next: MicApp[]): void {
    if (sameApps(next, apps)) return
    const previous = apps
    apps = next
    log('info', 'meetings:mic-apps', { apps: next.map((a) => a.appId).join(',') })
    ctx.bus.emit('meetings:mic-apps', { apps: next, previous })
    for (const wc of ctx.windows.targets()) wc.send('meetings:mic-apps-changed' satisfies PushChannel, next)
    // The card logic runs when the number of apps changes.
    if (next.length !== previous.length) {
      void notifier.onAppsChanged(next, previous).catch((err: unknown) => log('warn', 'meetings:card-failed', { err }))
    }
  }

  /**
   * The list is no longer known (detection off, or the monitor gave up). It empties
   * without an app-left transition: `previous` is empty, and no card runs.
   */
  function clear(why: string): void {
    if (emptyTimer) clearTimeout(emptyTimer)
    emptyTimer = null
    if (!apps.length) return
    apps = []
    log('info', 'meetings:mic-apps-cleared', { why })
    ctx.bus.emit('meetings:mic-apps', { apps: [], previous: [] })
    for (const wc of ctx.windows.targets()) wc.send('meetings:mic-apps-changed' satisfies PushChannel, [])
  }

  function onRaw(ids: string[]): void {
    const unknown = new Set<string>()
    const next = mapRawIds(ids, platform, unknown)
    for (const id of unknown) {
      if (unknownLogged.has(id) || unknownLogged.size > 200) continue
      unknownLogged.add(id)
      // No telemetry: a local debug line only, with the basename rather than the full path.
      log('debug', 'meetings:unknown-app', { id: id.split('#').pop() ?? id })
    }
    if (emptyTimer) clearTimeout(emptyTimer)
    emptyTimer = null
    if (platform === 'darwin' && next.length === 0 && apps.length > 0) {
      emptyTimer = setTimeout(() => {
        emptyTimer = null
        publish([])
      }, MAC_EMPTY_DEBOUNCE_MS)
      return
    }
    publish(next)
  }

  function onEvent(e: MicmonEvent): void {
    switch (e.type) {
      case 'ready':
        setStatus({ state: 'running', detail: null, platform })
        if (healthyTimer) clearTimeout(healthyTimer)
        healthyTimer = setTimeout(() => {
          healthyTimer = null
          attempt = 0
        }, HEALTHY_AFTER_MS)
        return
      case 'raw':
        onRaw(e.ids)
        return
      case 'line':
        sawMacLine = true
        if (probeTimer) clearTimeout(probeTimer)
        probeTimer = null
        if (status.state === 'unavailable') setStatus({ state: 'running', detail: null, platform })
        return
      case 'log':
        log(e.level, e.event, e.data)
        return
    }
  }

  function start(): void {
    if (proc || !enabled) return
    if (!SUPPORTED.includes(platform)) {
      setStatus({ state: 'unavailable', detail: 'Meeting detection isn’t available on this computer.', platform })
      return
    }
    const child = utilityProcess.fork(join(__dirname, 'micmon.js'), [], { serviceName: 'notula-micmon' })
    proc = child
    child.on('message', (m: MicmonEvent) => onEvent(m))
    child.on('exit', (code) => {
      if (proc !== child) return
      proc = null
      if (healthyTimer) clearTimeout(healthyTimer)
      healthyTimer = null
      // The exit says nothing about the apps: the last list stands until the next report.
      if (!enabled) {
        clear('monitor-exited')
        return
      }
      log('warn', 'meetings:monitor-exited', { code, attempt })
      if (attempt >= RESTART_ATTEMPTS) {
        setStatus({ state: 'error', detail: 'Meeting detection stopped after repeated failures.', platform })
        clear('monitor-gave-up')
        return
      }
      const delay = Math.min(RESTART_MAX_MS, RESTART_FIRST_MS * 2 ** attempt)
      attempt++
      restartTimer = setTimeout(() => {
        restartTimer = null
        start()
      }, delay)
    })
    child.postMessage({ type: 'start', platform } satisfies MicmonStart)
  }

  function stop(): void {
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = null
    if (healthyTimer) clearTimeout(healthyTimer)
    healthyTimer = null
    const child = proc
    proc = null
    if (child) {
      // The worker ends its OS child first; the kill is only the fallback.
      try {
        child.postMessage({ type: 'stop' } satisfies MicmonStart)
      } catch {
        // Already gone.
      }
      setTimeout(() => child.kill(), STOP_GRACE_MS).unref()
    }
    attempt = 0
    clear('detection-stopped')
  }

  function setEnabled(on: boolean): void {
    if (on === enabled) return
    enabled = on
    if (on) {
      start()
    } else {
      stop()
      setStatus({ state: 'disabled', detail: null, platform })
    }
  }

  void ctx.settings
    .get('meetings.detectionEnabled')
    .then(setEnabled)
    .catch((err: unknown) => {
      log('warn', 'meetings:settings-read-failed', { err })
      setEnabled(true)
    })

  ctx.bus.on('settings:changed', ({ keys, settings }) => {
    if (keys.includes('meetings.detectionEnabled')) setEnabled(settings['meetings.detectionEnabled'])
  })

  // A real quit ends the monitor on purpose: no restart, no crash line.
  app.on('will-quit', () => {
    enabled = false
    stop()
  })

  // macOS 14.2+ may never log sensor-indicator lines. Notula's own capture
  // takes the mic, so a silent log within 10 s of it means the path is unavailable.
  if (platform === 'darwin') {
    ctx.bus.on('capture:started', () => {
      if (sawMacLine || !proc || probeTimer) return
      probeTimer = setTimeout(() => {
        probeTimer = null
        if (!sawMacLine && enabled) {
          setStatus({ state: 'unavailable', detail: 'Couldn’t read the microphone status, so calls won’t be detected.', platform })
        }
      }, MAC_PROBE_MS)
    })
  }

  ipcMain.handle('meetings:get-mic-apps' satisfies InvokeChannel, (): InvokeRes<'meetings:get-mic-apps'> => apps)
  ipcMain.handle('meetings:get-status' satisfies InvokeChannel, (): InvokeRes<'meetings:get-status'> => status)
}
