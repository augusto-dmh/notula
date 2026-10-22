// SPDX-License-Identifier: Apache-2.0
// The app shell: updater state, deep links and launch tasks.

import type { IsoTime } from './common'
import type { CalendarEvent, CreationOrigin } from './notes'
import type { SettingsSection } from './settings'

/** Sent by a renderer while work is in progress that an install would cut short. */
export type UpdateDelayReason = 'chatActive' | 'dictationActive'

/** Why a downloaded update is not installed yet (without rule 2). */
export type UpdateBlockReason = 'capturing' | 'focused' | 'viewing-meeting' | UpdateDelayReason

export interface UpdateState {
  /** `none`: no build-time feed URL, a dev build, or an unsigned macOS build. */
  feed: 'none' | 'configured'
  packaged: boolean
  /** `UpdatesDisabled` set by machine policy. */
  policyDisabled: boolean
  checking: boolean
  lastCheck: { at: IsoTime; available: boolean; version: string | null } | null
  download:
    | { state: 'idle' }
    | { state: 'downloading'; version: string; percent: number }
    | { state: 'downloaded'; version: string }
  installing: boolean
  installBlockedReason: UpdateBlockReason | null
  error: string | null
  /** The release channel the updater follows. */
  channel: UpdateChannel
  betaAvailable: boolean
  pausedByLocalOnly: boolean
}

export type UpdateChannel = 'stable' | 'beta'

/** A parsed `notula://` link, delivered on `deeplink:received`. */
export type DeepLinkEvent =
  | { type: 'open'; data: { path: string } }
  | {
      type: 'new-note'
      /** `event`: the link's event id resolved in main through `ctx.calendar.getEvent`. */
      data: { creationSource: CreationOrigin; autoTranscribe: boolean; event: CalendarEvent | null }
    }
  | {
      type: 'show-note'
      /** `openSource` is set by the bubble and notification windows too. */
      data: { documentId: string; openSource?: 'deep_link' | 'bubble_open_document' | 'notification' }
    }
  | { type: 'show-settings'; data: { page: SettingsSection } }

/** A link Notula could not act on (the shell's "can't open this link" toast). */
export interface DeepLinkUnsupported {
  url: string
  reason: string
}

/**
 * Windows jump-list and macOS dock tasks, passed as `--notula-task=<task>`.
 * `background` starts in the tray without a window (the MCP shim).
 */
export type AppTask = 'settings' | 'restart' | 'quit' | 'quit-completely' | 'background'

/** The app id (electron-builder `appId`): the Windows AppUserModelID and the macOS bundle id. */
export const APP_ID = 'com.notula.app'
export const DEEP_LINK_SCHEME = 'notula'
export const DEEP_LINK_SCHEME_DEV = 'notula-dev'
export const APP_TASK_ARG_PREFIX = '--notula-task='
/** The host allow-list. */
export const DEEP_LINK_HOSTS = ['open', 'new-note', 'show-note', 'show-settings'] as const
