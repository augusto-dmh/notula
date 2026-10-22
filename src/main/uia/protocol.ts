// SPDX-License-Identifier: Apache-2.0
// The main ↔ notula-uia messages (internal to speaker attribution). Types only, so
// the worker and main share them without runtime code.

import type { AttributionApp } from '@shared/types/transcript'

export interface UiaReaderArgs {
  /** `resources/uia/attribution.ps1`, resolved by main (the worker has no `app`). */
  scriptPath: string
  intervalMs: number
  /** base64 UTF-8 JSON of the app's selectors (Meet: `MeetSelectors`). */
  selectorsB64: string
  /** base64 UTF-8 of the user's display name (`profile.name`). */
  selfNameB64: string
}

export type MainToUia =
  | { type: 'start'; app: AttributionApp; args: UiaReaderArgs }
  | { type: 'stop'; app: AttributionApp }

/** A reader's lifecycle as the worker sees it. */
export type UiaReaderState = 'running' | 'restarting' | 'failed' | 'unavailable' | 'stopped'

export type UiaToMain =
  /** One parsed JSON line of the reader (the attribution.ps1 record shapes, plus `uia-unavailable`). */
  | { type: 'record'; app: AttributionApp; record: Record<string, unknown> }
  | { type: 'state'; app: AttributionApp; state: UiaReaderState; detail: string | null; pid: number | null }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; event: string; data?: Record<string, unknown> }
