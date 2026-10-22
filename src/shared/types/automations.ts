// SPDX-License-Identifier: Apache-2.0
// Personal automations.

import type { IsoTime } from './common'

export interface AutomationPredicate {
  type: 'all' | 'person' | 'company' | 'recurring' | 'classification' | 'external' | 'internal'
  operator: 'include' | 'exclude'
  selected_ids: string[]
  config?: { skip_shared_inboxes?: boolean }
}

export type AutomationAction =
  | { type: 'file_in_folder'; folder_id: string }
  | { type: 'post_webhook'; webhook_id: string }

export interface AutomationRule {
  id: string
  name: string
  description: string | null
  enabled: boolean
  trigger: 'meeting_ended'
  predicates: AutomationPredicate[]
  actions: [AutomationAction]
  confirm_sends: boolean
  created_at: IsoTime
  updated_at: IsoTime
}

export type AutomationRuleInput = Omit<AutomationRule, 'id' | 'created_at' | 'updated_at'> & { id?: string }

export type AutomationRunStatus = 'matched' | 'no_match' | 'needs_confirmation' | 'executed' | 'dismissed' | 'failed'

export interface AutomationRun {
  id: string
  rule_id: string
  note_id: string
  note_title: string | null
  status: AutomationRunStatus
  reason: string | null
  delivery_id: string | null
  evaluated_at: IsoTime
  executed_at: IsoTime | null
}

export const AUTOMATION_LIMITS = {
  maxRules: 50,
  nameMax: 120,
  personMax: 25,
  noSummaryWaitMs: 120_000,
  catchUpMs: 604_800_000,
  activityRuns: 50
} as const

export const CLASSIFICATION_PRESETS = {
  'Sales and customer calls': ['sales', 'account_care'],
  'Recruiting calls': ['recruiting'],
  'Investor calls': ['fundraising']
} as const
