// SPDX-License-Identifier: Apache-2.0
// Preferences. Stored per key in SQLite; read with `prefs:get`, written per key with
// `prefs:set`.

import { DEFAULT_GENERIC_EMAIL_DOMAINS } from '../lib/people'
import type { LiveContextMode } from './live-context'
import type { AppIconValue } from './app-icon'
import type { UpdateChannel } from './app'
import type { IsoTime } from './common'
import type { InputPreference } from './capture'
import type {
  DictationAsrChoice,
  DictationCategory,
  DictationMicrophone,
  DictationRetention,
  DictationTone
} from './dictation'
import type { LlmProviderId } from './enhance'
import type { SalesforceOptions } from './integrations'
import type { LabsSettingKey } from './labs'
import type { BubblePosition } from './bubble'
import type { CompanyFavorite } from './people'
import type { PermissionRecord } from './permissions'
import type { RecipeView } from './recipes'
import type { AudioRetention } from './recordings'
import type { RetentionHours } from './retention'
import type { ImportFolderMode } from './imports-markdown'
import type { SourceMute, SourcesOfferMode, SourcesYtDlpMode } from './sources'
import type { TranscriptionRule } from './transcription-rules'
import type { AsrProviderId, LocalAsrChoice, MeetSelectors } from './transcript'

export type ThemeSetting = 'system' | 'light' | 'dark'
/** `multi` = multilingual; `pt-BR` only while an on-device model covers it. */
export type TranscriptionLanguage = 'en' | 'multi' | 'pt-BR'
export type SummaryLanguage = 'en' | 'multi'
export type AssemblyAiRegion = 'edge' | 'us' | 'eu'
/** Deepgram `multi`: the default model version, or `58-lang-beta` (nova-3-mega). */
export type DeepgramMultilingualVersion = 'default' | '58-lang-beta'
export type AssemblyAiMultilingualModel = 'universal-3-5-pro' | 'universal-3-6-pro'

export interface Settings {
  'asr.provider': AsrProviderId
  'asr.language': TranscriptionLanguage
  /** Also feeds `custom_vocabulary`. The UI caps it at `JARGON_LIMITS.maxTerms`. */
  'asr.keywords': string[]
  /** The on-device model, or `auto` (by the session language). */
  'asr.local.model': LocalAsrChoice
  /** What `auto` prefers for languages other than English. */
  'asr.local.prefer': 'accuracy' | 'speed'
  'asr.deepgram.model': string
  'asr.deepgram.mipOptOut': boolean
  'asr.assemblyai.region': AssemblyAiRegion
  'capture.inputPreference': InputPreference
  'capture.sounds': boolean
  'llm.provider': LlmProviderId
  'llm.anthropic.model': string
  'llm.openai.model': string
  'llm.openai.baseUrl': string
  'llm.local.model': string
  'llm.local.baseUrl': string
  'enhance.summaryLanguage': SummaryLanguage
  'profile.name': string
  'profile.email': string
  'profile.company': string
  'profile.jobTitle': string
  'profile.companyDescription': string
  'ui.theme': ThemeSetting
  /** Main-only. Set once at the first packaged launch. */
  'app.openAtLoginInitialized': boolean
  /** Set by the onboarding AI-providers step: saved, chose local, or skipped. */
  'onboarding.aiProvidersDoneAt': IsoTime | null
  /** Main-only. */
  'permissions.record': PermissionRecord
  /** Scheduled-meeting notifications off. */
  'notifications.scheduledBlocked': boolean
  /** Auto-detected meeting notifications off. */
  'notifications.autoDetectedBlocked': boolean
  /** Apps whose detected meetings never notify. */
  'notifications.silencedAppIds': string[]

  // ---------- shell, meetings, transcription, templates and chat ----------
  /** The main window's sidebar. */
  'ui.sidebar': { open: boolean; width: number }
  /** macOS: the upcoming event as the menu-bar title. */
  'tray.showUpcomingEventInMenuBar': boolean
  /** The onboarding calendar step, once calendar sync ships. */
  'onboarding.calendarDoneAt': IsoTime | null
  /** "Live meeting indicator" off. */
  'bubble.blocked': boolean
  /** Main-only, per device. */
  'bubble.position': BubblePosition | null
  'meetings.detectionEnabled': boolean
  'meetings.autostartDetected': boolean
  /** null = no warning. */
  'capture.inactivityWarningMinutes': number | null
  /** null = no auto-stop. */
  'capture.inactivityAutoStopMinutes': number | null
  'capture.autoStopWhenMeetingAppCloses': boolean
  /** Ask the LLM whether the meeting ended before an app-left stop. */
  'capture.llmAutoStop': boolean
  /** Labs: "I'm still here" on the inactivity warning also restarts transcription and audio. */
  'capture.restartOnStillHere': boolean
  /** Word-level speaker turns. */
  'transcription.diarization': boolean
  'asr.deepgram.multilingualVersion': DeepgramMultilingualVersion
  'asr.assemblyai.multilingualModel': AssemblyAiMultilingualModel
  /** Favourite template ids. */
  'templates.favoriteIds': string[]
  /** Template id → its newest use times (frecency). */
  'templates.usage': Record<string, IsoTime[]>
  /** Recent recipe ids per view (written by the chat engine). */
  'recipes.recent': Partial<Record<RecipeView, string[]>>
  /** The single-meeting chat model, or `auto`. */
  'chat.model.single': string
  /** The multi-meeting chat model, or `auto`. */
  'chat.model.multi': string
  /** Context window when the Models API is unreachable. */
  'chat.contextTokens.anthropic': number
  'chat.contextTokens.openai': number
  'chat.contextTokens.local': number
  /** Main-only: `<provider>:<model>` pairs that rejected tools. */
  'chat.noTools': string[]

  // ---------- calendar, people and folders ----------
  /**
   * Coming up, Settings ▸ Calendar and the tray: hide events without other people or
   * a video link.
   */
  'calendar.filterPersonalEvents': boolean
  /** "Show profile pictures from Gravatar". Off: no image request is made. */
  'people.gravatarEnabled': boolean
  /** Webmail domains, lower-case (also used by the home attendee summaries). */
  'people.genericEmailDomains': string[]
  /** Main-only (recorded in `folders:add-notes`): folder id → its newest add-to-folder times. */
  'folders.useTimestamps': Record<string, IsoTime[]>
  /** Recurring event ids whose folder suggestion was dismissed. */
  'folders.ignoredSeries': string[]
  /** The sidebar's folder section state. */
  'folders.sidebar': { myNotesExpanded: boolean; favoritesOpen: boolean; collapsedFolderIds: string[]; showAll: boolean }
  /** "Suggest folders with AI" (LLM purpose `folder-suggest`). */
  'folders.aiSuggestions': boolean

  // ---------- feature settings ----------
  /** Speaker attribution per meeting app (Windows only for now). */
  'attribution.zoom': boolean
  'attribution.teams': boolean
  'attribution.meet': boolean
  /** The Meet reader's class names; null = DEFAULT_MEET_SELECTORS. */
  'attribution.meetSelectors': MeetSelectors | null
  /** AI speaker-name suggestions. */
  'speakerNames.suggestions': boolean
  /** Keep meeting audio, encrypted. */
  'audio.keepRecordings': boolean
  'audio.retention': AudioRetention
  /** Live captions for every meeting. */
  'captions.alwaysOn': boolean
  /** Also gates the action-item chat tools and the Labs row. */
  'actionItems.enabled': boolean
  /** A button on email and Slack action items that starts the draft in chat. */
  'actionItems.lineDrafts': boolean
  /** Meeting classification after a summary. */
  'tags.classify': boolean
  /** Links from invites. */
  'attachedLinks.enabled': boolean
  'followUpEmail.enabled': boolean
  'followUpEmail.auto': boolean
  'scratchpad.enabled': boolean
  /** Prep briefs; with `inChat`, chat also gets a meaningful brief as context. */
  'prepBrief.enabled': boolean
  'prepBrief.inChat': boolean
  /** Main-only. */
  'onboarding.demoStarted': boolean
  /** Labs. */
  'screenSnapshots.enabled': boolean
  /** The one-time confirmation. */
  'screenSnapshots.confirmedAt': IsoTime | null
  /** Main-only. */
  'screenSnapshots.firstCaptureDone': boolean
  /** Labs. */
  'bubbleSnapshots.enabled': boolean
  /** Labs. */
  'quickAsk.enabled': boolean
  /** null = QUICK_ASK_SHORTCUT per platform (see the shortcut registry). */
  'shortcuts.quickAsk': string | null
  /** The menu accelerator. null = `CmdOrCtrl+Shift+N`. */
  'shortcuts.newNote': string | null
  /** The opt-in favicon fetch. */
  'companies.faviconsEnabled': boolean
  /** Labs. */
  'companies.sidebarFavorites': boolean
  'companies.favorites': CompanyFavorite[]
  /** "This model accepts images". */
  'llm.openai.acceptsImages': boolean
  'llm.local.acceptsImages': boolean
  'integrations.slack.mode': 'bot' | 'webhook'
  'integrations.slack.aiDraft': boolean
  /** Main-only (written after validation). */
  'integrations.affinity.domain': string
  /** Folders whose Zapier workflows run. */
  'integrations.zapier.folderRunIds': string[]
  /** Labs. */
  'mcpClient.enabled': boolean
  /** The local MCP server. */
  'mcpServer.enabled': boolean
  'mcpServer.stdio': boolean
  'mcpServer.http': boolean
  'mcpServer.port': number
  /** Labs. */
  'voiceTyping.enabled': boolean
  'voiceTyping.screenContext': boolean
  'dictation.enabled': boolean
  /** null = DICTATION_DEFAULT_SHORTCUT. */
  'dictation.shortcut': string | null
  'dictation.language': string | null
  'dictation.microphone': DictationMicrophone | null
  'dictation.asr': DictationAsrChoice
  'dictation.screenContext': boolean
  'dictation.styles': Record<DictationCategory, DictationTone | null>
  'dictation.dictionary': string[]
  'dictation.dictionaryRemoved': string[]
  /** null = `24h`. */
  'dictation.failedAudioRetention': DictationRetention | null
  /** Set by the voice typing overlay's Done; until then the page offers "Try voice typing". */
  'dictation.onboardingCompleted': boolean
  /** The dictation bar; effective only inside the Voice typing gate. */
  'dictationBar.enabled': boolean
  /** Epoch ms the bar stays hidden until (Hide for 1 hour), or null. Main-only. */
  'dictationBar.snoozeUntil': number | null
  /** Hook chords ("Ctrl+Win"). null = the platform default, '' = off. */
  'shortcuts.dictationHold': string | null
  'shortcuts.dictationHandsFree': string | null
  /** An accelerator. null = `Control+Alt+M` (Windows) / `Command+Alt+M` (macOS). */
  'shortcuts.recordToggle': string | null
  /**
   * Read everywhere through `privacy.ts`. Main-only, changed only through
   * `privacy:set-local-only`.
   */
  'privacy.localOnly': boolean
  /** Move the main window aside when a meeting is joined. */
  'window.repositionForMeetings': boolean
  /** macOS only, Labs. */
  'screenCorner.enabled': boolean
  /** Debug lines in packaged builds. */
  'diagnostics.verboseLogging': boolean

  // ---------- privacy, workflows and Labs ----------
  /** Labs. */
  'consent.enabled': boolean
  'consent.zoom': boolean
  'consent.teams': boolean
  'consent.meet': boolean
  /** '' = CONSENT_DEFAULT_MESSAGE. */
  'consent.message': string
  'consent.waitForOtherSpeaker': boolean
  'consent.deferTranscription': boolean
  /** Labs. */
  'voiceprint.enabled': boolean
  /** Main-only (`voiceprint:set-passive`). */
  'voiceprint.passive': boolean
  /** Labs. */
  'transcriptReport.enabled': boolean
  /** Main-only (`retention:set`, `retention:cancel-pending`). */
  'retention.transcriptHours': RetentionHours | null
  'retention.pendingHours': RetentionHours | null
  /** Main-only. */
  'retention.effectiveAt': IsoTime | null
  'retention.noticeShownFor': IsoTime | null
  'meetingDock.enabled': boolean
  /** Main-only. */
  'meetingDock.size': { width: number; height: number } | null
  /** Custom Labs row. */
  'liveContext.mode': LiveContextMode
  'reminders.enabled': boolean
  'recurringRecap.enabled': boolean
  'tasks.enabled': boolean
  'summaryFeedback.enabled': boolean
  /** Main-only. */
  'summaryFeedback.lastShownAt': IsoTime | null
  'userContext.enabled': boolean
  'userContext.inSummaries': boolean
  'userContext.inChat': boolean
  /** Also used by transcription through `promptExtras`. Main-only (`user-context:set-names`). */
  'userContext.nameDictionary': string[]
  'dispatcher.enabled': boolean
  'dispatcher.morningRun': boolean
  'dispatcher.morningHour': number
  /** Main-only (`local-api:set-enabled`). */
  'localApi.enabled': boolean
  /** Custom Labs row. */
  'companionCli.enabled': boolean
  'companionCli.allowTranscripts': boolean
  'companionCli.allowFolderWrites': boolean
  /** Read by the chat composer; set in Preferences. */
  'chat.enterBehavior': 'send' | 'newline'
  /** Main-only (`app-icon:set`). */
  'ui.appIcon': AppIconValue | null
  'nux.enabled': boolean
  /** Main-only (`nux:dismiss`, `nux:reset`). */
  'nux.dismissed': Record<string, IsoTime>
  /** Main-only (`nux:increment`, `nux:reset`). */
  'nux.counters': Record<string, number>
  /** Main-only (What's new). */
  'nux.lastSeenVersion': string | null
  /** Main-only. */
  'app.firstRunAt': IsoTime | null
  /** Read by the updater. Main-only (`update:set-channel`). */
  'updates.channel': UpdateChannel
  /** Main-only. */
  'privacy.localOnlyChangedAt': IsoTime | null
  'privacy.previousProviders': { asr: AsrProviderId; llm: LlmProviderId } | null
  /** Main-only (`device-lock:set-enabled`). */
  'security.deviceLock': boolean
  'security.lockAfterMinutes': 5 | 15 | 60 | null
  'transcriptionRules.enabled': boolean
  /** Main-only (`transcription-rules:save`). */
  'transcriptionRules.rules': TranscriptionRule[]
  'transcriptionRules.internalDomains': string[]
  'automations.enabled': boolean
  /** Main-only (`customer-calls:enable`, `customer-calls:disable`). */
  'customerCalls.enabled': boolean
  'customerCalls.folderId': string | null
  'customerCalls.autoAdd': boolean
  /** Main-only (`customer-calls:set-exclusions`). */
  'customerCalls.excludedEmails': string[]
  'customerCalls.excludedDomains': string[]
  'calendarWrite.enabled': boolean
  'mail.enabled': boolean
  'connectors.files.enabled': boolean
  /** Labs until verified against a live org. */
  'integrations.salesforce.enabled': boolean
  'integrations.salesforce.options': SalesforceOptions
  'integrations.pipedriveAshby.enabled': boolean
  'integrations.pipedrive.activityDone': boolean
  // Content sources (Settings ▸ Sources; the Labs row is `sources.enabled`, Windows only)
  'sources.enabled': boolean
  /** Runs the passive reader. */
  'sources.detect': boolean
  'sources.offer': SourcesOfferMode
  /** Main-only (`sources:grant`). */
  'sources.readHistory': boolean
  /** Main-only (`sources:grant`). */
  'sources.onlineLookups': boolean
  /** Main-only: the first-use prompt was answered. */
  'sources.grantAsked': boolean
  /** Extra course hosts for the History read; known providers' hosts are built in. */
  'sources.courseHosts': string[]
  'sources.ytDlp': SourcesYtDlpMode
  /** Acts only with lookups granted. */
  'sources.videoCaptions': boolean
  'sources.stampPositions': boolean
  'sources.lessonTemplate': boolean
  'sources.autoFile': boolean
  /** Main-only: the Videos folder's id, created on first use; '' = none yet. */
  'sources.videosFolder': string
  'sources.muted': SourceMute[]
  /** Main-only (`sources:dismiss-hint`): `<hint>:<key>`. */
  'sources.dismissedHints': string[]
  'sources.extensionPreferred': boolean
  /** Main-only (`ext-bridge:set-enabled`): writes and removes the host files and keys. */
  'sources.extension.enabled': boolean
  'sources.extension.allowIncognito': boolean
  'sources.extension.captions': boolean
  'sources.extension.coursePages': boolean
  // Import notes (Settings ▸ Data)
  /** The last choice is remembered. */
  'notesImport.folderMode': ImportFolderMode
  /** Shown only with `sources.enabled`. */
  'notesImport.findSourcesAfter': boolean
}

export type SettingKey = keyof Settings

/** A per-key merge. */
export type SettingsPatch = Partial<Settings>

/** Treat as read-only: clone before handing a value out for mutation. */
export const DEFAULT_SETTINGS: Settings = {
  'asr.provider': 'deepgram',
  'asr.language': 'en',
  'asr.keywords': [],
  'asr.local.model': 'auto',
  'asr.local.prefer': 'accuracy',
  'asr.deepgram.model': 'nova-3',
  'asr.deepgram.mipOptOut': true,
  'asr.assemblyai.region': 'edge',
  'capture.inputPreference': { mode: 'auto' },
  'capture.sounds': false,
  'llm.provider': 'anthropic',
  'llm.anthropic.model': 'claude-opus-5-5',
  'llm.openai.model': '',
  'llm.openai.baseUrl': 'https://api.openai.com/v1',
  'llm.local.model': '',
  'llm.local.baseUrl': 'http://127.0.0.1:11434/v1',
  'enhance.summaryLanguage': 'en',
  'profile.name': '',
  'profile.email': '',
  'profile.company': '',
  'profile.jobTitle': '',
  'profile.companyDescription': '',
  'ui.theme': 'system',
  'app.openAtLoginInitialized': false,
  'onboarding.aiProvidersDoneAt': null,
  'permissions.record': { microphone: 'unknown', systemAudio: 'unknown', requestingSystemAudio: false },
  'notifications.scheduledBlocked': false,
  'notifications.autoDetectedBlocked': false,
  'notifications.silencedAppIds': [],
  'ui.sidebar': { open: true, width: 240 },
  'tray.showUpcomingEventInMenuBar': false,
  'onboarding.calendarDoneAt': null,
  'bubble.blocked': false,
  'bubble.position': null,
  'meetings.detectionEnabled': true,
  'meetings.autostartDetected': false,
  'capture.inactivityWarningMinutes': 10,
  'capture.inactivityAutoStopMinutes': 15,
  'capture.autoStopWhenMeetingAppCloses': true,
  'capture.llmAutoStop': false,
  'capture.restartOnStillHere': false,
  'transcription.diarization': false,
  'asr.deepgram.multilingualVersion': 'default',
  'asr.assemblyai.multilingualModel': 'universal-3-5-pro',
  'templates.favoriteIds': [],
  'templates.usage': {},
  'recipes.recent': {},
  'chat.model.single': 'auto',
  'chat.model.multi': 'auto',
  'chat.contextTokens.anthropic': 200_000,
  'chat.contextTokens.openai': 200_000,
  'chat.contextTokens.local': 8_192,
  'chat.noTools': [],
  'calendar.filterPersonalEvents': false,
  'people.gravatarEnabled': false,
  'people.genericEmailDomains': [...DEFAULT_GENERIC_EMAIL_DOMAINS],
  'folders.useTimestamps': {},
  'folders.ignoredSeries': [],
  'folders.sidebar': { myNotesExpanded: false, favoritesOpen: true, collapsedFolderIds: [], showAll: false },
  'folders.aiSuggestions': false,
  'attribution.zoom': false,
  'attribution.teams': false,
  'attribution.meet': false,
  'attribution.meetSelectors': null,
  'speakerNames.suggestions': false,
  'audio.keepRecordings': false,
  'audio.retention': '7d',
  'captions.alwaysOn': false,
  'actionItems.enabled': false,
  'actionItems.lineDrafts': false,
  'tags.classify': false,
  'attachedLinks.enabled': false,
  'followUpEmail.enabled': false,
  'followUpEmail.auto': false,
  'scratchpad.enabled': false,
  'prepBrief.enabled': false,
  'prepBrief.inChat': false,
  'onboarding.demoStarted': false,
  'screenSnapshots.enabled': false,
  'screenSnapshots.confirmedAt': null,
  'screenSnapshots.firstCaptureDone': false,
  'bubbleSnapshots.enabled': false,
  'quickAsk.enabled': false,
  'shortcuts.quickAsk': null,
  'shortcuts.newNote': null,
  'companies.faviconsEnabled': false,
  'companies.sidebarFavorites': false,
  'companies.favorites': [],
  'llm.openai.acceptsImages': true,
  'llm.local.acceptsImages': false,
  'integrations.slack.mode': 'bot',
  'integrations.slack.aiDraft': false,
  'integrations.affinity.domain': '',
  'integrations.zapier.folderRunIds': [],
  'mcpClient.enabled': false,
  'mcpServer.enabled': false,
  'mcpServer.stdio': true,
  'mcpServer.http': false,
  'mcpServer.port': 52_417,
  'voiceTyping.enabled': true,
  'voiceTyping.screenContext': false,
  'dictation.enabled': true,
  'dictation.shortcut': null,
  'dictation.language': null,
  'dictation.microphone': null,
  'dictation.asr': 'auto',
  'dictation.screenContext': true,
  'dictation.styles': { email: null, work: null, casual: null, other: null },
  'dictation.dictionary': [],
  'dictation.dictionaryRemoved': [],
  'dictation.failedAudioRetention': null,
  'dictation.onboardingCompleted': false,
  'dictationBar.enabled': true,
  'dictationBar.snoozeUntil': null,
  'shortcuts.dictationHold': null,
  'shortcuts.dictationHandsFree': null,
  'shortcuts.recordToggle': null,
  'privacy.localOnly': false,
  'window.repositionForMeetings': true,
  'screenCorner.enabled': false,
  'diagnostics.verboseLogging': false,
  'consent.enabled': false,
  'consent.zoom': true,
  'consent.teams': true,
  'consent.meet': true,
  'consent.message': '',
  'consent.waitForOtherSpeaker': true,
  'consent.deferTranscription': false,
  'voiceprint.enabled': false,
  'voiceprint.passive': false,
  'transcriptReport.enabled': false,
  'retention.transcriptHours': null,
  'retention.pendingHours': null,
  'retention.effectiveAt': null,
  'retention.noticeShownFor': null,
  'meetingDock.enabled': false,
  'meetingDock.size': null,
  'liveContext.mode': 'off',
  'reminders.enabled': false,
  'recurringRecap.enabled': false,
  'tasks.enabled': false,
  'summaryFeedback.enabled': false,
  'summaryFeedback.lastShownAt': null,
  'userContext.enabled': false,
  'userContext.inSummaries': true,
  'userContext.inChat': true,
  'userContext.nameDictionary': [],
  'dispatcher.enabled': false,
  'dispatcher.morningRun': true,
  'dispatcher.morningHour': 7,
  'localApi.enabled': false,
  'companionCli.enabled': false,
  'companionCli.allowTranscripts': true,
  'companionCli.allowFolderWrites': false,
  'chat.enterBehavior': 'send',
  'ui.appIcon': null,
  'nux.enabled': true,
  'nux.dismissed': {},
  'nux.counters': {},
  'nux.lastSeenVersion': null,
  'app.firstRunAt': null,
  'updates.channel': 'stable',
  'privacy.localOnlyChangedAt': null,
  'privacy.previousProviders': null,
  'security.deviceLock': false,
  'security.lockAfterMinutes': null,
  'transcriptionRules.enabled': false,
  'transcriptionRules.rules': [],
  'transcriptionRules.internalDomains': [],
  'automations.enabled': false,
  'customerCalls.enabled': false,
  'customerCalls.folderId': null,
  'customerCalls.autoAdd': true,
  'customerCalls.excludedEmails': [],
  'customerCalls.excludedDomains': [],
  'calendarWrite.enabled': false,
  'mail.enabled': false,
  'connectors.files.enabled': false,
  'integrations.salesforce.enabled': false,
  'integrations.salesforce.options': {
    eventHandling: 'create_new',
    eventBodySource: 'meeting_summary',
    eventWhatId: 'opportunity',
    contentNoteEnabled: false
  },
  'integrations.pipedriveAshby.enabled': false,
  'integrations.pipedrive.activityDone': true,
  'sources.enabled': false,
  'sources.detect': true,
  'sources.offer': 'ask',
  'sources.readHistory': false,
  'sources.onlineLookups': false,
  'sources.grantAsked': false,
  'sources.courseHosts': [],
  'sources.ytDlp': 'managed',
  'sources.videoCaptions': true,
  'sources.stampPositions': true,
  'sources.lessonTemplate': true,
  'sources.autoFile': true,
  'sources.videosFolder': '',
  'sources.muted': [],
  'sources.dismissedHints': [],
  'sources.extensionPreferred': true,
  'sources.extension.enabled': false,
  'sources.extension.allowIncognito': false,
  'sources.extension.captions': true,
  'sources.extension.coursePages': true,
  'notesImport.folderMode': 'mirror',
  'notesImport.findSourcesAfter': true
}

/** Every Labs row is a settings key (a compile-time check). */
export const LABS_KEYS_ARE_SETTINGS: LabsSettingKey extends SettingKey ? true : never = true

/** `prefs:set` drops these keys and logs it. */
export const MAIN_ONLY_SETTING_KEYS = [
  'permissions.record',
  'app.openAtLoginInitialized',
  'bubble.position',
  'chat.noTools',
  'folders.useTimestamps',
  'onboarding.demoStarted',
  'screenSnapshots.firstCaptureDone',
  'integrations.affinity.domain',
  // Each has its own invoke channel, or is written by main only
  'voiceprint.passive',
  'retention.transcriptHours',
  'retention.pendingHours',
  'retention.effectiveAt',
  'retention.noticeShownFor',
  'meetingDock.size',
  'summaryFeedback.lastShownAt',
  'userContext.nameDictionary',
  'localApi.enabled',
  'ui.appIcon',
  'nux.dismissed',
  'nux.counters',
  'nux.lastSeenVersion',
  'app.firstRunAt',
  'updates.channel',
  'privacy.localOnly',
  'privacy.localOnlyChangedAt',
  'privacy.previousProviders',
  'security.deviceLock',
  'transcriptionRules.rules',
  'transcriptionRules.internalDomains',
  'customerCalls.enabled',
  'customerCalls.folderId',
  'customerCalls.excludedEmails',
  'customerCalls.excludedDomains',
  // Written through `dictation-bar:action`
  'dictationBar.snoozeUntil',
  // Content sources: the grant, the Videos folder, hints and the extension's host files
  'sources.readHistory',
  'sources.onlineLookups',
  'sources.grantAsked',
  'sources.videosFolder',
  'sources.dismissedHints',
  'sources.extension.enabled'
] as const satisfies readonly SettingKey[]

export const PREFS_VERSION = 1

/** Personal jargon limits. */
export const JARGON_LIMITS = { maxTerms: 30, minChars: 2, maxChars: 50, maxWords: 6 } as const

/**
 * Settings pages (`settings:open`, `/settings/:section`). `calendar` shows once calendar sync
 * ships; `dev` in dev builds; `voice-typing` while `voiceTyping.enabled` is on.
 */
export type SettingsSection =
  | 'preferences'
  | 'ai'
  | 'profile'
  | 'calendar'
  | 'notifications'
  | 'dev'
  | 'speaker-tags'
  | 'voice-typing'
  | 'integrations'
  | 'connectors'
  | 'labs'
  | 'troubleshooting'
  | 'keyboard-shortcuts'
  // The last item of "Get help": version, licence and the bundled notices.
  | 'about'
  // `feedback` in Get help; `automations` after Integrations (while
  // `automations.enabled`); `meeting-notice`, `transcription-rules` and
  // `voice-typing-history` are hidden sub-pages.
  | 'feedback'
  | 'automations'
  | 'meeting-notice'
  | 'transcription-rules'
  | 'voice-typing-history'
  // Content sources: listed while `sources.enabled` is on (Windows only).
  | 'sources'

/**
 * API keys and calendar secrets, held as safeStorage ciphertext in the `secrets` table.
 * Calendar: `calendar.google.client` (`{ clientId, clientSecret }`),
 * `calendar.microsoft.client` (`{ clientId }`), and `calendar.source.<sourceId>` (the ICS
 * feed URL, or the OAuth token JSON).
 *
 * Integrations: credentials; webhook and hook URLs per
 * destination; per MCP connection its bearer token and its environment values (a
 * `b64u:` JSON object).
 */
export type SecretId =
  | 'asr.deepgram'
  | 'asr.assemblyai'
  | 'llm.anthropic'
  | 'llm.openai'
  | 'calendar.google.client'
  | 'calendar.microsoft.client'
  | `calendar.source.${string}`
  | 'integration.slack.bot'
  | 'integration.notion'
  | 'integration.hubspot'
  | 'integration.attio'
  | 'integration.affinity'
  | `integration.slack.webhook.${string}`
  | `integration.zapier.hook.${string}`
  | `mcp.token.${string}`
  | `mcp.env.${string}`
  // Plug-in providers, file connectors and webhooks
  | 'integration.salesforce.client'
  | 'integration.salesforce.tokens'
  | 'integration.pipedrive'
  | 'integration.ashby'
  | 'integration.dropbox.client'
  | 'integration.dropbox.tokens'
  | `integration.webhook.url.${string}`
  | `integration.webhook.signing.${string}`

/** The secret ids with a fixed name; the patterned ids are matched by `isSecretId`. */
export const FIXED_SECRET_IDS = [
  'asr.deepgram',
  'asr.assemblyai',
  'llm.anthropic',
  'llm.openai',
  'calendar.google.client',
  'calendar.microsoft.client',
  'integration.slack.bot',
  'integration.notion',
  'integration.hubspot',
  'integration.attio',
  'integration.affinity',
  'integration.salesforce.client',
  'integration.salesforce.tokens',
  'integration.pipedrive',
  'integration.ashby',
  'integration.dropbox.client',
  'integration.dropbox.tokens'
] as const satisfies readonly SecretId[]

/** A calendar source id is a UUID; the pattern only bounds what may name a secret. */
const CALENDAR_SOURCE_SECRET = /^calendar\.source\.[A-Za-z0-9-]{1,64}$/
/** Per integration destination and per MCP connection (their ids are UUIDs). */
const PATTERNED_SECRET_KEY = /^(integration\.(slack\.webhook|zapier\.hook)|mcp\.(token|env))\.[A-Za-z0-9-]{1,64}$/

/** The webhook URL and its signing secret, per endpoint. */
const WEBHOOK_SECRET = /^integration\.webhook\.(url|signing)\.[A-Za-z0-9-]{1,64}$/

/** Structured secrets are stored as `b64u:` + base64url(UTF-8 JSON). */
export const STRUCTURED_SECRET_PREFIX = 'b64u:'

/** The allow-list behind every secrets read and write (main and the storage worker). */
export function isSecretId(id: unknown): id is SecretId {
  return (
    typeof id === 'string' &&
    ((FIXED_SECRET_IDS as readonly string[]).includes(id) ||
      CALENDAR_SOURCE_SECRET.test(id) ||
      PATTERNED_SECRET_KEY.test(id) ||
      WEBHOOK_SECRET.test(id))
  )
}
