// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Labs: every
// default-off feature, listed once, grouped by section. A row is a generic switch bound to its
// settings key unless its owner draws a custom row (`kind: 'custom'`, which also covers
// selects and confirmations). Action items and follow-up email also appear in Settings ▸ AI.

import type { SettingsSection } from './settings'

/** The section a row is listed under. */
export type LabsSection =
  | 'notes'
  | 'meetings'
  | 'transcription'
  | 'chat-ai'
  | 'people'
  | 'integrations'
  | 'window'
  | 'security'
  | 'developers'
  | 'beta'

export const LABS_SECTIONS: readonly { id: LabsSection; title: string }[] = [
  { id: 'notes', title: 'Notes' },
  { id: 'meetings', title: 'Meetings' },
  { id: 'transcription', title: 'Transcription' },
  { id: 'chat-ai', title: 'Chat and AI' },
  { id: 'people', title: 'People' },
  { id: 'integrations', title: 'Integrations' },
  { id: 'window', title: 'Window' },
  { id: 'security', title: 'Security' },
  { id: 'developers', title: 'Developers' },
  { id: 'beta', title: 'Beta program' }
]

export type LabsSettingKey =
  | 'scratchpad.enabled'
  | 'actionItems.enabled'
  | 'actionItems.lineDrafts'
  | 'followUpEmail.enabled'
  | 'tags.classify'
  | 'attachedLinks.enabled'
  | 'prepBrief.enabled'
  | 'prepBrief.inChat'
  | 'screenSnapshots.enabled'
  | 'bubbleSnapshots.enabled'
  | 'quickAsk.enabled'
  | 'companies.sidebarFavorites'
  | 'mcpClient.enabled'
  | 'voiceTyping.enabled'
  | 'voiceTyping.screenContext'
  | 'integrations.slack.aiDraft'
  | 'screenCorner.enabled'
  // Workflow, knowledge and meeting features
  | 'dispatcher.enabled'
  | 'tasks.enabled'
  | 'summaryFeedback.enabled'
  | 'userContext.enabled'
  | 'recurringRecap.enabled'
  | 'reminders.enabled'
  | 'consent.enabled'
  | 'meetingDock.enabled'
  | 'liveContext.mode'
  | 'transcriptReport.enabled'
  | 'companionCli.enabled'
  | 'updates.channel'
  | 'security.deviceLock'
  | 'transcriptionRules.enabled'
  | 'calendarWrite.enabled'
  | 'automations.enabled'
  | 'customerCalls.enabled'
  | 'mail.enabled'
  | 'connectors.files.enabled'
  | 'integrations.salesforce.enabled'
  | 'integrations.pipedriveAshby.enabled'
  | 'sources.enabled'
  | 'capture.restartOnStillHere'

export interface LabsFeature {
  key: LabsSettingKey
  label: string
  description: string
  /** Shown indented under this row, and only usable while it is on. */
  parent?: LabsSettingKey
  /** Listed only on these platforms. */
  platforms?: readonly ('win32' | 'darwin')[]
  /** The section the row is listed under. */
  section: LabsSection
  /** `custom`: the feature's owner draws the row. */
  kind: 'switch' | 'custom'
  /** The same key also has a row in this Settings section. */
  alsoIn?: SettingsSection
}

export const LABS_FEATURES: readonly LabsFeature[] = [
  { key: 'scratchpad.enabled', label: 'Scratchpad', description: 'A daily outline for notes and todos.', section: 'notes', kind: 'switch' },
  {
    key: 'actionItems.enabled',
    label: 'Action items',
    description: 'Pull action items out of each meeting summary.',
    section: 'notes',
    kind: 'switch',
    alsoIn: 'ai'
  },
  {
    key: 'actionItems.lineDrafts',
    label: 'Draft messages from action items',
    description: 'Adds a button to email and Slack action items in your summaries that starts the draft in chat.',
    parent: 'actionItems.enabled',
    section: 'notes',
    kind: 'switch'
  },
  {
    key: 'dispatcher.enabled',
    label: 'Dispatcher',
    description: 'Each morning, pick a few of your own to-dos from recent meetings and start them in chat.',
    parent: 'actionItems.enabled',
    section: 'notes',
    kind: 'switch'
  },
  {
    key: 'tasks.enabled',
    label: 'Tasks',
    description: 'Collect the checkboxes from your meeting summaries in one place, and let the AI help with each one.',
    section: 'notes',
    kind: 'switch'
  },
  {
    key: 'followUpEmail.enabled',
    label: 'Follow-up email drafts',
    description: 'Draft a follow-up email to attendees from the meeting’s notes, ready to edit and send.',
    section: 'notes',
    kind: 'switch',
    alsoIn: 'ai'
  },
  {
    key: 'tags.classify',
    label: 'Classify meetings',
    description: 'Tag each meeting with its type and sensitivity after its summary, using your AI provider.',
    section: 'notes',
    kind: 'switch'
  },
  {
    key: 'attachedLinks.enabled',
    label: 'Links from invites',
    description: 'Offer to save the document links in a meeting’s invite to its note.',
    section: 'notes',
    kind: 'switch'
  },
  {
    key: 'summaryFeedback.enabled',
    label: 'Rate your notes',
    description: 'Now and then, ask how a summary turned out. Your ratings stay on this computer and help you tune your templates.',
    section: 'notes',
    kind: 'switch'
  },
  {
    key: 'userContext.enabled',
    label: 'About me (Wiki)',
    description: 'Tell Notula about yourself, or let your AI draft it from your notes, so summaries and chat fit how you work.',
    section: 'notes',
    kind: 'switch'
  },
  {
    key: 'prepBrief.enabled',
    label: 'Prep briefs',
    description: 'Before meetings with people outside your company, prepare a short brief from your past notes with them.',
    section: 'meetings',
    kind: 'switch'
  },
  {
    key: 'prepBrief.inChat',
    label: 'Briefs in note chat',
    description: 'Add the meeting’s brief to its note chat.',
    parent: 'prepBrief.enabled',
    section: 'meetings',
    kind: 'switch'
  },
  {
    key: 'recurringRecap.enabled',
    label: 'Recap of last time',
    description: 'Before a recurring meeting, show a short recap of the last one on the reminder.',
    section: 'meetings',
    kind: 'switch'
  },
  {
    key: 'reminders.enabled',
    label: 'Meeting reminders',
    description: 'Cards that point out invites to answer, meetings missing a link, and no-shows, with drafts from your AI provider.',
    section: 'meetings',
    kind: 'switch'
  },
  {
    key: 'consent.enabled',
    label: 'Notice in meeting chat',
    description: 'When you start taking notes in a Zoom or Teams call, post a short notice in the meeting chat so everyone knows.',
    section: 'meetings',
    kind: 'custom'
  },
  {
    key: 'screenSnapshots.enabled',
    label: 'Snapshots of shared screens',
    description: 'While someone shares their screen, keep snapshots of the window you pick in the meeting’s notes.',
    section: 'meetings',
    kind: 'custom'
  },
  {
    key: 'bubbleSnapshots.enabled',
    label: 'Snapshot button in the meeting bubble',
    description: 'Capture part of your screen into the meeting’s notes.',
    section: 'meetings',
    kind: 'switch'
  },
  {
    key: 'meetingDock.enabled',
    label: 'Meeting dock',
    description: 'During a meeting, keep a small window on top with chat, your notes and the live transcript.',
    section: 'meetings',
    kind: 'switch'
  },
  {
    key: 'capture.restartOnStillHere',
    label: 'Reconnect transcription when you answer “I’m still here”',
    description: 'If the transcript stalled, Notula reconnects transcription and restarts the meeting audio.',
    section: 'meetings',
    kind: 'switch'
  },
  {
    key: 'sources.enabled',
    label: 'Sources',
    description: 'When you play a video or a course lesson in your browser, offer a note linked to it, with each line stamped at its moment in the video.',
    platforms: ['win32'],
    section: 'meetings',
    kind: 'switch',
    alsoIn: 'sources'
  },
  {
    key: 'liveContext.mode',
    label: 'Live context',
    description: 'During a meeting, answer questions from your notes or suggest follow-up times. Uses your AI provider throughout the meeting.',
    section: 'meetings',
    kind: 'custom'
  },
  {
    key: 'transcriptionRules.enabled',
    label: 'Transcription rules',
    description: 'Ask, warn or block before Notula takes notes in meetings you choose.',
    section: 'meetings',
    kind: 'switch'
  },
  {
    key: 'automations.enabled',
    label: 'Automations',
    description: 'File notes into folders or send them to a webhook when a meeting ends.',
    section: 'meetings',
    kind: 'switch'
  },
  {
    key: 'transcriptReport.enabled',
    label: 'Report transcript problems',
    description: 'Keep a note on this computer when a transcript goes wrong, to share when you choose.',
    section: 'transcription',
    kind: 'switch'
  },
  {
    key: 'quickAsk.enabled',
    label: 'Quick ask',
    // The custom row shows the effective shortcut: Ctrl+Alt+Space on Windows.
    description: 'Press Alt+Space anywhere to ask Notula about your notes.',
    section: 'chat-ai',
    kind: 'custom'
  },
  {
    key: 'mcpClient.enabled',
    label: 'MCP tools in chat',
    description: 'Let chat use tools from the MCP servers you add in Connectors.',
    section: 'chat-ai',
    kind: 'switch'
  },
  {
    key: 'voiceTyping.enabled',
    label: 'Voice typing',
    description: 'Dictate into any app with a keyboard shortcut.',
    platforms: ['win32', 'darwin'],
    section: 'chat-ai',
    kind: 'custom'
  },
  {
    key: 'voiceTyping.screenContext',
    label: 'Screen context for voice typing',
    description: 'Use text near your cursor to spell names correctly.',
    parent: 'voiceTyping.enabled',
    section: 'chat-ai',
    kind: 'switch'
  },
  {
    key: 'integrations.slack.aiDraft',
    label: 'Draft Slack messages with AI',
    description: 'Start Send to Slack with an AI-written update.',
    section: 'chat-ai',
    kind: 'switch'
  },
  {
    key: 'calendarWrite.enabled',
    label: 'Create calendar events from chat',
    description: 'Let chat draft calendar events. Nothing is added until you click Create event.',
    section: 'chat-ai',
    kind: 'switch'
  },
  {
    key: 'companies.sidebarFavorites',
    label: 'Company favorites in sidebar',
    description: 'Star companies to keep them in the sidebar.',
    section: 'people',
    kind: 'switch'
  },
  {
    key: 'customerCalls.enabled',
    label: 'Customer calls',
    description: 'Gathers your calls with external attendees in one folder, ready to review or send to your CRM.',
    section: 'people',
    kind: 'custom'
  },
  {
    key: 'mail.enabled',
    label: 'Email context and sending',
    description: 'Use recent Gmail or Outlook threads in briefs and chat, and send follow-up emails from Notula.',
    section: 'integrations',
    kind: 'switch'
  },
  {
    key: 'connectors.files.enabled',
    label: 'File connectors',
    description: 'Let chat search and read files in Google Drive, OneDrive and Dropbox. Read-only.',
    section: 'integrations',
    kind: 'switch'
  },
  {
    key: 'integrations.salesforce.enabled',
    label: 'Salesforce',
    description: 'Save meetings to Salesforce. Still being verified.',
    section: 'integrations',
    kind: 'switch'
  },
  {
    key: 'integrations.pipedriveAshby.enabled',
    label: 'Pipedrive and Ashby',
    description: 'Save meetings to Pipedrive and Ashby.',
    section: 'integrations',
    kind: 'switch'
  },
  {
    key: 'screenCorner.enabled',
    label: 'Screen corner',
    description: 'Move the pointer to the bottom-left corner of the screen to start a note.',
    platforms: ['darwin'],
    section: 'window',
    kind: 'switch'
  },
  {
    key: 'security.deviceLock',
    label: 'Lock Notula with Windows Hello / Touch ID',
    description: 'Ask for Windows Hello or Touch ID before showing your notes, and before turning protections off.',
    section: 'security',
    kind: 'custom'
  },
  {
    key: 'companionCli.enabled',
    label: 'Companion CLI for coding agents',
    description: 'Gives coding agents on this computer a notula command to search and read your Notula notes and transcripts.',
    section: 'developers',
    kind: 'custom'
  },
  {
    key: 'updates.channel',
    label: 'Join the beta',
    description: 'Try new features early and help catch problems.',
    section: 'beta',
    kind: 'custom'
  }
]
