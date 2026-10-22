// SPDX-License-Identifier: Apache-2.0
// "Nothing leaves this machine" and the data-usage panel.

import type { IsoTime } from './common'
import type { LlmProviderId } from './enhance'
import type { AsrProviderId } from './transcript'

/** `sources`: content sources' lookups and the yt-dlp tool (Labs, Windows). */
export type DataUsageKind = 'llm' | 'asr' | 'integration' | 'calendar' | 'mcp' | 'updates' | 'sources'

export interface DataUsageDestination {
  kind: DataUsageKind
  name: string
  /** A host, or 'this computer'. */
  detail: string
  what: string
  active: boolean
}

export interface DataUsage {
  localOnly: boolean
  /** True once L merges. */
  localOnlySwitchAvailable: boolean
  destinations: DataUsageDestination[]
}

export type LocalOnlyWarning = 'no-local-asr' | 'no-local-llm' | 'local-llm-not-loopback'

export interface LocalOnlyStatus {
  enabled: boolean
  changedAt: IsoTime | null
  heldSends: number
  warnings: LocalOnlyWarning[]
  activeServices: { kind: DataUsageKind | 'local-server' | 'model-download'; name: string }[]
  previousProviders: { asr: AsrProviderId; llm: LlmProviderId } | null
}

export type LocalOnlyRefusal = 'cloud-transcription-active' | 'not-verified'

/** Shared lines; each feature adds its own where it needs one. */
export const LOCAL_ONLY_COPY = {
  blocked: 'Off while Nothing leaves this machine is on.',
  badge: 'Local only',
  tooltip: 'Nothing leaves this machine is on',
  llmNotLoopback: 'Your local AI model must run on this computer.',
  paused: 'Paused while Nothing leaves this machine is on'
} as const
