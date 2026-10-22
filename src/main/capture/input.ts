// SPDX-License-Identifier: Apache-2.0
// Input device preference and reconcile. Main owns the
// preference: it persists it in the `capture.inputPreference` setting, resolves the
// effective device, and pins or unpins it on the renderer engine.
//
// Auto follows the microphone the
// meeting app is using. On Windows the endpoint monitor (endpoints.ts) says which capture
// endpoint each process records from; the first meeting app's endpoint is matched to the
// renderer's device by label (Chromium's audioinput label is the endpoint's friendly
// name). Other platforms have no monitor: the auto target stays "no device" and Auto is
// the system default.

import type { InputDevice, InputPreference, InputSelectionState } from '@shared/types/capture'
import type { MicApp } from '@shared/types/meetings'
import { log } from '../log'
import { windowsMeetingAppOfExes } from '../meetings/apps'
import type { CaptureEndpoint } from './endpoints'

export type ReconcileReason =
  | 'devices-changed'
  | 'capture-started'
  | 'preference-changed'
  | 'mic-app-changed'
  | 'auto-device-failed'

/** What the reconcile asks the engine to do. */
export type PinAction = { type: 'pin'; deviceId: string } | { type: 'unpin' } | null

/** Unknown (no information yet), no device, or the meeting app's device. */
export type AutoTarget =
  | { kind: 'unknown' }
  | { kind: 'no-device' }
  | { kind: 'device'; deviceId: string; label: string; appId: string }

const AUTO: InputPreference = { mode: 'auto' }
const AUTO_DEVICE_ID = 'default'
const UNKNOWN: AutoTarget = { kind: 'unknown' }
const NO_DEVICE: AutoTarget = { kind: 'no-device' }
/** Only Windows has a device monitor; elsewhere Auto is the system default. */
const FOLLOWS = process.platform === 'win32'

/** Anything but the two valid shapes reads as auto. */
export function normalizePreference(value: unknown): InputPreference {
  if (value && typeof value === 'object') {
    const v = value as { mode?: unknown; deviceId?: unknown }
    if (v.mode === 'physical-device' && typeof v.deviceId === 'string' && v.deviceId.length > 0) {
      return { mode: 'physical-device', deviceId: v.deviceId }
    }
  }
  return AUTO
}

/**
 * The renderer device for an endpoint name: an exact label first, then a label that adds
 * one parenthesized suffix Chromium appends (" (Bluetooth)"; the USB id is already gone).
 */
function deviceForEndpoint(name: string, devices: readonly InputDevice[]): InputDevice | null {
  const usable = devices.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
  return (
    usable.find((d) => d.label === name) ??
    usable.find((d) => d.label.startsWith(`${name} (`) && d.label.endsWith(')') && !d.label.slice(name.length + 2).includes('(')) ??
    null
  )
}

/**
 * From the endpoint report: the meeting apps recording from an endpoint (Notula's own
 * processes left out), ordered by the mic-app list first, then report order. The first one
 * whose endpoint maps to a renderer device is the target.
 */
export function resolveAutoTarget(
  endpoints: readonly CaptureEndpoint[] | null,
  micApps: readonly MicApp[],
  devices: readonly InputDevice[] | null,
  ownPids: ReadonlySet<number>
): AutoTarget {
  if (!FOLLOWS) return NO_DEVICE
  if (!endpoints || !devices) return UNKNOWN
  const found: { app: MicApp; endpoint: CaptureEndpoint }[] = []
  for (const endpoint of endpoints) {
    for (const s of endpoint.sessions) {
      if (ownPids.has(s.pid)) continue
      const app = windowsMeetingAppOfExes(s.exes)
      if (app && !found.some((f) => f.app.appId === app.appId && f.endpoint.id === endpoint.id)) found.push({ app, endpoint })
    }
  }
  const rank = (appId: string): number => {
    const i = micApps.findIndex((a) => a.appId === appId)
    return i < 0 ? micApps.length : i
  }
  found.sort((a, b) => rank(a.app.appId) - rank(b.app.appId))
  for (const f of found) {
    const d = deviceForEndpoint(f.endpoint.name, devices)
    if (d) return { kind: 'device', deviceId: d.deviceId, label: d.label, appId: f.app.appId }
  }
  return NO_DEVICE
}

const sameTarget = (a: AutoTarget, b: AutoTarget): boolean =>
  a.kind === b.kind && (a.kind !== 'device' || (b.kind === 'device' && a.deviceId === b.deviceId && a.appId === b.appId))

export class InputSelection {
  private stored: InputPreference = AUTO
  /** Null until the engine has reported a list. */
  private devices: InputDevice[] | null = null
  /** The pin last applied on the engine (`null` = unpinned). */
  private appliedPin: string | null = null
  private target: AutoTarget = FOLLOWS ? UNKNOWN : NO_DEVICE
  /**
   * Auto devices that failed to open when pinned ("Device in use"): the engine fell back to
   * the default, and Auto does not pin them again until the device list changes or
   * capture restarts.
   */
  private readonly failed = new Set<string>()
  private lastState: string = JSON.stringify(null)
  private lastLogTuple = ''

  setStored(pref: InputPreference): void {
    this.stored = normalizePreference(pref)
  }

  getStored(): InputPreference {
    return this.stored
  }

  /** True when the list's devices changed. */
  setDevices(devices: InputDevice[]): boolean {
    const key = (l: InputDevice[] | null): string => JSON.stringify(l?.map((d) => [d.deviceId, d.label]) ?? null)
    const changed = key(this.devices) !== key(devices)
    this.devices = devices
    if (changed) this.failed.clear()
    return changed
  }

  getDevices(): InputDevice[] {
    return this.devices ?? []
  }

  devicesOrNull(): InputDevice[] | null {
    return this.devices
  }

  /** True when the auto target changed. */
  setAutoTarget(next: AutoTarget): boolean {
    if (sameTarget(next, this.target)) return false
    this.target = next
    return true
  }

  autoTarget(): AutoTarget {
    return this.target
  }

  /** Back to "no information" (capture stopped); restarts forget earlier failures. */
  resetAutoTarget(): void {
    this.target = FOLLOWS ? UNKNOWN : NO_DEVICE
    this.failed.clear()
  }

  /**
   * The engine opened something other than the auto device it was asked for. Logged once
   * per device; the next reconcile unpins instead of asking again (no loop).
   */
  autoPinFailed(requested: string, got: string | null): boolean {
    if (this.target.kind !== 'device' || this.target.deviceId !== requested || this.failed.has(requested)) return false
    this.failed.add(requested)
    log('warn', 'input:auto-device-unavailable', { appId: this.target.appId, label: this.target.label, got: got ?? 'none' })
    return true
  }

  /** The stored preference, except that a device known to be missing falls back to auto. */
  effective(): InputPreference {
    const s = this.stored
    if (s.mode === 'physical-device' && this.devices && !this.devices.some((d) => d.deviceId === s.deviceId)) {
      return AUTO
    }
    return s
  }

  /** The device Auto pins, or null for the system default. */
  private autoPin(): string | null {
    const t = this.target
    return t.kind === 'device' && !this.failed.has(t.deviceId) ? t.deviceId : null
  }

  /** Selection exists only while capturing (no flag gate). */
  state(capturing: boolean): InputSelectionState | null {
    if (!capturing) return null
    return { preference: this.effective(), autoDeviceId: this.autoPin() ?? AUTO_DEVICE_ID }
  }

  /** The pin to put in the start command; it becomes the applied pin. */
  startPin(): string | null {
    const eff = this.effective()
    this.appliedPin = eff.mode === 'physical-device' ? (this.devices ? eff.deviceId : null) : this.autoPin()
    return this.appliedPin
  }

  resetApplied(): void {
    this.appliedPin = null
  }

  /** Resolves the effective device and the pin or unpin the engine needs, if any. */
  reconcile(reason: ReconcileReason): PinAction {
    const eff = this.effective()
    let action: PinAction = null
    let target: string | null = this.appliedPin
    const auto = this.autoPin()
    // A failed auto device counts as "no device": the engine already fell back to the default.
    const targetKind = this.target.kind === 'device' && auto === null ? 'no-device' : this.target.kind
    if (eff.mode === 'physical-device') {
      if (this.devices) target = eff.deviceId
    } else if (auto) {
      target = auto
    } else if (reason === 'preference-changed') {
      target = AUTO_DEVICE_ID
    } else if (targetKind === 'no-device') {
      target = null
    }
    if (target !== this.appliedPin) {
      action = target === null ? { type: 'unpin' } : { type: 'pin', deviceId: target }
      this.appliedPin = target
    }
    const autoDeviceId = auto ?? AUTO_DEVICE_ID
    const tuple = JSON.stringify([reason, this.stored.mode, eff.mode, targetKind, autoDeviceId, this.appliedPin])
    if (tuple !== this.lastLogTuple) {
      this.lastLogTuple = tuple
      log('info', 'input:reconcile', {
        reason,
        storedMode: this.stored.mode,
        effectiveMode: eff.mode,
        autoTarget: targetKind,
        ...(this.target.kind === 'device' ? { autoApp: this.target.appId, autoLabel: this.target.label } : {}),
        autoDeviceId,
        applied: this.appliedPin ?? 'none'
      })
    }
    return action
  }

  /** True when the pushed state changed since the last call. */
  stateChanged(capturing: boolean): boolean {
    const next = JSON.stringify(this.state(capturing))
    if (next === this.lastState) return false
    this.lastState = next
    return true
  }
}
