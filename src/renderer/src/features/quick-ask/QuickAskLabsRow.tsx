// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Labs ▸ Quick ask: the switch for
// `quickAsk.enabled`, the shortcut in effect, and the line main reports when the shortcut
// could not be registered ("Ctrl+Alt+Space is used by another app.").

import { useEffect, useState, type JSX } from 'react'
import type { QuickAskStatus } from '@shared/types/chat'
import { navigateToSettings } from '../../app/navigation'
import { isMac } from '../../app/platform'
import { SettingsRow } from '../settings/primitives'
import { Switch } from '../settings/controls'
import { setPrefs, usePrefs } from '../settings/prefs-store'

/** An Electron accelerator as the keys a person presses. */
export function keysOf(accelerator: string): string[] {
  return accelerator
    .split('+')
    .map((k) =>
      k === 'CommandOrControl' || k === 'CmdOrCtrl' ? (isMac ? '⌘' : 'Ctrl') : k === 'Control' ? 'Ctrl' : k === 'Command' || k === 'Cmd' ? '⌘' : k === 'Alt' && isMac ? '⌥' : k
    )
}

export function QuickAskLabsRowView(): JSX.Element {
  const prefs = usePrefs()
  const enabled = prefs?.['quickAsk.enabled'] ?? false
  const [status, setStatus] = useState<QuickAskStatus | null>(null)

  // Main registers on the settings change; read the outcome once it has had a moment.
  useEffect(() => {
    let live = true
    const read = (): void => {
      void window.notula.quickAsk
        .getStatus()
        .then((s) => live && setStatus(s))
        .catch(() => live && setStatus(null))
    }
    read()
    const timer = setTimeout(read, 300)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [enabled, prefs?.['shortcuts.quickAsk']])

  const keys = keysOf(status?.accelerator ?? (isMac ? 'Alt+Space' : 'Control+Alt+Space'))
  const failed = enabled && status && !status.registered ? status.error : null
  return (
    <>
      <SettingsRow
        title="Quick ask"
        description={`Press ${keys.join('+')} anywhere to ask Notula about your notes.`}
        control={
          <Switch checked={enabled} disabled={!prefs} label="Quick ask" onChange={(on) => setPrefs({ 'quickAsk.enabled': on })} />
        }
      />
      {failed ? (
        <p className="quick-ask-labs__error" role="status">
          {failed}{' '}
          <button type="button" className="quick-ask-labs__link" onClick={() => navigateToSettings('keyboard-shortcuts')}>
            Choose another shortcut
          </button>
        </p>
      ) : null}
    </>
  )
}
