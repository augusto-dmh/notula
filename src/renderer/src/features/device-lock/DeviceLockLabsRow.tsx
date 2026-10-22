// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Labs ▸ Security: the device lock switch and "Lock again after" (in Labs until
// the OS verification helper is tested on real hardware). Turning on verifies first; turning
// off is a protected change. Main decides both (`device-lock:set-enabled`).

import { useState, type JSX } from 'react'
import type { DeviceLockStatus, DeviceLockUnavailable } from '@shared/types/device-lock'
import { Select, Switch } from '../settings/controls'
import { setPrefs } from '../settings/prefs-store'
import { SettingsRow } from '../settings/primitives'
import { methodName, setDeviceLockStatus, useDeviceLock } from './store'
import './device-lock.css'

function unavailableText(reason: DeviceLockUnavailable, method: string): string {
  switch (reason) {
    case 'not-configured':
      return method === 'Touch ID' ? 'Set up Touch ID in System Settings to use this.' : 'Set up Windows Hello in Windows Settings to use this.'
    case 'device-not-present':
      return `This computer has no ${method} sign-in.`
    case 'disabled-by-policy':
      return `${method} is turned off by your organization.`
    case 'device-busy':
      return `${method} is busy. Try again in a moment.`
    case 'no-touch-id':
      return 'This Mac has no Touch ID, or it is not set up.'
    case 'unsupported-platform':
      return 'Not available on this computer.'
    default:
      return `${method} couldn't be reached.`
  }
}

type After = 'screen' | '5' | '15' | '60'
const AFTER_OPTIONS: { value: After; label: string }[] = [
  { value: 'screen', label: 'Only when the computer locks or sleeps' },
  { value: '5', label: 'After 5 minutes in the background' },
  { value: '15', label: 'After 15 minutes in the background' },
  { value: '60', label: 'After 60 minutes in the background' }
]

export function DeviceLockLabsRow(): JSX.Element {
  const status = useDeviceLock()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const method = methodName(status)
  const enabled = status?.enabled ?? false

  const toggle = (next: boolean): void => {
    setBusy(true)
    setNote(null)
    void window.notula.deviceLock
      .setEnabled({ enabled: next })
      .then((s: DeviceLockStatus) => {
        setDeviceLockStatus(s)
        if (s.enabled !== next) setNote(s.unavailableReason ? unavailableText(s.unavailableReason, method) : next ? 'Not turned on.' : 'Not turned off.')
      })
      .catch(() => setNote('Not changed.'))
      .finally(() => setBusy(false))
  }

  const unavailable = status?.unavailableReason ?? null
  const description = `Ask for your fingerprint, face or PIN to open Notula and to turn off protections. Programs you connected to Notula's local API or MCP server keep working.`
  const after: After = status?.lockAfterMinutes ? (String(status.lockAfterMinutes) as After) : 'screen'
  return (
    <>
      <SettingsRow
        title={`Lock Notula with ${method}`}
        description={description}
        control={
          <Switch
            checked={enabled}
            busy={busy}
            disabled={!status || busy || (!enabled && unavailable !== null)}
            label={`Lock Notula with ${method}`}
            onChange={toggle}
          />
        }
      />
      {!enabled && unavailable ? <p className="dl-row-note">{unavailableText(unavailable, method)}</p> : null}
      {status?.warning ? <p className="dl-row-note dl-row-note--warn">{status.warning}</p> : null}
      {note ? (
        <p className="dl-row-note" role="status">
          {note}
        </p>
      ) : null}
      {enabled ? (
        <div className="settings-row labs-row--child">
          <div className="settings-row__text">
            <div className="settings-row__label">Lock again after</div>
          </div>
          <div className="settings-row__control">
            <Select
              label="Lock again after"
              value={after}
              options={AFTER_OPTIONS}
              wide
              onChange={(v) => setPrefs({ 'security.lockAfterMinutes': v === 'screen' ? null : (Number(v) as 5 | 15 | 60) })}
            />
          </div>
        </div>
      ) : null}
    </>
  )
}
