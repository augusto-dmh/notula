// SPDX-License-Identifier: Apache-2.0
// General Preferences rows:
// - "Chat Enter key behavior" (`chat.enterBehavior`): with `newline`, Enter inserts a line
//   and Mod+Enter sends (the chat composer reads the key).
// - The closing "More" group, whose Labs row opens Settings ▸ Labs. It carries the one-time
//   `labs` tip; opening Labs from anywhere ends that tip (NuxHost).

import { useId, type JSX } from 'react'
import { navigateToSettings } from '../../app/navigation'
import { Group, Row, Select } from '../settings/controls'
import { IconChevronDown } from '../settings/icons'
import { usePrefs, setPrefs } from '../settings/prefs-store'
import { NuxTip } from '../nux'
import './general-prefs.css'

export function ChatEnterBehaviorView(): JSX.Element | null {
  const prefs = usePrefs()
  const id = useId()
  if (!prefs) return null
  return (
    <Group title="Chat">
      <Row label="Chat Enter key behavior" hint="Choose whether Enter sends your message or starts a new line." htmlFor={id}>
        <Select<'send' | 'newline'>
          id={id}
          value={prefs['chat.enterBehavior']}
          options={[
            { value: 'send', label: 'Send message' },
            { value: 'newline', label: 'New line' }
          ]}
          onChange={(v) => setPrefs({ 'chat.enterBehavior': v })}
        />
      </Row>
    </Group>
  )
}

export function LabsMoreView(): JSX.Element {
  return (
    <Group title="More">
      <button type="button" className="gp-link-row" onClick={() => navigateToSettings('labs')}>
        <span className="gp-link-row__text">
          <span className="settings-row__label">Labs</span>
          <span className="settings-row__hint">Try features that work but are still changing.</span>
        </span>
        <IconChevronDown size={16} className="gp-link-row__chevron" />
      </button>
      <NuxTip id="labs" />
    </Group>
  )
}
