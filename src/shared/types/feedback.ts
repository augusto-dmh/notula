// SPDX-License-Identifier: Apache-2.0
// Local feedback reports and the user's own hand-off. Nothing is uploaded.

export type FeedbackMode = 'bug' | 'question' | 'feature'

export const FEEDBACK_CATEGORIES = [
  'Meeting transcription',
  'Notes',
  'Chat',
  'Integrations',
  'Settings',
  'Language functionality',
  'General app functionality',
  'Other'
] as const

export interface FeedbackReportInput {
  mode: FeedbackMode
  category: string | null
  message: string
  includeSystemInfo: boolean
  includeLogs: boolean
  /** From `files.pathForFile`. */
  attachmentPaths: string[]
}

export interface FeedbackOpenInput {
  target: 'email' | 'issue'
  mode: FeedbackMode
  category: string | null
  message: string
  includeSystemInfo: boolean
}

export interface FeedbackSystemInfo {
  appVersion: string
  electronVersion: string
  os: string
  arch: string
  emailAvailable: boolean
  issuesAvailable: boolean
}

export const FEEDBACK_LIMITS = {
  fileMaxBytes: 20_971_520,
  totalMaxBytes: 41_943_040,
  mailtoBodyMax: 1_800,
  issueUrlMax: 6_000,
  attachmentTypes: ['image/png', 'image/jpeg', 'image/gif', 'video/*']
} as const
