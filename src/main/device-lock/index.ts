// SPDX-License-Identifier: Apache-2.0
// The device lock: the `device-lock:*` IPC and ctx.deviceLock.
//
// - While `security.deviceLock` is on, Notula locks at launch, on `lock-screen` and `suspend`,
//   and after `security.lockAfterMinutes` with no focused Notula window. Locking hides the content
//   windows and arms the IPC guard (ipc-guard.ts); the renderer's DeviceLockGate shows the
//   lock view from the lock-state push.
// - Protected changes (PROTECTED_REASONS) need a successful verification while the lock is on,
//   whoever asks. There is no channel that only verifies, so no renderer can probe the OS
//   verifier on its own.
// - One log line per attempt: the reason and the result word, never anything biometric.

import { app, BrowserWindow, ipcMain, powerMonitor } from 'electron'
import type { InvokeChannel, InvokeReq, InvokeRes, PushChannel } from '@shared/ipc'
import {
  PROTECTED_REASONS,
  type DeviceLockFailure,
  type DeviceLockStatus,
  type DeviceLockUnavailable,
  type ProtectedTarget
} from '@shared/types/device-lock'
import type { IsoTime } from '@shared/types/common'
import type { DeviceLockApi, MainContext } from '../context'
import { syncIpcGuard } from '../ipc-guard'
import { log } from '../log'
import { createVerifier, type Availability, type Verification } from './verifier'

const UNLOCK_REASON = 'unlock Notula'
const ENABLE_REASON = 'turn on the Notula lock'
const AVAILABILITY_TTL_MS = 30_000
/** The OS reports the method itself gone (not a failed attempt): the lock turns off. */
const METHOD_GONE: readonly DeviceLockUnavailable[] = ['device-not-present', 'not-configured', 'disabled-by-policy', 'no-touch-id']

function methodGoneWarning(method: Availability['method']): string {
  const name = method === 'touch-id' ? 'Touch ID' : 'Windows Hello'
  return `Device lock was turned off because ${name} is no longer set up.`
}

export function registerDeviceLock(ctx: MainContext): DeviceLockApi {
  const verifier = createVerifier(ctx.userDataPath)

  // Until the start-up read settles, Notula counts as locked: a cold start with the lock on never
  // serves a note first. The renderer's gate waits on `device-lock:get-status`, which is allowed.
  let pending = true
  let enabled = false
  let locked = false
  let lockAfterMinutes: DeviceLockStatus['lockAfterMinutes'] = null
  let warning: string | null = null
  let lastProtectedChange: DeviceLockStatus['lastProtectedChange'] = null
  let avail: Availability | null = null
  let availAt = 0
  let availRun: Promise<Availability> | null = null
  /** The one verification in flight; an unlock joins a running unlock. */
  let verifying: { reason: string; run: Promise<Verification> } | null = null
  let idleTimer: NodeJS.Timeout | null = null

  const now = (): IsoTime => new Date().toISOString() as IsoTime

  function refreshAvailability(force = false): Promise<Availability> {
    if (!force && avail && Date.now() - availAt < AVAILABILITY_TTL_MS) return Promise.resolve(avail)
    if (availRun) return availRun
    availRun = verifier
      .availability()
      .then((a) => {
        // A check that met a running prompt says nothing new: keep what we knew.
        if (a.unavailable === 'helper-failed' && verifying && avail) return avail
        avail = a
        availAt = Date.now()
        return a
      })
      .finally(() => {
        availRun = null
      })
    return availRun
  }

  function snapshot(): DeviceLockStatus {
    const a = avail ?? { method: process.platform === 'darwin' ? 'touch-id' : process.platform === 'win32' ? 'windows-hello' : 'none', unavailable: null }
    return {
      supported: a.method !== 'none',
      method: a.method,
      unavailableReason: a.unavailable,
      enabled,
      locked: locked || pending,
      lockAfterMinutes,
      warning,
      lastProtectedChange
    }
  }

  function push(): void {
    const s = snapshot()
    for (const wc of ctx.windows.targets()) wc.send('device-lock:changed' satisfies PushChannel, s)
  }

  function setLockedState(next: boolean, why: string): void {
    if (locked === next) return
    locked = next
    ctx.windows.setContentLocked(next)
    syncIpcGuard()
    log('info', next ? 'device-lock:locked' : 'device-lock:unlocked', { why })
    push()
  }

  function lock(why: string): void {
    if (!enabled || locked) return
    clearIdle()
    setLockedState(true, why)
  }

  /** One OS verification at a time. A second request while one runs gets `busy` (an unlock joins an unlock). */
  function verify(reason: string): Promise<Verification> {
    if (verifying) {
      if (verifying.reason === reason) return verifying.run
      log('info', 'device-lock:verify', { reason, result: 'busy' })
      return Promise.resolve({ ok: false, reason: 'busy', osUnavailable: null })
    }
    const run = verifier
      .verify(reason)
      .catch((): Verification => ({ ok: false, reason: 'unavailable', osUnavailable: null }))
      .then((v) => {
        log('info', 'device-lock:verify', { reason, result: v.ok ? 'verified' : v.reason })
        return v
      })
      .finally(() => {
        verifying = null
      })
    verifying = { reason, run }
    return run
  }

  /** "Method gone": the switch turns off with the warning, and Notula opens. */
  async function methodGone(a: Availability): Promise<void> {
    warning = methodGoneWarning(a.method)
    enabled = false
    log('warn', 'device-lock:method-gone', { unavailable: a.unavailable })
    try {
      await ctx.settings.set('security.deviceLock', false)
    } catch (err) {
      log('error', 'device-lock:disable-failed', { err })
    }
    if (locked) setLockedState(false, 'method-gone')
    else push()
  }

  async function handleFailure(v: Verification): Promise<void> {
    if (v.ok || !v.osUnavailable || !METHOD_GONE.includes(v.osUnavailable)) return
    await methodGone(await refreshAvailability(true))
  }

  async function unlock(): Promise<{ ok: boolean; reason: DeviceLockFailure | null }> {
    if (pending) await ready
    if (!locked) return { ok: true, reason: null }
    const v = await verify(UNLOCK_REASON)
    if (v.ok) {
      setLockedState(false, 'verified')
      return { ok: true, reason: null }
    }
    await handleFailure(v)
    if (!locked) return { ok: true, reason: null }
    return { ok: false, reason: v.reason }
  }

  async function confirmProtectedChange(target: ProtectedTarget): Promise<boolean> {
    if (pending) await ready
    if (!enabled) return true
    const v = await verify(PROTECTED_REASONS[target])
    if (!v.ok) await handleFailure(v)
    lastProtectedChange = { target, applied: v.ok, at: now() }
    log('info', 'device-lock:protected-change', { target, applied: v.ok })
    push()
    return v.ok
  }

  // ---------- idle relock ----------

  function clearIdle(): void {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
  }

  function armIdle(): void {
    clearIdle()
    if (!enabled || locked || lockAfterMinutes === null) return
    if (BrowserWindow.getFocusedWindow()) return
    idleTimer = setTimeout(() => lock(`idle-${lockAfterMinutes}m`), lockAfterMinutes * 60_000)
    idleTimer.unref()
  }

  app.on('browser-window-focus', clearIdle)
  app.on('browser-window-blur', () => setTimeout(armIdle, 0))
  powerMonitor.on('lock-screen', () => lock('lock-screen'))
  powerMonitor.on('suspend', () => lock('suspend'))
  app.on('before-quit', () => verifier.dispose())

  ctx.bus.on('settings:changed', (e) => {
    if (e.keys.includes('security.lockAfterMinutes')) {
      lockAfterMinutes = e.settings['security.lockAfterMinutes']
      armIdle()
    }
    if (e.keys.includes('security.deviceLock')) enabled = e.settings['security.deviceLock']
  })

  // ---------- start-up ----------

  const ready: Promise<void> = (async () => {
    try {
      enabled = await ctx.settings.get('security.deviceLock')
      lockAfterMinutes = await ctx.settings.get('security.lockAfterMinutes')
    } catch (err) {
      log('error', 'device-lock:settings-read-failed', { err })
    }
    if (!enabled) return
    locked = true
    ctx.windows.setContentLocked(true)
    const a = await refreshAvailability(true).catch((): Availability | null => null)
    if (a?.unavailable && METHOD_GONE.includes(a.unavailable)) await methodGone(a)
    else log('info', 'device-lock:locked', { why: 'launch' })
  })().finally(() => {
    pending = false
    syncIpcGuard()
    push()
  })

  // ---------- IPC (literal channels) ----------

  ipcMain.handle('device-lock:get-status' satisfies InvokeChannel, async (): Promise<InvokeRes<'device-lock:get-status'>> => {
    await ready
    if (!avail) await refreshAvailability().catch(() => null)
    else void refreshAvailability().then(push, () => undefined)
    return snapshot()
  })

  ipcMain.handle(
    'device-lock:set-enabled' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'device-lock:set-enabled'>): Promise<InvokeRes<'device-lock:set-enabled'>> => {
      await ready
      const want = req?.enabled === true
      if (want === enabled) return snapshot()
      if (want) {
        // Turning it on needs one successful verification first, so a broken method can't lock anyone out.
        const a = await refreshAvailability(true)
        if (a.unavailable) return snapshot()
        const v = await verify(ENABLE_REASON)
        lastProtectedChange = { target: 'security.deviceLock', applied: v.ok, at: now() }
        if (v.ok) {
          await ctx.settings.set('security.deviceLock', true)
          enabled = true
          warning = null
          log('info', 'device-lock:enabled')
          armIdle()
        }
        push()
        return snapshot()
      }
      if (await confirmProtectedChange('security.deviceLock')) {
        await ctx.settings.set('security.deviceLock', false)
        enabled = false
        clearIdle()
        log('info', 'device-lock:disabled')
        if (locked) setLockedState(false, 'disabled')
        else push()
      }
      return snapshot()
    }
  )

  ipcMain.handle('device-lock:unlock' satisfies InvokeChannel, (): Promise<InvokeRes<'device-lock:unlock'>> => unlock())

  const api: DeviceLockApi = {
    isLocked: () => pending || locked,
    requestUnlock: async () => {
      if (pending) await ready
      if (!locked) return true
      const w = ctx.windows.main()
      if (w) {
        if (w.isMinimized()) w.restore()
        w.show()
        w.focus()
      }
      return (await unlock()).ok
    },
    confirmProtectedChange
  }

  if (!app.isPackaged && process.env.NOTULA_DEV_DEVICE_LOCK_HARNESS === '1') {
    void ready.then(() => import('./dev-harness')).then((m) => m.runDeviceLockHarness(ctx, api))
  }

  return api
}
