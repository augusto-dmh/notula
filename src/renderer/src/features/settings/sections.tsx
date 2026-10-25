// SPDX-License-Identifier: Apache-2.0
// The Settings pages Notula ships, in sidebar order:
// Preferences, AI, Profile, Calendar (once calendar sync ships), Notifications, and
// Developer tools in development builds only. No item ever opens an empty page.
//
// Keyboard shortcuts come after Preferences; Speaker tags, Voice typing (while
// `voiceTyping.enabled`), Integrations, Connectors and Labs after Notifications; then
// Troubleshooting before Developer tools. Troubleshooting sits under a "Get help"
// heading, followed by About, and Voice typing carries a `Beta` badge.

import type { JSX } from 'react'
import type { Settings, SettingsSection } from '@shared/types/settings'
import { IconBell, IconCalendar, IconCode, IconInfo, IconUser } from '../../app/icons'
import { isMac } from '../../app/platform'
import { useUpdateState } from '../../app/update-store'
import { calendarEnabled } from '../calendar'
import { IconFlask, IconKeyboard, IconLifebuoy, IconMic, IconNodes, IconPlay, IconPlug, IconSliders, IconSparkles, IconUsers } from './icons'
import { usePrefs } from './prefs-store'

export interface SettingsSectionMeta {
  id: SettingsSection
  label: string
  title: string
  description: string
  icon: (size: number) => JSX.Element
  /** Listed under a group heading in the sidebar. */
  group?: 'help'
  /** A small badge after the label. */
  badge?: string
  /** A sub-page reached from another page, never listed in the sidebar. */
  hidden?: boolean
}

const ALL: readonly SettingsSectionMeta[] = [
  {
    id: 'preferences',
    label: 'Preferences',
    title: 'Preferences',
    description: 'How Notula starts, looks and listens.',
    icon: (s) => <IconSliders size={s} />
  },
  {
    id: 'keyboard-shortcuts',
    label: 'Keyboard shortcuts',
    title: 'Keyboard shortcuts',
    description: 'Shortcuts available in Notula.',
    icon: (s) => <IconKeyboard size={s} />
  },
  {
    id: 'ai',
    label: 'AI',
    title: 'AI',
    description:
      'Choose who transcribes your meetings and who writes your notes. Keys stay in this computer’s secure storage.',
    icon: (s) => <IconSparkles size={s} />
  },
  {
    id: 'profile',
    label: 'Profile',
    title: 'Profile',
    description: 'A little about you, so enhanced notes read the way you would write them.',
    icon: (s) => <IconUser size={s} />
  },
  {
    id: 'calendar',
    label: 'Calendar',
    title: 'Calendar',
    description: 'The calendars Notula reads your meetings from.',
    icon: (s) => <IconCalendar size={s} />
  },
  {
    id: 'notifications',
    label: 'Notifications',
    title: 'Notifications',
    description: 'When Notula offers to take notes for a meeting.',
    icon: (s) => <IconBell size={s} />
  },
  {
    id: 'speaker-tags',
    label: 'Speaker tags',
    title: 'Speaker tags',
    description: 'Show who said what in your transcripts.',
    icon: (s) => <IconUsers size={s} />
  },
  {
    id: 'voice-typing',
    label: 'Voice typing',
    title: 'Voice typing',
    description: 'Dictate into any app with a keyboard shortcut.',
    icon: (s) => <IconMic size={s} />,
    badge: 'Beta'
  },
  {
    id: 'integrations',
    label: 'Integrations',
    title: 'Integrations',
    description: 'Send notes to the tools you use, with your own accounts.',
    icon: (s) => <IconPlug size={s} />
  },
  // After Integrations, while `automations.enabled`.
  {
    id: 'automations',
    label: 'Automations',
    title: 'Automations',
    description: 'File notes into folders or send them to a webhook when a meeting ends.',
    icon: (s) => <IconSliders size={s} />
  },
  {
    id: 'connectors',
    label: 'Connectors',
    title: 'Connectors',
    description: 'MCP servers for chat, and Notula’s own MCP server for your other AI apps.',
    icon: (s) => <IconNodes size={s} />
  },
  {
    id: 'labs',
    label: 'Labs',
    title: 'Labs',
    description: 'Try features that are still taking shape. They’re off until you turn them on.',
    icon: (s) => <IconFlask size={s} />
  },
  // While `sources.enabled` is on, on Windows.
  {
    id: 'sources',
    label: 'Sources',
    title: 'Sources',
    description: 'Notes linked to the videos and lessons you watch in your browser.',
    icon: (s) => <IconPlay size={s} />
  },
  // In the "Get help" group, above Troubleshooting.
  {
    id: 'feedback',
    label: 'Feedback',
    title: 'Feedback',
    description: 'Report a problem, ask a question or suggest an idea. You can attach screenshots or a screen recording.',
    icon: (s) => <IconLifebuoy size={s} />,
    group: 'help'
  },
  {
    id: 'troubleshooting',
    label: 'Troubleshooting',
    title: 'Troubleshooting',
    description: 'Fix common problems and collect diagnostics.',
    icon: (s) => <IconLifebuoy size={s} />,
    group: 'help'
  },
  {
    id: 'about',
    label: 'About',
    title: 'About',
    description: 'Notula’s version and license, and the open-source software it includes.',
    icon: (s) => <IconInfo size={s} />,
    group: 'help'
  },
  {
    id: 'dev',
    label: 'Developer tools',
    title: 'Developer tools',
    description: 'Local diagnostics for development builds. Nothing here is ever sent anywhere.',
    icon: (s) => <IconCode size={s} />
  },
  // Hidden sub-pages
  {
    id: 'meeting-notice',
    label: 'Meeting notice',
    title: 'Notice in meeting chat',
    description: 'The short notice Notula posts in the meeting chat when you start taking notes.',
    icon: (s) => <IconUsers size={s} />,
    hidden: true
  },
  {
    id: 'transcription-rules',
    label: 'Transcription rules',
    title: 'Transcription rules',
    description: 'Ask, warn or block before Notula takes notes in meetings you choose.',
    icon: (s) => <IconMic size={s} />,
    hidden: true
  },
  {
    id: 'voice-typing-history',
    label: 'Voice typing history',
    title: 'History',
    description: 'Your recent dictations. Copy one, delete it or retry one that failed.',
    icon: (s) => <IconMic size={s} />,
    hidden: true
  }
]

/**
 * The shipped sections; `packaged` null (unknown yet) hides Developer tools. Voice typing
 * shows only while its Labs switch is on (`prefs` null = not loaded yet: hidden).
 */
export function settingsSections(packaged: boolean | null, prefs: Settings | null = null): SettingsSectionMeta[] {
  return ALL.filter((s) => {
    if (s.id === 'calendar') return calendarEnabled()
    if (s.id === 'dev') return packaged === false
    if (s.id === 'voice-typing' || s.id === 'voice-typing-history') return prefs?.['voiceTyping.enabled'] === true
    if (s.id === 'automations') return prefs?.['automations.enabled'] === true
    if (s.id === 'sources') return !isMac && prefs?.['sources.enabled'] === true
    return true
  })
}

export function useSettingsSections(): SettingsSectionMeta[] {
  const update = useUpdateState()
  const prefs = usePrefs()
  return settingsSections(update ? update.packaged : null, prefs)
}
