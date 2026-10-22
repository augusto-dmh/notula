// SPDX-License-Identifier: Apache-2.0
// The live-meeting signals main computes: audio health, the inactivity
// warning and the pending "Resume transcript?" prompt. One subscription per window,
// shared by the note page, the transcript banner and the bubble windows. Each first read
// is skipped when a push already brought something newer.

import { useSyncExternalStore } from 'react'
import type { CaptureHealth, InactivityWarning, PowerResumed } from '@shared/types/capture'

export interface LiveSignals {
  health: CaptureHealth
  inactivity: InactivityWarning | null
  resumed: PowerResumed | null
}

const IDLE_HEALTH: CaptureHealth = {
  noteId: null,
  systemDropout: false,
  dropoutApp: null,
  antivirusSuspected: false,
  restartsThisStreak: 0,
  micSilent: false,
  micSilentDevice: null,
  micSilentWhileSystemSound: false
}

/** A sleep stop older than this is not offered for resume, here as in main. */
const RESUME_WINDOW_MS = 2 * 3_600_000

let state: LiveSignals = { health: IDLE_HEALTH, inactivity: null, resumed: null }
let resumedExpiry: ReturnType<typeof setTimeout> | null = null
let started = false
const pushed = new Set<keyof LiveSignals>()
const listeners = new Set<() => void>()

function set<K extends keyof LiveSignals>(key: K, value: LiveSignals[K], fromPush: boolean): void {
  if (fromPush) pushed.add(key)
  else if (pushed.has(key)) return
  if (state[key] === value) return
  state = { ...state, [key]: value }
  if (key === 'resumed') expireResumed()
  for (const l of listeners) l()
}

/** The prompt goes away 2 h after the sleep stop, as main's offer does. */
function expireResumed(): void {
  if (resumedExpiry) clearTimeout(resumedExpiry)
  resumedExpiry = null
  const r = state.resumed
  if (!r) return
  const left = Date.parse(r.suspendedAt) + RESUME_WINDOW_MS - Date.now()
  if (!(left > 0)) {
    state = { ...state, resumed: null }
    return
  }
  resumedExpiry = setTimeout(() => set('resumed', null, true), left)
}

function start(): void {
  if (started) return
  started = true
  const api = window.notula
  api.capture.onHealth((h) => set('health', h, true))
  api.capture.onInactivity((w) => set('inactivity', w, true))
  api.power.onResumed((r) => set('resumed', r, true))
  void api.capture
    .getHealth()
    .then((h) => set('health', h, false))
    .catch(() => undefined)
  void api.capture
    .getInactivity()
    .then((w) => set('inactivity', w, false))
    .catch(() => undefined)
  void api.power
    .getResumed()
    .then((r) => set('resumed', r, false))
    .catch(() => undefined)
}

export function getLiveSignals(): LiveSignals {
  return state
}

export function subscribeLive(cb: () => void): () => void {
  start()
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useLiveSignals(): LiveSignals {
  return useSyncExternalStore(subscribeLive, getLiveSignals)
}

/**
 * The note started transcribing again some other way (the dock button, the bubble): main
 * already dropped its offer on `capture:started`, so the prompt goes here too.
 * Called by the capture store.
 */
export function clearResumePrompt(noteId: string): void {
  if (state.resumed?.suspendedNoteId === noteId) set('resumed', null, true)
}

/** "Resume" or "Not now" answered the prompt for this note. */
export function answerResumePrompt(noteId: string, resumed: boolean): void {
  window.notula.power.dismissResumed({ noteId, resumed })
  if (state.resumed?.suspendedNoteId === noteId) set('resumed', null, true)
}

/** `m:ss` until `at`. */
export function countdownText(at: string | null, now: number): string | null {
  if (!at) return null
  const left = Math.max(0, Math.ceil((Date.parse(at) - now) / 1000))
  const m = Math.floor(left / 60)
  const s = left % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
