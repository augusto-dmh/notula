// SPDX-License-Identifier: Apache-2.0
// The update state shared by the updater, the tray and the menus. The tray registers before
// the updater (index.ts step 5.3), so the state and
// the manual actions live here and the updater binds them when it registers.

import { app } from 'electron'
import type { UpdateState } from '@shared/types/app'
import { log } from '../log'

let state: UpdateState = {
  feed: 'none',
  packaged: app.isPackaged,
  policyDisabled: false,
  checking: false,
  lastCheck: null,
  download: { state: 'idle' },
  installing: false,
  installBlockedReason: null,
  error: null,
  channel: 'stable',
  betaAvailable: false,
  pausedByLocalOnly: false
}

const listeners = new Set<(s: UpdateState) => void>()

export function getUpdateState(): UpdateState {
  return state
}

export function setUpdateState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch }
  for (const l of listeners) {
    try {
      l(state)
    } catch (err) {
      log('error', 'update:listener-failed', { err })
    }
  }
}

export function onUpdateState(cb: (s: UpdateState) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

interface UpdaterActions {
  check(source: string): void
  install(source: string): Promise<void>
}

/** Before the updater registers (or when it failed to), a check finds nothing and nothing installs. */
let actions: UpdaterActions = {
  check: (source) => {
    log('info', 'update:check-skipped', { source, reason: 'updater not registered' })
    setUpdateState({ lastCheck: { at: new Date().toISOString(), available: false, version: null } })
  },
  install: () => Promise.reject(new Error('Updates aren’t available in this build.'))
}

export function bindUpdaterActions(a: UpdaterActions): void {
  actions = a
}

/** "Check for Updates…" (app menu, dock) and the tray's check row. */
export function checkForUpdatesNow(source: string): void {
  actions.check(source)
}

/** The tray's install row and the sidebar's Install update: install at once ("manual"). */
export function installUpdateNow(source: string): Promise<void> {
  return actions.install(source)
}
