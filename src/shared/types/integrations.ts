// SPDX-License-Identifier: Apache-2.0
// Slack, Notion, HubSpot, Attio, Affinity and Zapier with the user's own credentials.
// Notula has no server, so main calls each provider's public API directly. Credentials,
// webhook URLs and hook URLs stay in main as secrets: the renderer sees masked values only.

import type { IsoTime } from './common'

export type IntegrationProvider =
  | 'slack'
  | 'notion'
  | 'hubspot'
  | 'attio'
  | 'affinity'
  | 'zapier'
  // Served through the plug-in registry
  | 'salesforce'
  | 'pipedrive'
  | 'ashby'
  | 'dropbox'
  | 'webhook'
  | 'gmail'
  | 'outlook'

export type IntegrationState = 'not_configured' | 'checking' | 'connected' | 'invalid' | 'unreachable'

export interface IntegrationStatus {
  provider: IntegrationProvider
  state: IntegrationState
  accountLabel: string | null
  /** `••••` + the last 4 characters. */
  maskedCredential: string | null
  lastValidatedAt: IsoTime | null
  detail: string | null
  blockedByLocalOnly: boolean
}

export type IntegrationCredentialKind =
  | 'slack-bot-token'
  | 'notion-token'
  | 'hubspot-token'
  | 'attio-token'
  | 'affinity-key'
  // Plug-in providers
  | 'oauth-client'
  | 'pipedrive-token'
  | 'ashby-key'

/** `integrations:set-credential`: sent once; the value never comes back. */
export interface IntegrationCredentialInput {
  provider: IntegrationProvider
  kind: IntegrationCredentialKind
  value: string
  /** The Salesforce URL, the Pipedrive company. */
  label?: string
}

export type IntegrationDestinationKind = 'slack-channel' | 'slack-webhook' | 'notion-target' | 'zapier-hook'

export interface IntegrationDestinationOptions {
  notionTargetType?: 'data_source' | 'page'
  notionTitleProperty?: string
  notionDateProperty?: string | null
  notionUrl?: string
  slackIsPrivate?: boolean
  zapierIncludeTranscript?: boolean
}

export interface IntegrationDestination {
  id: string
  provider: IntegrationProvider
  kind: IntegrationDestinationKind
  label: string
  externalId: string | null
  trigger: 'share' | 'folder' | null
  status: 'ok' | 'disconnected' | 'disabled'
  lastError: string | null
  options: IntegrationDestinationOptions
  maskedSecret: string | null
  createdAt: IsoTime
  updatedAt: IsoTime
}

export interface IntegrationDestinationInput {
  id?: string
  provider: IntegrationProvider
  kind: IntegrationDestinationKind
  label: string
  externalId?: string | null
  trigger?: 'share' | 'folder' | null
  /** A webhook or hook URL; stored as a secret. */
  secretValue?: string
  options?: IntegrationDestinationOptions
}

export type IntegrationResultKind =
  | 'channel'
  | 'data_source'
  | 'page'
  | 'contact'
  | 'company'
  | 'deal'
  | 'people'
  | 'companies'
  | 'deals'
  | 'person'
  | 'organization'
  // Plug-in providers
  | 'lead'
  | 'account'
  | 'opportunity'
  | 'candidate'

export interface IntegrationSearchQuery {
  provider: IntegrationProvider
  query?: string
  noteId?: string
  kinds?: IntegrationResultKind[]
}

export interface IntegrationSearchResult {
  provider: IntegrationProvider
  kind: IntegrationResultKind
  id: string
  label: string
  subtitle: string | null
  suggested: boolean
  extra?: Record<string, string | number | boolean | null>
}

export interface IntegrationTarget {
  kind: IntegrationResultKind
  id: string
  label: string
}

/** The selected panel as the renderer serialized it (never trusted as a path or URL). */
export interface IntegrationShareContent {
  html: string
  text: string
  markdown: string
}

export interface IntegrationShareRequest {
  provider: IntegrationProvider
  noteId: string
  panelId: string | null
  destinationIds?: string[]
  targets?: IntegrationTarget[]
  content?: IntegrationShareContent
  delayMs?: number
  newCopy?: boolean
}

export type AttioObjectType = 'companies' | 'people' | 'deals'

export interface IntegrationAutomation {
  id: string
  provider: IntegrationProvider
  folderId: string
  destinationId: string | null
  options: { objectTypes?: AttioObjectType[] }
  enabled: boolean
  createdAt: IsoTime
  updatedAt: IsoTime
}

export interface IntegrationAutomationInput {
  folderId: string
  provider: IntegrationProvider
  destinationId?: string | null
  options?: IntegrationAutomation['options']
  enabled: boolean
}

export type IntegrationDeliveryStatus = 'scheduled' | 'pending' | 'sending' | 'sent' | 'failed' | 'uncertain' | 'cancelled'

export interface IntegrationDelivery {
  id: string
  provider: IntegrationProvider
  destinationId: string | null
  automationId: string | null
  noteId: string
  noteTitle: string | null
  panelId: string | null
  targetKey: string
  trigger: 'manual' | 'folder' | 'test'
  status: IntegrationDeliveryStatus
  attempts: number
  nextAttemptAt: IsoTime | null
  externalId: string | null
  externalUrl: string | null
  errorCode: string | null
  errorMessage: string | null
  sentAt: IsoTime | null
  createdAt: IsoTime
  updatedAt: IsoTime
}

export const INTEGRATION_POLICY = {
  timeoutMs: 20_000,
  maxRetries: 3,
  backoffMs: [1_000, 2_000, 4_000],
  jitter: 0.2,
  retryAfterCapMs: 60_000,
  scheduleRetriesMs: [60_000, 300_000, 1_800_000, 7_200_000],
  catchUpMs: 7 * 86_400_000,
  tickMs: 60_000,
  validateStaleMs: 86_400_000,
  undoMs: { attio: 3_000, zapier: 10_000 },
  recentDeliveries: 20
} as const

export const NOTION_VERSION = '2026-03-11'
export const SLACK_WEBHOOK_PREFIX = 'https://hooks.slack.com/services/'
export const ZAPIER_HOOK_PREFIX = 'https://hooks.zapier.com/'

// ---------- Salesforce, Pipedrive, Ashby and Dropbox ----------

/** Salesforce options (no custom objects). */
export interface SalesforceOptions {
  eventHandling: 'none' | 'create_new' | 'match_else_create'
  eventBodySource: 'meeting_summary' | 'event_description'
  eventWhatId: 'opportunity' | 'account' | 'none'
  contentNoteEnabled: boolean
}

export const SALESFORCE = {
  callbackPort: 47_615,
  callbackPath: '/salesforce/callback',
  minApiVersion: 58,
  ratePerSec: 5,
  oauthTimeoutMs: 300_000
} as const
export const PIPEDRIVE = { ratePerSec: 5 } as const
export const DROPBOX = { callbackPort: 47_616, callbackPath: '/dropbox/callback' } as const

export const INTEGRATION_RESULT_KINDS_PLUS = [
  'contact',
  'lead',
  'account',
  'opportunity',
  'person',
  'organization',
  'deal',
  'candidate'
] as const
