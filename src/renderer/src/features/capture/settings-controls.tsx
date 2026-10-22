// SPDX-License-Identifier: Apache-2.0
// Small settings controls for the meeting rows (Preferences ▸ Meetings, Settings ▸
// Notifications): a preferences mirror, a switch and a select. They sit inside the
// SettingsCard / SettingsRow primitives and match their look.

import { useSyncExternalStore, type JSX } from 'react'
import type { Settings, SettingsPatch } from '@shared/types/settings'
import './settings-controls.css'

let prefs: Settings | null = null
let started = false
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

function start(): void {
  if (started) return
  started = true
  window.notula.prefs.onChanged(({ settings }) => {
    prefs = settings
    emit()
  })
  void window.notula.prefs
    .get()
    .then((s) => {
      prefs ??= s
      emit()
    })
    .catch(() => undefined)
}

/** The preferences, or null until the first read. */
export function useMeetingPrefs(): Settings | null {
  return useSyncExternalStore(
    (cb) => {
      start()
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => prefs
  )
}

/** A per-key change, shown at once; main confirms with `prefs:changed`. */
export function setMeetingPrefs(patch: SettingsPatch): void {
  if (prefs) {
    prefs = { ...prefs, ...patch }
    emit()
  }
  window.notula.prefs.set(patch)
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean
  onChange(next: boolean): void
  label: string
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="nt-set-switch"
      onClick={() => onChange(!checked)}
    >
      <span className="nt-set-switch__thumb" />
    </button>
  )
}

export function Choice<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled
}: {
  value: T
  options: readonly { value: T; label: string }[]
  onChange(next: T): void
  label: string
  disabled?: boolean
}): JSX.Element {
  return (
    <span className="nt-set-select">
      <select value={value} aria-label={label} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <svg className="nt-set-select__chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </span>
  )
}
