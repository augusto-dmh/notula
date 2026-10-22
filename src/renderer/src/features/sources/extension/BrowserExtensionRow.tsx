// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Sources ▸ Browser extension: the switch (`ext-bridge:set-enabled`), per-browser
// connection status and version, Repair, and the extension's switches (private windows, captions,
// course pages). Turning the switch on writes Notula's helper files and two browser registry
// entries; turning it off removes them. The extension is optional: everything else on this page
// works without it.

import { useEffect, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import type { ExtBridgeState, ExtBridgeStatus } from '@shared/types/extension-protocol'
import { SettingsCard, SettingsRow } from '../../settings'
import { StatusLine, Switch, type Status } from '../../settings/controls'
import { setPrefs, usePrefs } from '../../settings/prefs-store'
import { debugLog } from '../../../app/platform'
import { isMissingHandler } from '../note/source-store'

const STORE_LABEL = { cws: 'Chrome Web Store', edge: 'Edge Add-ons', dev: 'development build' } as const

function stateLine(s: ExtBridgeStatus | null, unavailable: boolean): string {
  if (unavailable) return 'The browser extension isn’t available in this build yet.'
  if (!s) return 'Checking…'
  if (!s.supported) return 'Available on Windows only.'
  const states: Record<ExtBridgeState, string> = {
    off: 'Off. Notula reads what plays from Windows instead. Turn this on to use the Notula extension for Chrome or Edge: exact links, times and course details.',
    'not-installed': 'Ready. Install the Notula extension in Chrome or Edge, then play a video.',
    waiting: 'Ready. The extension connects when a video plays.',
    connected: 'Connected.',
    'extension-outdated': 'The extension is out of date. Your browser updates it on its own; you can also update it from the extensions page.',
    'host-failed': 'The browser can’t reach Notula’s helper. Repair rewrites it.',
    'host-blocked': 'Your computer’s policy blocks the helper the browser starts.'
  }
  return states[s.state]
}

function browserLine(b: ExtBridgeStatus['browsers'][number]): string {
  const version = b.extVersion ? ` · extension ${b.extVersion}${b.store ? ` (${STORE_LABEL[b.store]})` : ''}` : ''
  switch (b.state) {
    case 'connected':
      return `Connected${version}`
    case 'extension-outdated':
      return `Needs an update${version}`
    default:
      return `Not connected now${b.lastSeenAt ? `, last seen ${new Date(b.lastSeenAt).toLocaleString()}` : ''}${version}`
  }
}

export function BrowserExtensionRow(): JSX.Element | null {
  const prefs = usePrefs()
  const [status, setStatus] = useState<ExtBridgeStatus | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [busy, setBusy] = useState<'switch' | 'repair' | null>(null)
  const [message, setMessage] = useState<Status>(null)

  useEffect(() => {
    let alive = true
    void window.notula.extBridge
      .getStatus()
      .then((s) => alive && setStatus(s))
      .catch((err: unknown) => {
        debugLog('ext-bridge:status-failed', isMissingHandler(err) ? { missingHandler: true } : { code: parseError(err).code })
        if (alive) setUnavailable(true)
      })
    const off = window.notula.extBridge.onStatusChanged((s) => setStatus(s))
    return () => {
      alive = false
      off()
    }
  }, [])

  if (!prefs) return null
  const on = status?.enabled ?? prefs['sources.extension.enabled']

  async function toggle(next: boolean): Promise<void> {
    setBusy('switch')
    setMessage(null)
    try {
      setStatus(await window.notula.extBridge.setEnabled({ enabled: next }))
    } catch (err) {
      const p = parseError(err)
      setMessage({ kind: 'error', text: p.code === 'invalid-input' && p.message ? `${p.message}.` : 'Couldn’t change this setting. Try again.' })
    } finally {
      setBusy(null)
    }
  }

  async function repair(): Promise<void> {
    setBusy('repair')
    setMessage(null)
    try {
      setStatus(await window.notula.extBridge.repair())
      setMessage({ kind: 'ok', text: 'Repaired. Reload the extension’s tab or play the video again.' })
    } catch {
      setMessage({ kind: 'error', text: 'Couldn’t repair the helper. Try again.' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <SettingsCard
      title="Browser extension"
      description="Optional. The extension tells Notula exactly what plays in Chrome or Edge. It talks only to Notula on this computer, and Notula never sends it your notes."
    >
      <SettingsRow
        title="Use the browser extension"
        description={stateLine(status, unavailable)}
        control={
          <Switch
            label="Use the browser extension"
            checked={on}
            busy={busy === 'switch'}
            disabled={busy !== null || unavailable || status?.supported === false}
            onChange={(next) => void toggle(next)}
          />
        }
      />
      {on && status
        ? status.browsers.map((b) => <SettingsRow key={b.brand} title={b.brand} description={browserLine(b)} />)
        : null}
      {on ? (
        <SettingsRow
          title="Helper"
          description="Notula keeps a small helper the browser starts to reach it. If the extension says it can’t start Notula’s helper, repair it."
          control={
            <button type="button" className="n-btn n-btn--sm" disabled={busy !== null} onClick={() => void repair()}>
              {busy === 'repair' ? 'Repairing…' : 'Repair'}
            </button>
          }
        />
      ) : null}
      {on && status && status.adapterMisses.length ? (
        <p className="src-set__note">Course details partly missing on {status.adapterMisses.join(', ')}.</p>
      ) : null}
      {on ? (
        <>
          <SettingsRow
            title="Private windows"
            description="Read videos in InPrivate and Incognito windows. The extension’s own switch must be on too, and the browser must allow it there."
            control={
              <Switch
                label="Private windows"
                checked={prefs['sources.extension.allowIncognito']}
                onChange={(v) => setPrefs({ 'sources.extension.allowIncognito': v })}
              />
            }
          />
          <SettingsRow
            title="Captions from the player"
            description="Use the captions the video player has loaded, for the note’s video captions."
            control={
              <Switch
                label="Captions from the player"
                checked={prefs['sources.extension.captions']}
                onChange={(v) => setPrefs({ 'sources.extension.captions': v })}
              />
            }
          />
          <SettingsRow
            title="Course pages"
            description="Read the course, section and lesson number from course pages you turned on in the extension."
            control={
              <Switch
                label="Course pages"
                checked={prefs['sources.extension.coursePages']}
                onChange={(v) => setPrefs({ 'sources.extension.coursePages': v })}
              />
            }
          />
        </>
      ) : null}
      {message ? (
        <div className="src-set__status">
          <StatusLine status={message} />
        </div>
      ) : null}
    </SettingsCard>
  )
}
