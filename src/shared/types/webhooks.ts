// SPDX-License-Identifier: Apache-2.0
// Signed webhooks. The URL and the signing secret are
// secrets: only `webhooks:create` and `webhooks:rotate-secret` return the secret, once.

import type { IsoTime } from './common'
import type { IntegrationDeliveryStatus } from './integrations'

export type WebhookEvent = 'note.summarized' | 'note.updated' | 'note.access_added'

export interface WebhookEndpoint {
  id: string
  url_label: string
  scope: 'my_notes_only' | 'one_folder'
  folder_id: string | null
  events: WebhookEvent[]
  enabled: boolean
  disabled_reason: null | 'user' | 'gone' | 'failures'
  include_transcript: boolean
  last_delivery: { status: IntegrationDeliveryStatus; at: IsoTime; httpStatus: number | null } | null
  created_at: IsoTime
  updated_at: IsoTime
}

export interface WebhookEndpointInput {
  url: string
  scope: 'my_notes_only' | 'one_folder'
  folderId?: string | null
  events: WebhookEvent[]
  includeTranscript: boolean
}

export interface WebhookTestResult {
  ok: boolean
  httpStatusCode: number | null
  errorMessage: string | null
}

export const WEBHOOK_LIMITS = {
  maxEndpoints: 20,
  bodyMaxBytes: 5_242_880,
  editCoalesceMs: 60_000,
  editMinGapMs: 300_000,
  timeoutMs: 20_000,
  autoDisableFailures: 20,
  autoDisableMs: 259_200_000,
  secretBytes: 32
} as const

export const WEBHOOK_SECRET_PREFIX = 'whsec_'
export const WEBHOOK_HEADERS = ['webhook-id', 'webhook-timestamp', 'webhook-signature'] as const
