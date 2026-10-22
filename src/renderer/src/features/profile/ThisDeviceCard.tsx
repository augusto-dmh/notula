// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Profile ▸ This device: Notula has no accounts, so
// the "sessions" list is this computer alone, read from `device:get-info` in main.

import { useEffect, useState, type JSX } from 'react'
import type { DeviceInfo } from '@shared/types/device'
import { navigateToSettings } from '../../app/navigation'
import { Group, Row } from '../settings/controls'
import { usePrefs } from '../settings/prefs-store'
import './profile.css'

function since(at: string | null): string {
  if (!at) return 'Today'
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? 'Today' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

export function ThisDeviceCardView(): JSX.Element {
  const [info, setInfo] = useState<DeviceInfo | null>(null)
  const [failed, setFailed] = useState(false)
  // The device-lock switch can change in Labs while this page is open.
  const lockPref = usePrefs()?.['security.deviceLock']

  useEffect(() => {
    let live = true
    window.notula.device.getInfo().then(
      (i) => live && setInfo(i),
      () => live && setFailed(true)
    )
    return () => {
      live = false
    }
  }, [lockPref])

  return (
    <Group title="This device" description="Notula has no accounts, so there are no other sessions to sign out of.">
      {info ? (
        <>
          <Row label={info.deviceName} hint={`${info.os} ${info.osVersion} · Notula ${info.appVersion}`}>
            <span className="device-badge">This computer</span>
          </Row>
          <Row
            label={info.encrypted ? 'Notes are stored only on this computer, encrypted' : 'Notes are stored only on this computer'}
            hint={<span className="device-path" title={info.dataFolder}>{info.dataFolder}</span>}
          >
            <button type="button" className="n-btn n-btn--sm" onClick={() => window.notula.device.revealDataFolder()}>
              Show folder
            </button>
          </Row>
          <Row label="In use since" hint={since(info.firstRunAt)} />
          <Row label={`Device lock: ${info.deviceLockEnabled ? 'on' : 'off'}`} hint="Ask for Windows Hello or Touch ID before showing your notes.">
            <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => navigateToSettings('labs')}>
              {info.deviceLockEnabled ? 'Manage' : 'Set up'}
            </button>
          </Row>
        </>
      ) : failed ? (
        <Row label="This device" hint="Couldn't read this computer's details." />
      ) : (
        <div className="device-loading" aria-busy="true">
          <div className="n-skeleton" style={{ height: 14, width: 180 }} />
          <div className="n-skeleton" style={{ height: 12, width: 260 }} />
        </div>
      )}
    </Group>
  )
}
