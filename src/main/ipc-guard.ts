// SPDX-License-Identifier: Apache-2.0
// The device-lock IPC guard.
//
// While locked, an invoke on a channel outside LOCK_ALLOWED_CHANNEL_PREFIXES (or inside
// LOCK_DENIED_CHANNEL_PREFIXES, checked first) rejects `locked: Notula is locked`, and such a send
// is dropped with a debug line naming only the channel. Call sites keep writing
// `ipcMain.handle('<literal>' …)` / `ipcMain.on('<literal>' …)` unchanged, so static analysis of
// the bundle still pairs every channel with its handler.
//
// How: the guard never changes `ipcMain`. Any change to the `ipcMain` object (assigning `handle` /
// `on`, or `defineProperty` / `setPrototypeOf` on it) hides every main handler in the bundle from
// static analysis. It works per renderer instead, through Electron's own precedence:
// - invokes: Electron asks `webContents.ipc` before `ipcMain`. While locked, every renderer's
//   `ipc` gets a refusing handler for each registered invoke channel the lock does not allow;
//   unlocking removes them. These `handle(channel …)` calls take a variable channel: they are the
//   one deliberate dynamic-channel location.
// - sends: Electron delivers a renderer send with `ipcMain.emit(channel, event, …)`, which is
//   Node's `EventEmitter.prototype.emit` (Electron 44 does not route it through a JS-visible
//   `webContents` event the guard could stop). That method is wrapped once: for the `ipcMain`
//   object only, a renderer event on a channel the lock does not allow is dropped while locked.
//   Every other emitter passes straight through after one identity check.

import { EventEmitter } from 'node:events'
import { app, type WebContents } from 'electron'
import { notulaError } from '@shared/errors'
import { channelAllowedWhileLocked } from '@shared/types/device-lock'
import { log } from './log'

let installed = false

/** The invoke channels registered so far on `ipcMain` (read only; Electron 44's handler map). */
type InvokeRegistry = { _invokeHandlers?: Map<string, unknown> }

export function installIpcGuard(isLocked: () => boolean, invokeRegistry: InvokeRegistry): void {
  if (installed) return
  installed = true
  const contents = new Set<WebContents>()
  /** Per renderer, the channels whose refusing handler is in place. */
  const blocked = new Map<WebContents, Set<string>>()
  let locked = false

  const refuse = (): never => {
    throw notulaError('locked', 'Notula is locked')
  }
  const lockedChannels = (): string[] =>
    [...(invokeRegistry._invokeHandlers?.keys() ?? [])].filter((ch) => !channelAllowedWhileLocked(ch))

  /** Adds the refusing handlers this renderer lacks (channels registered later included). */
  const block = (wc: WebContents): void => {
    if (wc.isDestroyed()) return
    const have = blocked.get(wc) ?? new Set<string>()
    for (const ch of lockedChannels()) {
      if (have.has(ch)) continue
      wc.ipc.handle(ch, refuse)
      have.add(ch)
    }
    blocked.set(wc, have)
  }
  const unblock = (wc: WebContents): void => {
    const channels = blocked.get(wc)
    blocked.delete(wc)
    if (!channels || wc.isDestroyed()) return
    for (const ch of channels) wc.ipc.removeHandler(ch)
  }

  const watch = (wc: WebContents): void => {
    contents.add(wc)
    wc.once('destroyed', () => {
      contents.delete(wc)
      blocked.delete(wc)
    })
    if (locked) block(wc)
  }
  app.on('web-contents-created', (_e, wc) => watch(wc))

  if (!invokeRegistry._invokeHandlers) log('error', 'ipc-guard:invoke-registry-missing')

  const baseEmit = EventEmitter.prototype.emit
  // `arguments` instead of a rest parameter: the unlocked path must not allocate.
  EventEmitter.prototype.emit = function guardedEmit(this: unknown, name: string | symbol, event?: unknown): boolean {
    if (this === invokeRegistry && typeof name === 'string' && isLocked()) {
      const fromRenderer = typeof event === 'object' && event !== null && 'sender' in event
      if (fromRenderer && !channelAllowedWhileLocked(name)) {
        log('debug', 'ipc-guard:dropped', { channel: name })
        return false
      }
    }
    // eslint-disable-next-line prefer-rest-params
    return Reflect.apply(baseEmit, this, arguments) as boolean
  }

  // Polled cheaply: the lock flips rarely, and `isLocked` belongs to the device lock (read at call
  // time). While locked, each tick also covers channels registered since the last one (the lock
  // engages at launch, before most modules have registered).
  const sync = (): void => {
    const now = isLocked()
    if (now === locked) {
      if (now) for (const wc of contents) block(wc)
      return
    }
    locked = now
    for (const wc of contents) (now ? block : unblock)(wc)
  }
  const timer = setInterval(sync, 250)
  timer.unref()
  syncNow = sync
}

let syncNow: () => void = () => undefined

/** The device lock calls this right after the lock state changes, so the guard follows at once. */
export function syncIpcGuard(): void {
  syncNow()
}
