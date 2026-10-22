// SPDX-License-Identifier: Apache-2.0
// Labs ▸ Beta program ▸ Join the beta: a switch over
// `updates.channel`, changed only through `update:set-channel` (main validates it).
// - Joining asks first ("Are you sure?"); "Sign me up!" sets `beta`.
// - Leaving explains that Notula keeps this beta until a newer stable version is out; its OK
//   sets `stable`.
// - A refused or failed change toasts "Couldn’t save release channel" and the switch stays.
// - Disabled when this build has no beta feed or checks no feed at all.

import { useState, type JSX } from 'react'
import type { UpdateChannel } from '@shared/types/app'
import { useUpdateState } from '../../app/update-store'
import { showToast } from '../../app/toast'
import { Modal } from '../folders/Modal'
import { Switch } from '../settings/controls'
import { usePrefs } from '../settings/prefs-store'
import './release-channel.css'

export function BetaRow(): JSX.Element | null {
  const prefs = usePrefs()
  const update = useUpdateState()
  const [dialog, setDialog] = useState<'join' | 'leave' | null>(null)
  const [busy, setBusy] = useState(false)
  if (!prefs) return null

  const channel = prefs['updates.channel']
  const available = !!update && update.betaAvailable && update.feed !== 'none'

  const apply = async (next: UpdateChannel): Promise<void> => {
    setBusy(true)
    try {
      const res = await window.notula.update.setChannel({ channel: next })
      if (!res.ok) throw new Error(res.reason ?? 'refused')
      showToast(next === 'beta' ? { kind: 'success', title: 'You’ll get Notula beta updates from now on.' } : { kind: 'success', title: 'Beta turned off' })
    } catch {
      showToast({ kind: 'error', title: 'Couldn’t change your beta setting. Try again.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-row">
      <div className="settings-row__text">
        <div className="settings-row__label">
          Join the beta
          {channel === 'beta' ? <span className="rc-badge">Beta</span> : null}
        </div>
        <div className="settings-row__hint">
          {available ? 'Try new features early and help catch problems.' : 'Beta updates aren’t available in this build'}
          {available && update?.pausedByLocalOnly ? ' Updates are paused while Nothing leaves this machine is on; your choice applies when they resume.' : ''}
        </div>
      </div>
      <div className="settings-row__control">
        <Switch
          label="Join the beta"
          checked={channel === 'beta'}
          disabled={(!available && channel !== 'beta') || busy}
          busy={busy}
          onChange={(next) => setDialog(next ? 'join' : 'leave')}
        />
      </div>
      {dialog === 'join' ? (
        <Modal label="Are you sure?" className="rc-modal" onClose={() => setDialog(null)}>
          <div className="h-modal__body">
            <h2 className="h-modal__title">Are you sure?</h2>
            <p className="rc-modal__text">
              Beta versions get new features first, but they can be less stable. You can leave the beta at any time in Settings.
            </p>
            <div className="h-modal__footer">
              <button type="button" className="n-btn" data-autofocus onClick={() => setDialog(null)}>
                Go back
              </button>
              <button
                type="button"
                className="n-btn n-btn--primary"
                onClick={() => {
                  setDialog(null)
                  void apply('beta')
                }}
              >
                Join the beta
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
      {dialog === 'leave' ? (
        <Modal
          label="Leaving beta"
          className="rc-modal"
          onClose={() => {
            setDialog(null)
            void apply('stable')
          }}
        >
          <div className="h-modal__body">
            <h2 className="h-modal__title">Leaving beta</h2>
            <p className="rc-modal__text">You’ll get stable releases from now on. Notula keeps this beta version until a newer stable version is out.</p>
            <div className="h-modal__footer">
              <button
                type="button"
                className="n-btn n-btn--primary"
                data-autofocus
                onClick={() => {
                  setDialog(null)
                  void apply('stable')
                }}
              >
                OK
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
