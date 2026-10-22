// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Developer tools: development builds only
// (`!app.isPackaged`), local diagnostics only. Build facts, the updater state,
// and a forced render error for the crash-screen hand check.
// A window-modes fixture drives the four modes, the guide dialog and the
// preview window, which no feature uses yet.

import { useEffect, useState, type JSX } from 'react'
import type { AppInfo } from '@shared/types/common'
import type { WindowMode } from '@shared/types/window-modes'
import { useUpdateState } from '../../app/update-store'
import { GuideDialog, useWindowMode } from '../window-modes'
import guideSample from '../window-modes/guide-sample.svg?no-inline'
import { SettingsCard, SettingsRow } from './primitives'

const MODES: { mode: WindowMode; label: string }[] = [
  { mode: 'wide', label: 'Wide' },
  { mode: 'side', label: 'Side' },
  { mode: 'mini', label: 'Mini' },
  { mode: 'mini-bottom-left', label: 'Mini bottom-left' }
]

function WindowModesFixture(): JSX.Element {
  const mode = useWindowMode()
  const [guide, setGuide] = useState(false)
  return (
    <SettingsCard title="Window modes" description="Drives the main window's modes and the guide wrapper for the hand checks.">
      <SettingsRow
        title="Mode"
        description={`Now: ${mode}`}
        control={
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' }}>
            {MODES.map((m) => (
              <button
                key={m.mode}
                type="button"
                className="n-btn n-btn--sm"
                aria-pressed={mode === m.mode}
                onClick={() => window.notula.window.setMode({ mode: m.mode, reason: 'user' })}
              >
                {m.label}
              </button>
            ))}
          </span>
        }
      />
      <SettingsRow
        title="Guide fixture"
        description="A two-step guide with a screenshot: Go mini, hover the thumbnail for the preview, close to go back to wide."
        control={
          <button type="button" className="n-btn n-btn--sm" onClick={() => setGuide(true)}>
            Open guide
          </button>
        }
      />
      {guide ? (
        <GuideDialog
          title="Sample guide"
          onClose={() => setGuide(false)}
          steps={[
            { text: 'Open the other app and find its settings page.', image: { src: guideSample, width: 1200, height: 750, alt: 'A sample settings page' } },
            { text: 'Turn on the option shown in blue, then come back to Notula.' }
          ]}
        />
      ) : null}
    </SettingsCard>
  )
}

function Crash(): JSX.Element {
  throw new Error('Developer tools: simulated render error')
}

export function DevSection(): JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [crash, setCrash] = useState(false)
  const update = useUpdateState()

  useEffect(() => {
    void window.notula.app.info().then(setInfo).catch(() => undefined)
  }, [])

  const feed = update ? (update.feed === 'none' ? 'None (checks are off)' : 'Configured at build time') : '…'
  const download = update?.download
  const updateText = !download
    ? '…'
    : download.state === 'idle'
      ? update?.lastCheck
        ? `Last checked ${new Date(update.lastCheck.at).toLocaleTimeString()}`
        : 'Not checked yet'
      : download.state === 'downloading'
        ? `Downloading v${download.version} (${download.percent}%)`
        : `v${download.version} downloaded${update?.installBlockedReason ? `, waiting (${update.installBlockedReason})` : ''}`


  return (
    <>
      {/* No local-only switch here: the one in Preferences replaces it. */}
      <WindowModesFixture />
      <SettingsCard title="Build">
        <SettingsRow title="Version" description={info ? `Notula ${info.version} on ${info.platform}` : '…'} />
        <SettingsRow title="Update feed" description={feed} />
        <SettingsRow title="Update state" description={updateText} />
      </SettingsCard>
      <SettingsCard title="Crash screen" description="Throws during render, so the crash screen and its Restart button can be checked.">
        <SettingsRow
          title="Simulate a render error"
          control={
            <button type="button" className="n-btn n-btn--sm" onClick={() => setCrash(true)}>
              Crash
            </button>
          }
        />
      </SettingsCard>
      {crash ? <Crash /> : null}
    </>
  )
}
