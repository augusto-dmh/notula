// SPDX-License-Identifier: Apache-2.0
// registerPermissions(): the permission record, OS media status, privacy-settings
// links and the onboarding state, with their IPC.
//
// - The record (microphone, system audio, the "requesting system audio" mark) is a
//   per-device fact under the main-only setting `permissions.record`.
// - At startup every platform but macOS records both as granted: Notula's browser capture
//   path needs no OS grant for loopback. macOS
//   refreshes the microphone from the OS; the renderer re-runs the
//   system-audio probe, which only it can do.
// - `osMicrophone` is the OS status, read at startup, at every capture start
//   and on each get-state. Windows shows a warning when it reads denied.
// - `systemAudioCheck` (macOS): `screenCapture` from the OS screen status;
//   `audioCapture` stays `unknown`, Electron has no reader for it.
// - `onboarding:set-state` also emits the bus `ui:onboarding`, which backs
//   `ctx.ui.inOnboarding()`.
//
// Handlers and pushes write their channel literal.

import { app, ipcMain, shell, systemPreferences } from 'electron'
import { parseError } from '@shared/errors'
import type { InvokeChannel, InvokeRes, PushChannel, SendChannel } from '@shared/ipc'
import type {
  OsMediaStatus,
  PermissionRecord,
  PermissionsState,
  PermissionState,
  SystemAudioCheck,
  TccStatus
} from '@shared/types/permissions'
import { DEFAULT_SETTINGS } from '@shared/types/settings'
import type { MainContext } from '../context'
import { log } from '../log'

// Interop literals, written exactly.
const MAC_PRIVACY_MICROPHONE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
const MAC_PRIVACY_SCREEN_CAPTURE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
const MAC_SECURITY_PANE = '/System/Library/PreferencePanes/Security.prefPane'
const WIN_PRIVACY_MICROPHONE = 'ms-settings:privacy-microphone'
/** Voice typing's paste and screen context. */
const MAC_PRIVACY_ACCESSIBILITY = 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility'

const isMac = process.platform === 'darwin'
const OS_STATUSES: readonly OsMediaStatus[] = ['not-determined', 'granted', 'denied', 'restricted', 'unknown']

/**
 * The OS microphone status. Dev builds only: `NOTULA_DEV_OS_MICROPHONE=denied` (or
 * any other status) stands in for the OS, to check the Windows warning by hand.
 */
function osMicrophoneStatus(): OsMediaStatus {
  const devOverride = app.isPackaged ? undefined : process.env['NOTULA_DEV_OS_MICROPHONE']
  if (devOverride && (OS_STATUSES as readonly string[]).includes(devOverride)) return devOverride as OsMediaStatus
  if (process.platform !== 'darwin' && process.platform !== 'win32') return 'unknown'
  try {
    const s = systemPreferences.getMediaAccessStatus('microphone')
    return OS_STATUSES.includes(s) ? s : 'unknown'
  } catch (err) {
    log('warn', 'permissions:os-microphone-failed', { err })
    return 'unknown'
  }
}

/** Other platforms report both as authorized. */
function checkSystemAudio(): SystemAudioCheck {
  if (!isMac) return { audioCapture: 'authorized', screenCapture: 'authorized' }
  let screenCapture: TccStatus
  try {
    const s = systemPreferences.getMediaAccessStatus('screen')
    screenCapture = s === 'granted' ? 'authorized' : s === 'denied' || s === 'restricted' ? 'denied' : 'unknown'
  } catch (err) {
    log('warn', 'permissions:screen-status-failed', { err })
    screenCapture = 'process-error'
  }
  return { audioCapture: 'unknown', screenCapture }
}

function sameRecord(a: PermissionRecord, b: PermissionRecord): boolean {
  return a.microphone === b.microphone && a.systemAudio === b.systemAudio && a.requestingSystemAudio === b.requestingSystemAudio
}

function sameCheck(a: SystemAudioCheck | null, b: SystemAudioCheck | null): boolean {
  return a === b || (!!a && !!b && a.audioCapture === b.audioCapture && a.screenCapture === b.screenCapture)
}

const GRANTED_RECORD: PermissionRecord = { microphone: 'granted', systemAudio: 'granted', requestingSystemAudio: false }

export function registerPermissions(ctx: MainContext): void {
  let record: PermissionRecord | null = null
  let loading: Promise<PermissionRecord> | null = null
  let osMicrophone: OsMediaStatus = osMicrophoneStatus()
  let systemAudioCheck: SystemAudioCheck | null = checkSystemAudio()
  let inOnboarding: boolean | null = null

  log('info', 'permissions:os-microphone', { status: osMicrophone, at: 'startup' })

  function state(rec: PermissionRecord): PermissionsState {
    return { ...rec, platform: process.platform, osMicrophone, systemAudioCheck }
  }

  function push(rec: PermissionRecord): void {
    const payload = state(rec)
    for (const wc of ctx.windows.targets()) wc.send('permissions:changed' satisfies PushChannel, payload)
  }

  async function persist(rec: PermissionRecord): Promise<void> {
    try {
      await ctx.settings.set('permissions.record', rec)
    } catch (err) {
      // While storage needs recovery the record lives in memory only; it is
      // re-derived once storage is ready (never a reason to drop user data).
      log(parseError(err).code === 'storage-unavailable' ? 'info' : 'error', 'permissions:persist-failed', { err })
    }
  }

  /** The stored record with the startup rules applied. */
  async function load(): Promise<PermissionRecord> {
    let stored: PermissionRecord
    try {
      stored = await ctx.settings.get('permissions.record')
    } catch (err) {
      log('warn', 'permissions:record-read-failed', { err })
      stored = structuredClone(DEFAULT_SETTINGS['permissions.record'])
    }
    let next: PermissionRecord
    if (!isMac) {
      next = { ...GRANTED_RECORD }
    } else {
      // macOS: the OS is the authority for the microphone; refresh it silently.
      let microphone: PermissionState = stored.microphone
      if (osMicrophone === 'granted') microphone = 'granted'
      else if (osMicrophone === 'denied' || osMicrophone === 'restricted') microphone = 'denied'
      next = { ...stored, microphone }
    }
    if (!sameRecord(stored, next)) await persist(next)
    log('info', 'permissions:record-loaded', { ...next, platform: process.platform })
    return next
  }

  function current(): Promise<PermissionRecord> {
    if (record) return Promise.resolve(record)
    loading ??= load().then((r) => {
      record = r
      loading = null
      return r
    })
    return loading
  }

  /** Updates run one at a time, so a patch always applies to the latest record. */
  let updates: Promise<unknown> = Promise.resolve()

  function update(patch: Partial<PermissionRecord>): Promise<PermissionRecord> {
    const run = updates.then(async () => {
      const before = await current()
      const next: PermissionRecord = { ...before, ...patch }
      record = next
      if (!sameRecord(before, next)) {
        await persist(next)
        push(next)
      }
      return next
    })
    updates = run.catch(() => undefined)
    return run
  }

  /** Re-reads the OS microphone status; pushes when it changed or `always`. */
  async function refreshOsMicrophone(reason: string, always = false): Promise<void> {
    const before = osMicrophone
    osMicrophone = osMicrophoneStatus()
    if (before !== osMicrophone) log('info', 'permissions:os-microphone', { status: osMicrophone, at: reason })
    if (before !== osMicrophone || always) push(await current())
  }

  // After a recovery the database may be new: derive the record again.
  ctx.bus.on('storage:status', (s) => {
    if (s.state !== 'ready') return
    record = null
    void current().then(push)
  })

  // The OS status at every capture start. Always pushed, so a dismissed
  // warning comes back for the new meeting.
  ctx.bus.on('capture:started', () => {
    void refreshOsMicrophone('capture-started', true)
  })

  void current()

  ipcMain.handle('permissions:get-state' satisfies InvokeChannel, async (): Promise<InvokeRes<'permissions:get-state'>> => {
    const rec = await current()
    const before = osMicrophone
    osMicrophone = osMicrophoneStatus()
    if (before !== osMicrophone) {
      log('info', 'permissions:os-microphone', { status: osMicrophone, at: 'get-state' })
      push(rec)
    }
    return state(rec)
  })

  ipcMain.handle(
    'permissions:request-microphone' satisfies InvokeChannel,
    async (): Promise<InvokeRes<'permissions:request-microphone'>> => {
      if (!isMac) {
        await refreshOsMicrophone('request')
        return state(await update({ microphone: 'granted' }))
      }
      // A request while capturing is answered granted at once.
      if (ctx.capture.isCapturing()) {
        log('info', 'permissions:microphone-request-while-capturing')
        return state(await update({ microphone: 'granted' }))
      }
      let granted = false
      try {
        granted = await systemPreferences.askForMediaAccess('microphone')
      } catch (err) {
        log('error', 'permissions:microphone-request-failed', { err })
      }
      osMicrophone = osMicrophoneStatus()
      log('info', 'permissions:microphone-requested', { granted, os: osMicrophone })
      return state(await update({ microphone: granted ? 'granted' : 'denied' }))
    }
  )

  // The renderer runs the probe; main keeps the mark and the result.
  ipcMain.handle(
    'permissions:request-system-audio' satisfies InvokeChannel,
    async (_e, req: unknown): Promise<InvokeRes<'permissions:request-system-audio'>> => {
      const r = req as { stage?: unknown; granted?: unknown; errorName?: unknown } | null
      if (r?.stage === 'begin') return state(await update({ requestingSystemAudio: true }))
      if (r?.stage === 'result' && typeof r.granted === 'boolean') {
        const errorName = typeof r.errorName === 'string' ? r.errorName.slice(0, 80) : undefined
        log('info', 'permissions:system-audio-result', { granted: r.granted, errorName })
        // A grant clears the mark; a denial leaves it for one re-run at startup.
        return state(
          await update(r.granted ? { systemAudio: 'granted', requestingSystemAudio: false } : { systemAudio: 'denied' })
        )
      }
      log('warn', 'permissions:system-audio-request-invalid')
      return state(await current())
    }
  )

  ipcMain.handle(
    'permissions:check-system-audio' satisfies InvokeChannel,
    async (): Promise<InvokeRes<'permissions:check-system-audio'>> => {
      const next = checkSystemAudio()
      if (!sameCheck(systemAudioCheck, next)) {
        systemAudioCheck = next
        log('info', 'permissions:system-audio-check-changed', { ...next })
        push(await current())
      }
      return next
    }
  )

  ipcMain.on('system:open-privacy-settings' satisfies SendChannel, (_e, p: unknown) => {
    const target = (p as { target?: unknown } | null)?.target
    if (target === 'microphone') {
      if (isMac) void openExternal(MAC_PRIVACY_MICROPHONE)
      else if (process.platform === 'win32') void openExternal(WIN_PRIVACY_MICROPHONE)
      else log('info', 'permissions:privacy-link-unsupported', { target })
      return
    }
    if (target === 'screen-recording') {
      if (!isMac) {
        log('info', 'permissions:privacy-link-unsupported', { target })
        return
      }
      void openExternal(MAC_PRIVACY_SCREEN_CAPTURE).then((ok) => {
        if (ok) return
        void shell.openPath(MAC_SECURITY_PANE).then((error) => {
          if (error) log('error', 'permissions:security-pane-failed', { error })
        })
      })
      return
    }
    if (target === 'accessibility') {
      if (isMac) void openExternal(MAC_PRIVACY_ACCESSIBILITY)
      else log('info', 'permissions:privacy-link-unsupported', { target })
      return
    }
    log('warn', 'permissions:privacy-link-invalid')
  })

  ipcMain.on('onboarding:set-state' satisfies SendChannel, (_e, p: unknown) => {
    const value = (p as { inOnboarding?: unknown } | null)?.inOnboarding
    if (typeof value !== 'boolean') {
      log('warn', 'onboarding:set-state-invalid')
      return
    }
    // The meeting notifications stay quiet during onboarding: the lifecycle's
    // `ctx.ui.inOnboarding()` follows the bus.
    if (value !== inOnboarding) log('info', 'onboarding:state', { inOnboarding: value })
    inOnboarding = value
    ctx.bus.emit('ui:onboarding', { inOnboarding: value })
  })
}

/** Resolves false when the OS could not open the link. */
async function openExternal(url: string): Promise<boolean> {
  try {
    await shell.openExternal(url, { activate: true })
    return true
  } catch (err) {
    log('error', 'permissions:open-link-failed', { url, err })
    return false
  }
}
