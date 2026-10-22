// SPDX-License-Identifier: Apache-2.0
// The Labs row for snapshots of shared screens. Turning it on asks for
// a one-time confirmation into `screenSnapshots.confirmedAt`, disabled with "Needs an AI model that
// accepts images." when the selected model takes none (or local-only mode blocks a cloud provider).
// On macOS it also offers the screen-recording guide and, after the grant, a restart when a test
// capture still finds nothing.

import { useCallback, useEffect, useState, type JSX } from 'react'
import { isMac } from '../../app/platform'
import { setPrefs, usePrefs } from '../calendar/store'
import { Switch } from '../settings/controls'

type Permission = 'unknown' | 'granted' | 'missing' | 'restart'

export function LabsRow(): JSX.Element | null {
  const prefs = usePrefs()
  const [available, setAvailable] = useState<boolean | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [permission, setPermission] = useState<Permission>('unknown')
  const provider = prefs?.['llm.provider']
  const model = prefs ? JSON.stringify([prefs['llm.provider'], prefs['privacy.localOnly'], prefs['llm.openai.acceptsImages'], prefs['llm.local.acceptsImages']]) : ''
  const enabled = prefs?.['screenSnapshots.enabled'] === true

  useEffect(() => {
    if (!prefs) return
    let alive = true
    void window.notula.screenSnapshots
      .getState({ noteId: '' })
      .then((s) => alive && setAvailable(s.state !== 'disabled'))
      .catch(() => alive && setAvailable(false))
    return () => {
      alive = false
    }
    // Re-checked when the provider, the model's image flag or local-only mode changes.
  }, [model])

  const checkPermission = useCallback(async (afterGuide: boolean): Promise<void> => {
    if (!isMac) return
    try {
      const c = await window.notula.permissions.checkSystemAudio()
      if (c.screenCapture !== 'authorized') {
        setPermission('missing')
        return
      }
      if (afterGuide) {
        // One capture test after the grant; still nothing means a relaunch is needed.
        const sources = await window.notula.screenSnapshots.listSources()
        setPermission(sources.length === 0 ? 'restart' : 'granted')
      } else setPermission('granted')
    } catch {
      setPermission('unknown')
    }
  }, [])

  useEffect(() => {
    if (!isMac || !enabled) return
    void checkPermission(false)
    return window.notula.screenGuide.onClosed(() => void checkPermission(true))
  }, [enabled, checkPermission])

  if (!prefs) return null
  const localBlocked = prefs['privacy.localOnly'] === true && provider !== 'local'
  const blocked = available === false
  const hint = blocked
    ? localBlocked
      ? 'Turned off while nothing leaves this machine. Choose a local model to use it.'
      : 'Needs an AI model that accepts images.'
    : 'While someone shares their screen, keep snapshots of the window you pick in the meeting’s notes.'

  const onChange = (next: boolean): void => {
    if (!next) {
      setConfirming(false)
      setPrefs({ 'screenSnapshots.enabled': false })
      return
    }
    if (!prefs['screenSnapshots.confirmedAt']) {
      setConfirming(true)
      return
    }
    setPrefs({ 'screenSnapshots.enabled': true })
  }

  return (
    <div className="snap-labs">
      <div className="settings-row">
        <div className="settings-row__text">
          <div className="settings-row__label">Snapshots of shared screens</div>
          <div className={`settings-row__hint${blocked ? ' snap-labs__blocked' : ''}`}>{hint}</div>
        </div>
        <div className="settings-row__control">
          <Switch label="Snapshots of shared screens" checked={enabled} disabled={(blocked && !enabled) || available === null} onChange={onChange} />
        </div>
      </div>
      {confirming ? (
        <div className="snap-labs__confirm" role="dialog" aria-label="Turn on screen snapshots">
          <p>
            Snapshots of the window you pick are sent to your AI provider to decide which ones to keep. Only the kept snapshots are stored,
            encrypted, on this computer.
          </p>
          <div className="snap-labs__actions">
            <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="n-btn n-btn--sm n-btn--primary"
              onClick={() => {
                setConfirming(false)
                setPrefs({ 'screenSnapshots.enabled': true, 'screenSnapshots.confirmedAt': new Date().toISOString() })
              }}
            >
              Turn on
            </button>
          </div>
        </div>
      ) : null}
      {isMac && enabled && permission === 'missing' ? (
        <div className="snap-labs__banner">
          <span>Allow screen recording to take snapshots</span>
          <button type="button" className="n-btn n-btn--sm" onClick={() => window.notula.screenGuide.open()}>
            Open settings
          </button>
        </div>
      ) : null}
      {isMac && enabled && permission === 'restart' ? (
        <div className="snap-labs__banner">
          <span>Restart Notula to finish turning on screen recording.</span>
          <button type="button" className="n-btn n-btn--sm n-btn--primary" onClick={() => void window.notula.app.relaunch()}>
            Restart
          </button>
        </div>
      ) : null}
    </div>
  )
}
