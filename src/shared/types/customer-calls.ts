// SPDX-License-Identifier: Apache-2.0
// The Customer calls view and CRM sync status.

import type { IsoTime } from './common'
import type { IntegrationProvider } from './integrations'

export interface CustomerCallsStatus {
  enabled: boolean
  folderId: string | null
  autoAdd: boolean
  excludedEmails: string[]
  excludedDomains: string[]
  backlogCount: number
}

export interface CustomerCallsBacklogNote {
  noteId: string
  title: string | null
  meetingAt: IsoTime
  meetingType: string
}

export interface CustomerCallsSyncStatus {
  noteId: string
  provider: IntegrationProvider
  state: 'synced' | 'sending' | 'failed' | 'check' | 'not-synced' | null
  error: string | null
  deliveryId: string | null
}

export const CUSTOMER_CALLS = {
  folderPreset: 'client_meetings',
  meetingTypes: ['sales', 'account_care'],
  backlogDays: 30,
  classifyOlderMax: 50,
  syncBatch: 100,
  companiesMinNotes: 10
} as const
