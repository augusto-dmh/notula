// SPDX-License-Identifier: Apache-2.0
// The renderer view of the permission state.
// Main owns the record; this store mirrors `permissions:get-state` and the
// `permissions:changed` push, and runs the system-audio probe, which only the
// renderer can do.

import { useSyncExternalStore } from 'react'
import type { PermissionsState } from '@shared/types/permissions'
import { debugLog } from '../../app/platform'

const listeners = new Set<() => void>()
let snapshot: PermissionsState | null = null
/** Counts `permissions:changed` pushes, so a dismissed warning can come back on the next one. */
let pushes = 0
let started = false

function set(next: PermissionsState): void {
  snapshot = next
  for (const l of listeners) l()
}

function refresh(): void {
  window.notula.permissions
    .getState()
    .then(set)
    .catch((err: unknown) => debugLog('permissions:get-state-failed', { err: String(err) }))
}

function start(): void {
  if (started) return
  started = true
  window.notula.permissions.onChanged((next) => {
    pushes++
    set(next)
  })
  refresh()
}

function subscribe(cb: () => void): () => void {
  start()
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** The permission state, or null while it is unknown. */
export function usePermissions(): PermissionsState | null {
  return useSyncExternalStore(subscribe, () => snapshot)
}

export function usePermissionPushes(): number {
  return useSyncExternalStore(subscribe, () => pushes)
}

export function refreshPermissions(): void {
  start()
  refresh()
}

export async function requestMicrophone(): Promise<PermissionsState> {
  const next = await window.notula.permissions.requestMicrophone()
  set(next)
  return next
}

/** Stops every track of a stream we only opened to ask. */
function release(stream: MediaStream): void {
  for (const t of stream.getTracks()) t.stop()
}

/**
 * The system-audio request on the browser path: an audio-only
 * display-media stream, stopped at once; success means granted. Main answers the
 * request with loopback audio. If audio-only is refused for a reason other than a
 * denial, one retry asks for a minimal video track too (the capture engine's fallback).
 */
async function probeSystemAudio(): Promise<{ granted: boolean; errorName?: string }> {
  try {
    release(await navigator.mediaDevices.getDisplayMedia({ audio: true, video: false }))
    return { granted: true }
  } catch (err) {
    const name = err instanceof DOMException ? err.name : 'Error'
    if (name === 'NotAllowedError') return { granted: false, errorName: name }
    try {
      release(await navigator.mediaDevices.getDisplayMedia({ audio: true, video: { width: 1, height: 1, frameRate: 1 } }))
      return { granted: true }
    } catch (err2) {
      return { granted: false, errorName: err2 instanceof DOMException ? err2.name : name }
    }
  }
}

let probing: Promise<PermissionsState> | null = null

/** Brackets the probe with the requesting mark; concurrent calls share one probe. */
export function requestSystemAudio(): Promise<PermissionsState> {
  probing ??= (async () => {
    try {
      set(await window.notula.permissions.requestSystemAudio({ stage: 'begin' }))
      const result = await probeSystemAudio()
      const next = await window.notula.permissions.requestSystemAudio({ stage: 'result', ...result })
      set(next)
      return next
    } finally {
      probing = null
    }
  })()
  return probing
}

export async function checkSystemAudio(): Promise<void> {
  try {
    await window.notula.permissions.checkSystemAudio()
  } catch (err) {
    debugLog('permissions:check-failed', { err: String(err) })
  }
}
