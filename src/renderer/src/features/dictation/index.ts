// SPDX-License-Identifier: Apache-2.0
// Voice typing: the
// #/dictation-pill window, Settings ▸ Voice typing, the Labs row and the chat composer's
// voice button.

import { createElement, Fragment, type JSX } from 'react'
import { navigateToSettings } from '../../app/navigation'
import { Switch } from '../settings/controls'
import { SettingsRow } from '../settings/primitives'
import { setPrefs, usePrefs } from '../settings/prefs-store'
import { ChatVoiceButton } from './ChatVoice'
import { DictationBarMenuView } from './DictationBarMenu'
import { DictationPill } from './Pill'
import { VoiceTypingSettingsView } from './VoiceTypingSettings'

/** `#/dictation-pill`. */
export function DictationPillRoot(): JSX.Element {
  return createElement(DictationPill)
}

/** `#/dictation-bar-menu`: the bar menu overlay. */
export function DictationBarMenuRoot(): JSX.Element {
  return createElement(DictationBarMenuView)
}

/** Settings ▸ Voice typing (shown while `voiceTyping.enabled`). */
export function VoiceTypingSettings(): JSX.Element {
  return createElement(Fragment, null, createElement(VoiceTypingSettingsView))
}

/** Settings ▸ Labs: the custom voice-typing row (switch plus a link to its page). */
export function VoiceTypingLabsRow(): JSX.Element {
  const prefs = usePrefs()
  const on = prefs?.['voiceTyping.enabled'] ?? false
  return createElement(SettingsRow, {
    title: 'Voice typing',
    description: on ? 'Dictate into any app with a keyboard shortcut. Set it up in Settings ▸ Voice typing.' : 'Dictate into any app with a keyboard shortcut.',
    ...(on ? { onClick: () => navigateToSettings('voice-typing') } : {}),
    control: createElement(Switch, { checked: on, disabled: !prefs, label: 'Voice typing', onChange: (v: boolean) => setPrefs({ 'voiceTyping.enabled': v }) })
  })
}

/** The chat Composer's voice input (`dictation:chat-start`, `-stop`, `-cancel`); text goes in without formatting. */
export function ChatDictationButton(p: { onText(text: string): void; disabled?: boolean }): JSX.Element | null {
  return createElement(ChatVoiceButton, p)
}
