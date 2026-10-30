// SPDX-License-Identifier: Apache-2.0
// Labs ▸ Meetings: the off-the-record check. While it is on but can't run, the row says which
// requirement stops it; main reads the same requirements at each capture start.

import type { JSX } from 'react'
import { LABS_FEATURES } from '@shared/types/labs'
import type { Settings } from '@shared/types/settings'
import { Switch } from '../settings/controls'
import { setPrefs, usePrefs } from '../settings/prefs-store'

const FEATURE = LABS_FEATURES.find((f) => f.key === 'capture.offRecordPrompt')

function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '')
    return h === 'localhost' || h === '::1' || /^127\./.test(h)
  } catch {
    return false
  }
}

/** Why the check can't run with these settings, or null. */
function blockedBy(prefs: Settings): string | null {
  if (prefs['bubble.blocked']) return 'Not running: it needs the Live meeting indicator, which is off in Settings ▸ Preferences.'
  if (prefs['asr.language'] !== 'en') return 'Not running: it works only when the transcription language is English.'
  if (prefs['privacy.localOnly'] && !(prefs['llm.provider'] === 'local' && isLoopback(prefs['llm.local.baseUrl']))) {
    return 'Not running while Nothing leaves this machine is on, unless you use a local AI model.'
  }
  return null
}

export function OffRecordLabsRow(): JSX.Element | null {
  const prefs = usePrefs()
  if (!FEATURE) return null
  const on = prefs?.['capture.offRecordPrompt'] === true
  const blocked = on && prefs ? blockedBy(prefs) : null
  return (
    <div className="settings-row">
      <div className="settings-row__text">
        <div className="settings-row__label">{FEATURE.label}</div>
        <div className="settings-row__hint">{FEATURE.description}</div>
        {blocked ? (
          <div className="settings-row__hint" role="status">
            {blocked}
          </div>
        ) : null}
      </div>
      <div className="settings-row__control">
        <Switch label={FEATURE.label} checked={on} disabled={!prefs} onChange={(next) => setPrefs({ 'capture.offRecordPrompt': next })} />
      </div>
    </div>
  )
}
