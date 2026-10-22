// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Preferences: "Live captions", off by default.

import type { JSX } from 'react'
import { setPrefs, usePrefs } from '../calendar/store'
import { Switch } from '../settings/controls'

export function CaptionsRow(): JSX.Element {
  const prefs = usePrefs()
  const on = prefs?.['captions.alwaysOn'] === true
  return (
    <div className="settings-row">
      <div className="settings-row__text">
        <div className="settings-row__label">Live captions</div>
        <div className="settings-row__hint">Show captions during every meeting. You can turn them off for one meeting from the meeting bubble.</div>
      </div>
      <div className="settings-row__control">
        <Switch label="Live captions" checked={on} disabled={!prefs} onChange={(next) => setPrefs({ 'captions.alwaysOn': next })} />
      </div>
    </div>
  )
}
