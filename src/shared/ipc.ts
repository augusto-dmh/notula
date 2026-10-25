// SPDX-License-Identifier: Apache-2.0
// The renderer <-> main contract. Every channel the preload exposes is listed here, so
// the surface stays explicit and typed on both sides.
//
// Call sites write the channel as a string literal (`'notes:list' satisfies InvokeChannel`),
// never through a constant or a helper that takes a channel parameter, so a search for a
// channel name finds every sender and every handler.
//
// Directions:
// - invoke: renderer → main, `ipcMain.handle`, exactly one argument (an object or void).
// - send:   renderer → main, one-way, `ipcMain.on`.
// - push:   main → renderer, `webContents.send` + preload `ipcRenderer.on`.

import type {
  ActionItem,
  ActionItemFeedback,
  ActionItemFeedbackInput,
  ActionItemReview,
  ActionItemsQuery,
  ActionItemsRegenerateEvent
} from './types/action-items'
import type { LiveContextCard } from './types/live-context'
import type { DeepLinkEvent, DeepLinkUnsupported, UpdateChannel, UpdateDelayReason, UpdateState } from './types/app'
import type { AppIconState, AppIconValue } from './types/app-icon'
import type {
  AddFilesResult,
  AddImagesResult,
  AttachmentBytes,
  AttachmentInfo,
  AttachmentInput,
  AttachmentParentType
} from './types/attachments'
import type { BriefEnsureStatus, BriefStatus, PrepBrief } from './types/briefs'
import type {
  AutomationRule,
  AutomationRuleInput,
  AutomationRun,
  AutomationRunStatus
} from './types/automations'
import type { CaptionsState } from './types/captions'
import type {
  CalendarGrant,
  CalendarInfo,
  CalendarSource,
  CalendarSourcesState,
  OAuthCalendarProvider,
  Participant,
  UpcomingPage
} from './types/calendar'
import type { AppInfo, AudioSource, IsoTime, ProviderTestResult, Rect, StopReason } from './types/common'
import type {
  CaptureCommand,
  CaptureEngineEvent,
  CaptureHealth,
  CaptureStatus,
  CaptureSystemState,
  DesiredCaptureState,
  InactivityAction,
  InactivityWarning,
  InputDevice,
  InputPreference,
  InputSelectionState,
  PowerResumed
} from './types/capture'
import type {
  ChatEvent,
  ChatSendAccepted,
  ChatSendRequest,
  ChatThread,
  ChatThreadQuery,
  ChatThreadWithMessages,
  QuickAskMessage,
  QuickAskStatus,
  ToolCallUpdate
} from './types/chat'
import type { ConsentStatus } from './types/consent'
import type {
  CustomerCallsBacklogNote,
  CustomerCallsStatus,
  CustomerCallsSyncStatus
} from './types/customer-calls'
import type { DataExportDone, DataExportProgress, DataExportRequest } from './types/data-export'
import type { ExtBridgeStatus } from './types/extension-protocol'
import type {
  ImportBatch,
  ImportCandidates,
  ImportOptions,
  ImportPreset,
  ImportPreview,
  ImportProgress,
  ImportScanProgress,
  ImportUndoPreview
} from './types/imports-markdown'
import type { DemoMode, DemoState } from './types/demo'
import type { DeviceInfo } from './types/device'
import type { LicensesInfo } from './types/licenses'
import type { DeviceLockFailure, DeviceLockStatus } from './types/device-lock'
import type { UnifiedLogStatus } from './types/diagnostics'
import type {
  DictationAttempt,
  DictationCaptureCommand,
  DictationMicError,
  DictationState,
  DictationStatus
} from './types/dictation'
import type { DictationBarAction, DictationBarMenu, DictationBarRect, DictationBarState, HookStatus } from './types/dictation-bar'
import type { DispatchList, DispatchStatus, DispatchTodoStatus } from './types/dispatch'
import type {
  ActiveGeneration,
  CloudLlmProviderId,
  EnhanceEvent,
  GenerateRequest,
  LlmProviderId,
  RewriteRequest,
  TitleResult
} from './types/enhance'
import type {
  Folder,
  FolderCreate,
  FolderNoteSource,
  FolderPatch,
  FolderRule,
  FolderRuleInput,
  FolderSuggestion,
  FoldersState
} from './types/folders'
import type { FeedbackOpenInput, FeedbackReportInput, FeedbackSystemInfo } from './types/feedback'
import type { FileConnectorKey, FileConnectorStatus, FileReadResult, FileSearchResult } from './types/file-connectors'
import type { FollowUpDraft, FollowUpDraftPatch, FollowUpHandoffResult } from './types/follow-up'
import type {
  IntegrationAutomation,
  IntegrationAutomationInput,
  IntegrationCredentialInput,
  IntegrationDelivery,
  IntegrationDestination,
  IntegrationDestinationInput,
  IntegrationProvider,
  IntegrationSearchQuery,
  IntegrationSearchResult,
  IntegrationShareRequest,
  IntegrationStatus
} from './types/integrations'
import type {
  CompanionAgentId,
  CompanionCliStatus,
  LocalApiActivity,
  LocalApiKey,
  LocalApiKeyInput,
  LocalApiScope,
  LocalApiStatus
} from './types/local-api'
import type { DataUsage, LocalOnlyRefusal, LocalOnlyStatus } from './types/local-only'
import type { MailAccount, MailDraftInput, MailThread } from './types/mail'
import type {
  McpLocalServerActivity,
  McpLocalServerConfig,
  McpLocalServerStatus,
  McpLocalServerToken,
  McpPolicyChange,
  McpServerInfo,
  McpServerInput,
  McpServerPatch,
  McpStdioConfig,
  McpToolInfo
} from './types/mcp'
import type { MeetingDetectionStatus, MicApp } from './types/meetings'
import type { MeetingDockHistory, MeetingDockState, MeetingDockView } from './types/meeting-dock'
import type { NetDoctorReport } from './types/netdoctor'
import type {
  AttachedLink,
  AutoDeleteRequest,
  AutoDeleteResult,
  CalendarEvent,
  DocumentTag,
  NewNoteRequest,
  Note,
  NoteCreateInput,
  NoteListPage,
  NotePatch,
  NotesListQuery,
  TrashItem
} from './types/notes'
import type { LastTimeRecap, NotificationAction, NotificationPayload } from './types/notify'
import type { BubbleDocument, BubbleState } from './types/bubble'
import type { WhatsNewEntry } from './types/nux'
import type { Panel, PanelPatch } from './types/panels'
import type {
  CompaniesQuery,
  CompanyDetail,
  CompanyIcon,
  CompanyRow,
  PeopleQuery,
  PersonDetail,
  PersonRow
} from './types/people'
import type {
  PermissionsState,
  PrivacySettingsTarget,
  SystemAudioCheck,
  SystemAudioRequest
} from './types/permissions'
import type { Recipe, RecipesUsage, RecipeUpsert } from './types/recipes'
import type { ImportJob, RecordingInfo, RecordingsUsage } from './types/recordings'
import type { Reminder, ReminderCardsState } from './types/reminder-cards'
import type { RetentionHours, RetentionPreview, RetentionRun, RetentionState } from './types/retention'
import type { ScratchpadDay, ScratchpadDaySummary } from './types/scratchpad'
import type { SearchResponse } from './types/search'
import type {
  BackfillPreview,
  CatalogImportResult,
  CatalogInput,
  Grant,
  MergeResult,
  NoteSource,
  NoteSourcePatch,
  NoteSourceView,
  PlayingItem,
  SeriesDetail,
  SeriesListItem,
  SeriesState,
  SourceDraft,
  SourceHint,
  SourceMark,
  SourcePosition,
  SourceSearchResult,
  SourceSeries,
  SourcesStatus,
  SourceTrackState,
  ToolsStatus,
  TranscriptPlan
} from './types/sources'
import type { SettingKey, Settings, SettingsPatch, SettingsSection, ThemeSetting } from './types/settings'
import type { CustomisableShortcutId, ShortcutRow } from './types/shortcuts'
import type {
  BubbleSnapshotResult,
  ScreenGuideLayout,
  ScreenSnapshotsState,
  ScreenSource
} from './types/snapshots'
import type { NotesChanged, RecoveryAction, StorageStatus } from './types/storage'
import type {
  SummaryFeedback,
  SummaryFeedbackDirection,
  SummaryFeedbackList,
  TemplateEditSuggestion
} from './types/summary-feedback'
import type { ManualTask, TasksList, TaskToggle } from './types/tasks'
import type { NoteTemplate, NoteTemplateCreate, NoteTemplatePatch } from './types/templates'
import type {
  AsrProviderId,
  AttributionStatus,
  CloudAsrProviderId,
  LocalModelId,
  LocalModelState,
  SpeakerNameAccept,
  SpeakerNameSuggestion,
  TranscriptChanged,
  TranscriptChunk,
  TranscriptionSessionInfo
} from './types/transcript'
import type { TranscriptReport, TranscriptReportInput } from './types/transcript-reports'
import type { RuleDecision, TranscriptionRule } from './types/transcription-rules'
import type {
  UserContextDraftEvent,
  UserContextSection,
  UserContextSectionId,
  UserContextState
} from './types/user-context'
import type { VoiceprintIdentifyResult, VoiceprintSampleResult, VoiceprintStatus } from './types/voiceprint'
import type { WebhookEndpoint, WebhookEndpointInput, WebhookTestResult } from './types/webhooks'
import type { WindowMode, WindowModeReason } from './types/window-modes'
import type { BlockExecuteOptions, BlockUpdate, WorkflowBlock, WorkflowBlockType } from './types/workflow-blocks'
import type { YdocState, YdocUpdated } from './types/ydoc'

/**
 * invoke channel → [request, response].
 */
export interface InvokeChannels {
  'app:info': [void, AppInfo]
  'storage:get-status': [void, StorageStatus]
  'storage:recover': [{ action: RecoveryAction }, StorageStatus]
  'notes:list': [NotesListQuery, NoteListPage]
  'notes:get': [{ id: string; includeDeleted?: boolean }, Note | null]
  'notes:create': [NoteCreateInput, Note]
  'notes:update': [{ id: string; patch: NotePatch }, Note]
  'notes:trash': [{ id: string }, void]
  'notes:restore': [{ id: string }, void]
  'notes:find-by-event': [{ eventId: string; startTime?: IsoTime }, Note | null]
  'ydoc:load': [{ roomId: string }, YdocState]
  'ydoc:append': [{ roomId: string; update: Uint8Array; origin: string }, { seq: number }]
  'panels:list': [{ noteId: string; includeDeleted?: boolean }, Panel[]]
  'panels:update': [{ id: string; patch: PanelPatch }, Panel]
  'prefs:get': [void, Settings]
  'capture:await-session-stopped': [{ noteId: string }, { waited: boolean; timedOut: boolean }]
  /** Always resolves. */
  'capture:get-status': [void, CaptureStatus]
  'capture:restart': [{ scope: 'system' | 'all' }, { ok: boolean; reason?: string }]
  'input:get-state': [void, InputSelectionState | null]
  /** Persisted rows merged with the live in-memory chunks, sorted. */
  'transcript:get': [{ noteId: string }, TranscriptChunk[]]
  'asr:set-key': [{ provider: CloudAsrProviderId; key: string }, void]
  'asr:has-key': [{ provider: CloudAsrProviderId }, boolean]
  'asr:clear-key': [{ provider: CloudAsrProviderId }, void]
  'asr:test': [{ provider: AsrProviderId }, ProviderTestResult]
  /** Resolves at acceptance; progress arrives on `enhance:event`. */
  'enhance:generate': [GenerateRequest, { panelId: string }]
  'enhance:rewrite': [RewriteRequest, { panelId: string }]
  'enhance:title': [{ noteId: string }, TitleResult]
  'enhance:get-active': [{ noteId: string }, ActiveGeneration[]]
  'llm:set-key': [{ provider: CloudLlmProviderId; key: string }, void]
  'llm:has-key': [{ provider: CloudLlmProviderId }, boolean]
  'llm:clear-key': [{ provider: CloudLlmProviderId }, void]
  'llm:test': [{ provider: LlmProviderId }, ProviderTestResult]
  /** `anthropic`: a static list; `local`/`openai`: `GET {baseUrl}/models`. */
  'llm:list-models': [{ provider: LlmProviderId }, string[]]
  'permissions:get-state': [void, PermissionsState]
  'permissions:request-microphone': [void, PermissionsState]
  'permissions:request-system-audio': [SystemAudioRequest, PermissionsState]
  'permissions:check-system-audio': [void, SystemAudioCheck]
  'app:get-open-at-login': [void, boolean]

  // ---------- shell, meetings, trash, templates, recipes and chat ----------
  /** The app exits; it never visibly resolves. */
  'app:relaunch': [void, void]
  'update:get-state': [void, UpdateState]
  /** Restarts Notula to install a downloaded update. */
  'update:install': [void, void]
  /** Returns and clears the pending link, and records it for the 1 s guard. */
  'deeplink:get-pending': [void, DeepLinkEvent | null]
  /** For the calling bubble window. */
  'bubble:get-state': [void, BubbleState]
  /** For the calling notification window. */
  'notify:get-payload': [void, NotificationPayload | null]
  'meetings:get-mic-apps': [void, MicApp[]]
  'meetings:get-status': [void, MeetingDetectionStatus]
  'capture:get-health': [void, CaptureHealth]
  'capture:get-inactivity': [void, InactivityWarning | null]
  /** The pending prompt: at most 2 h old and not dismissed. */
  'power:get-resumed': [void, PowerResumed | null]
  /** `modelId` defaults to the local ASR model. */
  'asr:get-local-model-state': [{ modelId?: LocalModelId }, LocalModelState]
  'asr:download-local-model': [{ modelId?: LocalModelId }, LocalModelState]
  /** Deletes a downloaded model. Refused while it downloads or while a meeting is transcribing. */
  'asr:delete-local-model': [{ modelId?: LocalModelId }, LocalModelState]
  /** `app.getPreferredSystemLanguages()`. */
  'system:get-languages': [void, string[]]
  'notes:list-trash': [void, TrashItem[]]
  /** Rejects `invalid-input` without `confirmed` or when the note is not in Trash. */
  'notes:delete-permanently': [{ id: string; confirmed: true }, void]
  'notes:auto-delete-if-empty': [AutoDeleteRequest, AutoDeleteResult]
  'clipboard:write': [{ html: string; text: string }, void]
  'clipboard:copy-text': [{ text: string }, void]
  /** Main `capturePage(rect)` of the sender, then `clipboard.writeImage`. */
  'clipboard:write-image-rect': [{ rect: Rect }, void]
  /** Rows plus built-ins, deleted excluded. */
  'templates:list': [void, NoteTemplate[]]
  'templates:create': [NoteTemplateCreate, NoteTemplate]
  /** Rejects `invalid-input` for a built-in id. */
  'templates:update': [{ id: string; patch: NoteTemplatePatch }, NoteTemplate]
  /** Soft; rejects for a built-in. */
  'templates:delete': [{ id: string }, void]
  /** Rows plus built-ins, deleted excluded. */
  'recipes:list': [void, Recipe[]]
  'recipes:upsert': [RecipeUpsert, Recipe]
  /** Soft. */
  'recipes:delete': [{ id: string }, void]
  'recipes:restore': [{ id: string }, void]
  /** Resolves at acceptance; progress arrives on `chat:event`. */
  'chat:send-message': [ChatSendRequest, ChatSendAccepted]
  'chat:stop': [{ threadId: string }, void]
  'chat:list-threads': [ChatThreadQuery, ChatThread[]]
  'chat:get-thread': [{ threadId: string }, ChatThreadWithMessages | null]
  /** Updates a thread’s title, its pinned state, or both. */
  'chat:update-thread': [
    { threadId: string; patch: { title?: string | null; is_pinned?: boolean } },
    ChatThread
  ]
  /** Soft; its messages too. */
  'chat:delete-thread': [{ threadId: string }, void]
  'chat:update-tool-call': [ToolCallUpdate, void]

  // ---------- calendar, people, folders and search ----------
  'calendar:sources': [void, CalendarSourcesState]
  /**
   * Fetches and parses first. On failure it rejects
   * `invalid-input: Couldn't read this calendar: <reason>` and saves nothing.
   */
  'calendar:add-ics': [{ url: string; label?: string; myEmail?: string }, CalendarSource]
  /** Revokes (Google), then deletes the source's secret, calendars and events. */
  'calendar:remove-source': [{ sourceId: string }, void]
  /** An empty `clientId` clears. The values never come back to the renderer. */
  'calendar:set-oauth-client': [
    { provider: OAuthCalendarProvider; clientId: string; clientSecret?: string },
    void
  ]
  /**
   * Loopback + PKCE; `sourceId` = Reconnect. Rejects `busy` while a flow runs,
   * `missing-key` with no client id, `provider-error: Connection timed out` or
   * `provider-error: Access was not granted`.
   */
  'calendar:connect': [{ provider: OAuthCalendarProvider; sourceId?: string }, CalendarSource]
  'calendar:calendars': [void, CalendarInfo[]]
  /** Hiding deletes that calendar's events, then refreshes. */
  'calendar:set-visible': [{ calendarId: string; visible: boolean }, void]
  /** Each account's primary calendar only; ICS calendars stay on. */
  'calendar:reset-visible': [void, void]
  /** Resolves once queued. */
  'calendar:refresh': [{ trigger: 'home-view' | 'manual' }, void]
  /** Deduped, timed events, by start. */
  'calendar:range': [{ from: IsoTime; to: IsoTime }, CalendarEvent[]]
  'calendar:upcoming': [{ page: number }, UpcomingPage]
  'calendar:join': [{ url: string; calendarId?: string | null }, { opened: boolean }]
  /** At most 5, ranked for the query. */
  'people:participants': [{ query: string; noteId?: string }, Participant[]]
  'folders:list': [void, FoldersState]
  /** Rejects `invalid-input` for a third level. */
  'folders:create': [FolderCreate, Folder]
  /** `is_favourite` cascades to descendants; a `parent_id` change is validated. */
  'folders:update': [{ id: string; patch: FolderPatch }, Folder]
  /** Lifts subfolders to the parent; never touches notes. */
  'folders:delete': [{ id: string; confirmed: true }, void]
  /** Idempotent; records a use (`folders.useTimestamps`). */
  'folders:add-notes': [{ folderId: string; noteIds: string[]; source: FolderNoteSource }, { added: number }]
  'folders:remove-note': [{ folderId: string; noteId: string }, void]
  /** Replaces the rule for the same series in that folder. */
  'folders:set-rule': [FolderRuleInput, FolderRule]
  'folders:delete-rule': [{ id: string }, void]
  'folders:suggest': [{ noteId: string }, FolderSuggestion | null]
  'search:query': [{ query: string }, SearchResponse]

  // ---------- feature channels ----------
  // Speaker attribution, name suggestions, recordings, imports
  'attribution:get-status': [void, AttributionStatus]
  /** Named rows first, in `position` order. */
  'speaker-names:list': [{ noteId: string }, SpeakerNameSuggestion[]]
  'speaker-names:accept': [SpeakerNameAccept, { chunksNamed: number }]
  'speaker-names:reject': [{ noteId: string; identityKey: string }, void]
  'recordings:list': [{ noteId: string }, RecordingInfo[]]
  /** Main shows the folder dialog; `[]` when cancelled. */
  'recordings:export': [{ noteId: string }, { paths: string[] }]
  'recordings:delete': [{ noteId: string } | { recordingId: string }, void]
  'recordings:usage': [void, RecordingsUsage]
  /** Rejects `invalid-input` without `confirmed`. */
  'recordings:delete-all': [{ confirmed: true }, void]
  /** Each job carries its validation error, if any. */
  'imports:start': [{ paths: string[] }, ImportJob[]]
  'imports:list': [void, ImportJob[]]
  'imports:dismiss': [{ jobId: string }, void]
  // Attachments, action items, tags, follow-up email
  'attachments:add-images': [{ noteId: string; files: AttachmentInput[] }, AddImagesResult]
  'attachments:add-files': [
    { parentType: 'chat_thread' | 'folder'; parentId: string; files: AttachmentInput[] },
    AddFilesResult
  ]
  'attachments:list': [{ parentType: AttachmentParentType; parentId: string }, AttachmentInfo[]]
  'attachments:remove': [{ attachmentId: string }, void]
  'attachments:read': [{ attachmentId: string }, AttachmentBytes]
  'attachments:copy-image': [{ attachmentId: string }, void]
  'attachments:save-as': [{ attachmentId: string }, { saved: boolean }]
  'attached-links:update': [{ noteId: string; links: AttachedLink[] }, void]
  'action-items:list': [ActionItemsQuery, ActionItem[]]
  'action-items:review': [{ id: string; reviewStatus: ActionItemReview }, ActionItem]
  'action-items:archive': [{ id: string }, void]
  'action-items:feedback': [ActionItemFeedbackInput, ActionItemFeedback]
  'action-items:regenerate-preview': [void, { runId: string }]
  'action-items:apply-regenerated': [{ runId: string }, { insertedCount: number }]
  'tags:classify': [{ noteId: string }, { tags: DocumentTag[] }]
  'follow-up:get': [{ noteId: string }, FollowUpDraft | null]
  'follow-up:generate': [{ noteId: string }, { runId: string; draftId: string }]
  'follow-up:rewrite': [
    { draftId: string; instruction: string; referencedText?: string },
    { subject: string; body: string }
  ]
  'follow-up:update': [{ draftId: string; patch: FollowUpDraftPatch }, FollowUpDraft]
  'follow-up:handoff': [{ draftId: string; mode: 'mail-app' | 'copy' }, FollowUpHandoffResult]
  'follow-up:discard': [{ draftId: string }, void]
  /** With the suggestion rules applied. */
  'follow-up:list-suggested': [void, FollowUpDraft[]]
  // Recipe usage, people, companies, quick ask
  'recipes:usage': [void, RecipesUsage]
  /** Rejects `invalid-input` for a non-built-in id. */
  'recipes:save': [{ recipeId: string }, void]
  'recipes:unsave': [{ recipeId: string }, void]
  'people:list': [PeopleQuery, PersonRow[]]
  'people:get': [{ email: string }, PersonDetail | null]
  'companies:list': [CompaniesQuery, CompanyRow[]]
  'companies:get': [{ domain: string }, CompanyDetail | null]
  'companies:icon': [{ domain: string }, CompanyIcon | null]
  /** Returns and clears. */
  'quick-ask:get-pending': [void, QuickAskMessage | null]
  'quick-ask:get-status': [void, QuickAskStatus]
  // Captions, briefs, demo, screen snapshots, bubble snapshots, screen-recording guide
  /** For the caller: the captions window or the bubble panel. */
  'captions:get-state': [void, CaptionsState]
  'captions:set-enabled': [{ noteId: string; enabled: boolean }, void]
  /** The calling captions window. */
  'captions:set-mode': [{ mode: 'compact' | 'expanded'; searching: boolean }, void]
  'briefs:get': [{ eventId: string }, PrepBrief | null]
  'briefs:ensure': [{ eventId: string }, { status: BriefEnsureStatus }]
  'demo:start': [void, { noteId: string }]
  'demo:is-active': [void, boolean]
  'demo:get-state': [void, DemoState]
  /** Notula's own windows excluded. */
  'screen-snapshots:list-sources': [void, ScreenSource[]]
  'screen-snapshots:start': [
    { noteId: string; sourceId: string },
    { status: 'started' | 'permission-denied' | 'source-gone' | 'disabled' }
  ]
  'screen-snapshots:stop': [{ noteId: string; reason: 'user' | 'meeting-ended' | 'source-gone' }, void]
  'screen-snapshots:get-state': [{ noteId: string }, ScreenSnapshotsState]
  'bubble:take-snapshot': [{ noteId: string }, BubbleSnapshotResult]
  'screen-guide:get-config': [void, { appName: string }]
  // Integrations
  'integrations:status': [{ provider?: IntegrationProvider }, IntegrationStatus[]]
  /** Main validates and stores; the value never comes back. */
  'integrations:set-credential': [IntegrationCredentialInput, IntegrationStatus]
  'integrations:remove-credential': [{ provider: IntegrationProvider; destinationId?: string }, void]
  'integrations:validate': [{ provider: IntegrationProvider }, IntegrationStatus]
  'integrations:list-destinations': [
    { provider: IntegrationProvider; refresh?: boolean },
    IntegrationDestination[]
  ]
  'integrations:save-destination': [IntegrationDestinationInput, IntegrationDestination]
  'integrations:test-destination': [{ destinationId: string }, IntegrationDelivery]
  'integrations:search': [IntegrationSearchQuery, IntegrationSearchResult[]]
  'integrations:share': [IntegrationShareRequest, { deliveryIds: string[] }]
  'integrations:list-automations': [
    { folderId?: string; provider?: IntegrationProvider },
    IntegrationAutomation[]
  ]
  'integrations:set-automation': [IntegrationAutomationInput, IntegrationAutomation]
  'integrations:list-deliveries': [
    { provider?: IntegrationProvider; noteId?: string; limit: number },
    IntegrationDelivery[]
  ]
  'integrations:retry-delivery': [{ deliveryId: string }, IntegrationDelivery]
  /** Rejects `invalid-input` unless `scheduled` or `pending`. */
  'integrations:cancel-delivery': [{ deliveryId: string }, IntegrationDelivery]
  /* 268b */ 'integrations:slack-draft': [{ noteId: string; panelId: string | null; panelText: string }, { text: string | null }]
  // MCP client, local MCP server, dictation
  'mcp:list-servers': [void, McpServerInfo[]]
  /** Connects at once. */
  'mcp:add-server': [McpServerInput, McpServerInfo]
  'mcp:update-server': [{ id: string; patch: McpServerPatch }, McpServerInfo]
  'mcp:remove-server': [{ id: string }, void]
  'mcp:reconnect-server': [{ id: string }, McpServerInfo]
  'mcp:list-tools': [{ id: string }, McpToolInfo[]]
  'mcp:set-tool-policy': [McpPolicyChange, McpServerInfo]
  /** The stdio stderr ring (200 KB). */
  'mcp:get-log': [{ id: string }, { text: string }]
  'mcp-server:get-status': [void, McpLocalServerStatus]
  'mcp-server:set-config': [McpLocalServerConfig, McpLocalServerStatus]
  /** An `http` token; the only time it is shown. */
  'mcp-server:create-token': [{ name: string }, { id: string; token: string }]
  /** Never a token value. */
  'mcp-server:list-tokens': [void, McpLocalServerToken[]]
  'mcp-server:revoke-token': [{ id: string }, void]
  /** Creates a new `stdio` token and embeds it. */
  'mcp-server:get-stdio-config': [{ name: string }, McpStdioConfig]
  /** The last 50, memory only. */
  'mcp-server:get-activity': [void, McpLocalServerActivity[]]
  'dictation:get-status': [void, DictationStatus]
  /** Validates through `ctx.shortcuts`. */
  'dictation:set-shortcut': [{ accelerator: string | null }, { ok: boolean; error: string | null }]
  'dictation:history-list': [void, DictationAttempt[]]
  'dictation:history-delete': [{ id: string }, void]
  'dictation:history-clear': [{ confirmed: true }, void]
  'dictation:history-retry': [{ id: string }, DictationAttempt]
  'dictation:chat-start': [{ deviceId?: string }, { sessionId: string }]
  'dictation:chat-stop': [{ sessionId: string }, { text: string }]
  // Network Doctor, scratchpad, window modes, diagnostics, shortcuts, data export
  /** Rejects `busy` while a run is in flight. */
  'netdoctor:run': [void, NetDoctorReport]
  'netdoctor:cancel': [void, void]
  /** Today plus earlier days with text, newest first. */
  'scratchpad:list-days': [void, ScratchpadDaySummary[]]
  'scratchpad:get-day': [{ date: string }, ScratchpadDay]
  'scratchpad:save-day': [{ date: string; content: unknown }, { updatedAt: IsoTime }]
  'window:get-mode': [void, { mode: WindowMode }]
  'diag:export-logs': [void, { path: string } | { cancelled: true }]
  /** Rejects `busy` while a trace runs. */
  'diag:trace-start': [void, { ok: boolean }]
  /** macOS; elsewhere `{ running: false, path: null, supported: false }`. */
  'diag:unified-log-toggle': [void, UnifiedLogStatus]
  'diag:unified-log-status': [void, UnifiedLogStatus]
  'shortcuts:list': [void, ShortcutRow[]]
  'shortcuts:set': [{ id: CustomisableShortcutId; accelerator: string | null }, { ok: boolean; error: string | null }]
  'export:choose-folder': [void, { path: string } | { cancelled: true }]
  /**
   * Rejects `invalid-input` without `confirmedPlaintext` (when any plaintext choice is on),
   * without `confirmedDecryptedDb` (when `decryptedDb`), for a folder `export:choose-folder` did not
   * return, or in a recovery state; `busy` while an export runs.
   */
  'export:start': [DataExportRequest, { exportId: string }]
  'export:cancel': [{ exportId: string }, void]

  // ---------- privacy, workflows, Labs and the meeting windows ----------
  'consent:get-status': [{ noteId: string }, ConsentStatus | null]
  /** User-initiated "Post again"; never automatic. */
  'consent:post-now': [{ noteId: string }, ConsentStatus]
  'consent:copy-message': [{ noteId?: string }, { ok: boolean }]
  /** Records `confirmed`. */
  'consent:mark-posted': [{ noteId: string }, ConsentStatus]
  'consent:resolve-pending': [{ noteId: string; action: 'start-now' | 'cancel' }, void]
  'voiceprint:get-status': [void, VoiceprintStatus]
  /** Resolves when `durationMs` of audio has arrived on `voiceprint:sample-audio`, or on cancel. */
  'voiceprint:record-sample': [{ sessionId: string; durationMs: number }, VoiceprintSampleResult]
  /** Refused while `voiceprint.enabled` is off. */
  'voiceprint:set-passive': [{ enabled: boolean }, VoiceprintStatus]
  /** "This was an in-person meeting". */
  'voiceprint:identify-note': [{ noteId: string }, VoiceprintIdentifyResult]
  'voiceprint:forget': [void, { ok: boolean }]
  'transcript-report:create': [TranscriptReportInput, { id: string }]
  'transcript-report:list': [{ noteId?: string }, TranscriptReport[]]
  'transcript-report:delete': [{ id: string }, { ok: boolean }]
  /** Main's folder dialog; JSON. */
  'transcript-report:export': [{ noteId?: string; confirmedPlaintext: true }, { path: string } | { cancelled: true }]
  'retention:get': [void, RetentionState]
  'retention:preview': [{ hours: RetentionHours }, RetentionPreview]
  /** Rejects `invalid-input` for a more-deleting change without `confirmed`. */
  'retention:set': [{ hours: RetentionHours | null; confirmed?: true }, RetentionState]
  'retention:cancel-pending': [void, RetentionState]
  /** The newest 20. */
  'retention:get-log': [void, RetentionRun[]]
  /** Rejects `invalid-input` over 500 ids or without `confirmed`; `busy: Stop the transcript first` while that note captures. */
  'transcript:delete-sections': [{ noteId: string; chunkIds: string[]; confirmed: true }, { deleted: number }]
  'meeting-dock:show': [void, void]
  /** Hidden for this capture. */
  'meeting-dock:close': [void, void]
  'meeting-dock:get-state': [void, MeetingDockState]
  'meeting-dock:history-get': [{ noteId: string }, MeetingDockHistory | null]
  'meeting-dock:history-save': [MeetingDockHistory, void]
  'live-context:get-card': [void, LiveContextCard | null]
  'live-context:open-draft': [{ cardId: string }, { opened: boolean; reason: 'local-only' | 'no-calendar' | null }]
  'reminders:list-active': [void, Reminder[]]
  /** The card window only. */
  'reminder-cards:get-state': [void, ReminderCardsState]
  'tasks:list': [{ showCompleted: boolean; includeOlder: boolean }, TasksList]
  /** A stale path is a no-op. */
  'tasks:toggle': [TaskToggle, void]
  'tasks:add': [{ text: string }, ManualTask]
  /** Manual tasks only. */
  'tasks:delete': [{ id: string }, void]
  'tasks:get-badge': [void, { openCount: number }]
  'summary-feedback:eligibility': [{ panelId: string }, { show: boolean }]
  'summary-feedback:shown': [{ panelId: string }, void]
  'summary-feedback:rate': [{ panelId: string; direction: SummaryFeedbackDirection; comment?: string }, SummaryFeedback]
  'summary-feedback:dismiss': [{ panelId: string }, void]
  'summary-feedback:list': [{ templateSlug: string }, SummaryFeedbackList]
  'summary-feedback:suggest-template-edits': [{ templateSlug: string }, TemplateEditSuggestion]
  'user-context:get': [void, UserContextState]
  'user-context:update': [{ sectionId: UserContextSectionId; content: string }, UserContextSection]
  /** Returns the normalized list. */
  'user-context:set-names': [{ firstNames: string[] }, { firstNames: string[] }]
  /** Rejects `busy` while a run is in flight. */
  'user-context:draft': [{ sectionIds: UserContextSectionId[]; overwriteUser?: boolean }, { runId: string }]
  'dispatch:list': [{ view: 'today' | 'archived' | 'todos' }, DispatchList]
  'dispatch:run-note': [{ noteId: string }, void]
  'dispatch:run-morning': [void, { status: 'started' | 'busy' | 'paused' }]
  'dispatch:set-status': [{ id: string; kind: 'todo' | 'dispatch'; status: DispatchTodoStatus | DispatchStatus }, void]
  /** Creates the titled thread. */
  'dispatch:start': [{ id: string }, { threadId: string }]
  'local-api:get-status': [void, LocalApiStatus]
  /** Enabling is refused (status `error: 'local-only'`) while local-only is on. */
  'local-api:set-enabled': [{ enabled: boolean }, LocalApiStatus]
  /** Never a key or hash. */
  'local-api:list-keys': [void, LocalApiKey[]]
  /** The only time a key reaches the renderer. */
  'local-api:create-key': [LocalApiKeyInput, { id: string; key: string }]
  'local-api:update-key': [{ id: string; description?: string; scopes?: LocalApiScope[] }, LocalApiKey]
  /** Drops its open connections at once. */
  'local-api:revoke-key': [{ id: string }, LocalApiKey]
  /** Rejects `invalid-input` unless revoked or expired. */
  'local-api:delete-key': [{ id: string }, void]
  /** The last 50, memory only. */
  'local-api:get-activity': [void, LocalApiActivity[]]
  'companion-cli:get-status': [void, CompanionCliStatus]
  /** Rejects `invalid-input: The companion CLI is off` while off. */
  'companion-cli:install': [{ agentId: CompanionAgentId }, CompanionCliStatus]
  /** Same refusal. */
  'companion-cli:remove': [{ agentId: CompanionAgentId }, CompanionCliStatus]
  /** Same refusal. */
  'companion-cli:open-location': [void, void]
  'device:get-info': [void, DeviceInfo]
  /** Settings ▸ About: the bundled licence files, from the repo root in dev and resources/licenses packaged. */
  'licenses:get': [void, LicensesInfo]
  'feedback:system-info': [void, FeedbackSystemInfo]
  /** Main's save dialog; a zip. */
  'feedback:save-report': [FeedbackReportInput, { saved: boolean; path: string | null }]
  'feedback:open': [FeedbackOpenInput, { opened: boolean; shortened: boolean; reason: 'local-only' | 'not-configured' | null }]
  'app-icon:get-state': [void, AppIconState]
  /** Rejects `invalid-input` for a locked colour. */
  'app-icon:set': [{ value: AppIconValue | null }, AppIconState]
  'nux:reset': [void, void]
  /** The current version's entry unless dismissed. */
  'nux:whats-new': [void, WhatsNewEntry | null]
  'update:set-channel': [{ channel: UpdateChannel }, { ok: boolean; reason: 'no-beta-feed' | 'no-feed' | null }]
  'privacy:data-usage': [void, DataUsage]
  'privacy:local-only-status': [void, LocalOnlyStatus]
  'privacy:set-local-only': [{ enabled: boolean; confirmed: true; restoreProviders?: { asr: boolean; llm: boolean } }, { ok: boolean; reason: LocalOnlyRefusal | null }]
  'privacy:list-held-sends': [void, IntegrationDelivery[]]
  'privacy:release-held-send': [{ deliveryId: string; action: 'send' | 'discard' }, IntegrationDelivery]
  'device-lock:get-status': [void, DeviceLockStatus]
  /** Enabling needs one verification first; disabling is protected. */
  'device-lock:set-enabled': [{ enabled: boolean }, DeviceLockStatus]
  'device-lock:unlock': [void, { ok: boolean; reason: DeviceLockFailure | null }]
  'transcription-rules:list': [void, { rules: TranscriptionRule[]; internalDomains: string[] }]
  /** Validated; rejects `invalid-input: <first validation message>`. */
  'transcription-rules:save': [{ rules: TranscriptionRule[]; internalDomains: string[] }, { rules: TranscriptionRule[]; internalDomains: string[] }]
  /** A dry run. */
  'transcription-rules:decide': [{ noteId: string }, RuleDecision]
  /** Confirm acknowledges and releases the held start. */
  'transcription-rules:resolve': [{ noteId: string; decisionKey: string; choice: 'confirm' | 'decline' }, void]
  /** Runs the account's re-consent for the grant. */
  'calendar:set-grant': [{ sourceId: string; grant: CalendarGrant; enabled: boolean }, CalendarSource]
  /** Google's event palette for an account (color id → hex); a built-in copy when it can't be read. */
  'calendar:event-colors': [{ sourceId: string }, Record<string, string>]
  'blocks:get': [{ blockId: string }, WorkflowBlock]
  'blocks:list': [{ sourceType: 'chat_thread'; sourceId: string }, WorkflowBlock[]]
  'blocks:update': [BlockUpdate, WorkflowBlock | { stale: true }]
  'blocks:execute': [{ blockId: string; type: WorkflowBlockType; expectedUpdatedAt: IsoTime; options?: BlockExecuteOptions }, { block: WorkflowBlock; failure: { errorCode: string; error: string } | null } | { stale: true }]
  'automations:list': [void, AutomationRule[]]
  /** Validated; at most 50 rules. */
  'automations:save': [AutomationRuleInput, AutomationRule]
  'automations:delete': [{ id: string }, void]
  'automations:list-runs': [{ ruleId?: string; noteId?: string; status?: AutomationRunStatus; limit: number }, AutomationRun[]]
  'automations:resolve-run': [{ runId: string; choice: 'send' | 'dismiss' }, AutomationRun]
  'customer-calls:status': [void, CustomerCallsStatus]
  /** Creates the folder; turns on `tags.classify`. */
  'customer-calls:enable': [void, CustomerCallsStatus]
  /** Keeps the folder and its notes. */
  'customer-calls:disable': [void, CustomerCallsStatus]
  'customer-calls:set-exclusions': [{ emails: string[]; domains: string[] }, CustomerCallsStatus]
  'customer-calls:list-backlog': [{ days: number; classifyOlder?: boolean }, CustomerCallsBacklogNote[]]
  'customer-calls:add': [{ noteIds: string[]; remove?: boolean }, { added: number; skipped: number }]
  'customer-calls:sync-status': [{ noteIds: string[]; sync?: IntegrationProvider }, CustomerCallsSyncStatus[]]
  /** Runs the loopback flow in main. */
  'integrations:connect-oauth': [{ provider: 'salesforce' | 'dropbox' }, IntegrationStatus]
  /** Closes the listener. */
  'integrations:cancel-oauth': [{ provider: 'salesforce' | 'dropbox' }, void]
  /** No URL beyond `url_label`, no secret. */
  'webhooks:list': [void, WebhookEndpoint[]]
  /** The only reply that carries the secret. */
  'webhooks:create': [WebhookEndpointInput, { endpoint: WebhookEndpoint; signingSecret: string; test: WebhookTestResult }]
  'webhooks:update': [{ id: string } & Partial<WebhookEndpointInput> & { enabled?: boolean }, WebhookEndpoint]
  /** Deletes both secrets; disables automations that target it. */
  'webhooks:delete': [{ id: string }, void]
  'webhooks:test': [{ id: string }, WebhookTestResult]
  'webhooks:rotate-secret': [{ id: string }, { signingSecret: string }]
  'mail:status': [void, MailAccount[]]
  'mail:search-threads': [{ sourceId?: string; query?: string; personEmail?: string; max: number }, MailThread[]]
  'mail:save-draft': [MailDraftInput, { draftId: string; webUrl: string | null }]
  /** Scheduled with the 10 s undo. */
  'mail:send': [MailDraftInput, { deliveryId: string }]
  /** Wraps the outbox cancel. */
  'mail:cancel-send': [{ deliveryId: string }, IntegrationDelivery]
  'connectors:list-files-status': [void, FileConnectorStatus[]]
  'connectors:search-files': [{ connector: FileConnectorKey; query: string; limit: number }, FileSearchResult[]]
  'connectors:read-file': [{ connector: FileConnectorKey; id: string }, FileReadResult]

  // ---------- the dictation bar ----------
  /** From the pill window only. */
  /** `anchorX`: the opener's centre x, window-relative DIP (the menu centres on it). */
  'dictation-bar:action': [{ action: DictationBarAction; anchorX?: number }, void]

  // ---------- content sources (Windows; refused while locked) ----------
  'sources:get-status': [void, SourcesStatus]
  /** Recently played: at most 20, newest first, memory only. */
  'sources:list-playing': [void, PlayingItem[]]
  /**
   * Creates the note with the source (`new`), or links and opens the continued note
   * (`continue`, `noteId` required), files it and starts the feed. Rejects `invalid-input` for a
   * guess key with `continue`.
   */
  'sources:create-note': [
    { draft: SourceDraft; mode: 'new' | 'continue'; noteId?: string | null; playbackId?: string | null },
    { noteId: string; source: NoteSource; created: boolean }
  ]
  'sources:get-for-note': [{ noteId: string }, NoteSourceView | null]
  /** Link source by hand; a URL makes it `exact`. Replaces the note's source. */
  'sources:link': [{ noteId: string; draft: SourceDraft }, NoteSource]
  /** Edits, and the renderer's stamped projection (`notes_md_stamped`). */
  'sources:update': [{ noteId: string; patch: NoteSourcePatch }, NoteSource]
  'sources:unlink': [{ noteId: string }, void]
  /** Search by title. Rejects `invalid-input` while lookups aren't granted, or in local-only mode. */
  'sources:search': [{ query: string }, SourceSearchResult[]]
  /** Resolves at acceptance; progress arrives on `sources:captions-progress`. */
  'sources:fetch-captions': [{ noteId: string }, { state: SourceTrackState }]
  'sources:set-transcript-plan': [{ noteId: string; plan: Exclude<TranscriptPlan, 'pending'> }, NoteSource]
  'sources:list-series': [void, SeriesListItem[]]
  'sources:get-series': [{ seriesId: string }, SeriesDetail | null]
  /** Never renames, moves or deletes a folder. */
  'sources:update-series': [
    { seriesId: string; patch: { title?: string; folderId?: string | null; state?: SeriesState } },
    SourceSeries
  ]
  /** A channel folder's notes go back to Videos; the series becomes `paused`. */
  'sources:ungroup-series': [{ seriesId: string }, SourceSeries]
  /** `file`: a handle main handed out. `dryRun` counts without writing. */
  'sources:import-catalog': [{ seriesId: string; input: CatalogInput; dryRun?: boolean }, CatalogImportResult]
  'sources:delete-catalog': [{ seriesId: string; confirmed: true }, void]
  /** `noteIds` scopes it (a Markdown import's notes). Nothing changes until applied. */
  'sources:backfill-preview': [{ noteIds?: string[] }, BackfillPreview]
  /** `choices`: row id → index into that row's `choices`. */
  'sources:backfill-apply': [
    { previewId: string; rowIds: string[]; choices?: Record<string, number> },
    { batchId: string; applied: number }
  ]
  /** One undo per batch. */
  'sources:backfill-undo': [{ batchId: string }, { reverted: number }]
  /** Rejects `busy` while either note is open or capturing; the older note keeps its id. */
  'sources:merge-notes': [{ noteIds: [string, string]; confirmed: true }, MergeResult]
  'sources:merge-undo': [{ mergeId: string }, void]
  /** The first-use Allow / Not now, and the two Settings switches. */
  'sources:grant': [{ readHistory?: boolean; onlineLookups?: boolean }, Grant]
  'sources:tools-status': [void, ToolsStatus]
  /** Resolves at acceptance; progress arrives on `sources:tools-progress`. Refused in local-only mode. */
  'sources:tools-download': [{ confirmed: true }, ToolsStatus]
  'sources:dismiss-hint': [{ hint: SourceHint; key: string }, void]
  // The browser extension's bridge
  'ext-bridge:get-status': [void, ExtBridgeStatus]
  /** Writes (on) or removes (off) the host files and the two HKCU keys. */
  'ext-bridge:set-enabled': [{ enabled: boolean }, ExtBridgeStatus]
  /** Rewrites the host files and keys. */
  'ext-bridge:repair': [void, ExtBridgeStatus]

  // ---------- import notes (Markdown and vaults; refused while locked) ----------
  'notes-import:choose-folder': [void, { handle: string } | { cancelled: true }]
  'notes-import:choose-files': [void, { handle: string } | { cancelled: true }]
  /** The scan reports on `notes-import:scan-progress`; then `notes-import:get-preview`. */
  'notes-import:scan': [{ handle: string; preset: ImportPreset }, { previewId: string }]
  'notes-import:get-preview': [{ previewId: string }, ImportPreview | null]
  /** Recomputes statuses without reading the files again. */
  'notes-import:set-options': [{ previewId: string; options: ImportOptions }, ImportPreview]
  /** Rejects `busy: An import is already running.` */
  'notes-import:start': [{ previewId: string; itemIds: string[]; options: ImportOptions }, { batchId: string }]
  'notes-import:cancel': [{ previewId: string } | { batchId: string }, void]
  'notes-import:list-batches': [void, ImportBatch[]]
  'notes-import:undo-preview': [{ batchId: string }, ImportUndoPreview]
  /** Moves the notes to Trash; deletes only the empty folders the batch created. */
  'notes-import:undo': [
    { batchId: string; noteIds: string[]; confirmed: true },
    { trashed: number; foldersDeleted: number }
  ]
  /** Keeps the notes. */
  'notes-import:clear-history': [{ confirmed: true }, void]
  'notes-import:get-candidates': [{ noteIds: string[] }, ImportCandidates[]]
}

/** send channel → payload. */
export interface SendChannels {
  /** A per-key merge; the result arrives on `prefs:changed`. */
  'prefs:set': SettingsPatch
  'capture:set-desired-state': DesiredCaptureState
  'capture:event': CaptureEngineEvent
  'power:prevent-display-sleep': void
  'power:allow-display-sleep': void
  'input:set-preference': InputPreference
  'system:open-sound-settings': void
  'system:open-privacy-settings': { target: PrivacySettingsTarget }
  'onboarding:set-state': { inOnboarding: boolean }
  /** Main forwards it as the `settings:open` push to the main window. */
  'settings:open': { section?: SettingsSection }
  'app:set-open-at-login': { enabled: boolean }
  'app:set-theme': { theme: ThemeSetting; resolved: 'light' | 'dark' }

  // ---------- shell, meetings, trash, templates, recipes and chat ----------
  /** The renderer throttles it to at most one per 30 s. */
  'app:user-interacted': void
  /** On route change and on window show/hide. */
  'app:viewing-note': { noteId: string | null }
  'update:delay': { reason: UpdateDelayReason }
  /** From the main window only; others are ignored. */
  'bubble:set-document': BubbleDocument | null
  'bubble:drag-start': void
  'bubble:drag-end': void
  'bubble:open-note': { noteId: string }
  'notify:action': { id: string; action: NotificationAction }
  'notify:content-height': { id: string; height: number }
  'notify:menu-open': { id: string; open: boolean }
  'capture:inactivity-action': { noteId: string; action: InactivityAction }
  'power:dismiss-resumed': { noteId: string; resumed: boolean }
  /** Main memory only. */
  'templates:set-note-template': { noteId: string; templateId: string | null }

  // ---------- calendar, people, folders and search ----------
  /** On NoteAttendees mount, unmount and event change. */
  'calendar:viewing-event': { eventId: string | null }

  // ---------- feature channels ----------
  'quick-ask:send': { message: string }
  'quick-ask:close': void
  'demo:join': { noteId: string; mode: DemoMode }
  'demo:close': void
  /** Pause / Resume. */
  'demo:set-playing': { playing: boolean }
  'screen-snapshots:open-picker': { noteId: string }
  'snapshot-region:ready': void
  /** Display coordinates, DIP. */
  'snapshot-region:done': Rect
  'snapshot-region:cancel': void
  /** A no-op on Windows. */
  'screen-guide:open': void
  'screen-guide:dismiss': void
  'screen-guide:ready': void
  'screen-guide:start-drag': { iconDataUrl?: string }
  /** While the settings page records a shortcut. */
  'dictation:suspend-shortcut': { suspended: boolean }
  /** 16 kHz s16le mono. */
  'dictation:audio': { sessionId: string; pcm: Uint8Array }
  'dictation:capture-event': { sessionId: string; type: 'ready' | 'error'; error?: DictationMicError }
  'dictation:pill-action': {
    action: 'finish' | 'cancel' | 'click' | 'show-settings' | 'hover' | 'retry' | 'open-history' | 'dismiss'
    hovered?: boolean
  }
  'dictation:chat-cancel': { sessionId: string }
  /** The bar's interactive rectangles, DIP, window-relative. */
  'dictation-bar:hit-rects': { rects: DictationBarRect[] }
  /** Horizontal drag along the bottom edge; `screenX` in DIP. */
  'dictation-bar:drag': { phase: 'start' | 'move' | 'end'; screenX: number }
  /** From the menu overlay: the picked row, or null for a click outside the panel. */
  'dictation-bar:menu-pick': { id: string | null }
  /** Main applies the Reposition switch to `join`. */
  'window:mode': { mode: WindowMode; reason?: WindowModeReason }
  'window:ensure-min-width': { width: number }
  /** `src`: an app-bundled image path. */
  'window:preview-show': { src: string; width: number; height: number }
  'window:preview-hide': void
  'window:preview-ready': void
  'window:preview-loaded': void
  'screen-corner:click': void
  'diag:show-logs-folder': void

  // ---------- privacy, workflows, Labs and the meeting windows ----------
  /** 16 kHz s16le mono. */
  'voiceprint:sample-audio': { sessionId: string; pcm: Uint8Array }
  'voiceprint:cancel-sample': { sessionId: string }
  /** Screen DIP; main clamps. */
  'meeting-dock:set-bounds': Rect
  'meeting-dock:set-view': { expanded: boolean; view: MeetingDockView }
  'live-context:dismiss': { cardId: string }
  'live-context:set-ignore-mouse': { ignore: boolean }
  /** A local debug line only. */
  'live-context:rate': { cardId: string; rating: 'good' | 'bad' }
  'reminders:act': { reminderId: string; actionId: string }
  'reminders:dismiss': { reminderId: string }
  /** The card window only. */
  'reminder-cards:action': { reminderId: string; actionId: string }
  'reminder-cards:set-ignore-mouse': { ignore: boolean }
  /** Capped by the work area. */
  'reminder-cards:resize': { height: number }
  'device:reveal-data-folder': void
  'licenses:open-folder': void
  'nux:dismiss': { id: string }
  'nux:increment': { id: string }
}

/** push channel → payload. */
export interface PushChannels {
  'storage:status-changed': StorageStatus
  'notes:changed': NotesChanged
  'notes:new-requested': NewNoteRequest
  'notes:new-blocked': void
  'ydoc:updated': YdocUpdated
  'prefs:changed': { keys: SettingKey[]; settings: Settings }
  'capture:system-state': CaptureSystemState
  'capture:command': CaptureCommand
  'capture:volume': { source: AudioSource; rms: number }
  'capture:system-source-changed': { label: string | null }
  'capture:stop-requested': { reason: StopReason }
  'input:state-changed': InputSelectionState | null
  'input:devices-changed': InputDevice[]
  'input:active-device-changed': { deviceId: string | null; label: string | null }
  'transcription:session-state': TranscriptionSessionInfo | null
  'transcript:changed': TranscriptChanged
  'enhance:event': EnhanceEvent
  'permissions:changed': PermissionsState
  /** Sent when a window asks for Settings (`settings:open`) and by the Settings… menu item. */
  'settings:open': { section?: SettingsSection }

  // ---------- shell, meetings, trash, templates, recipes and chat ----------
  'update:state': UpdateState
  /** Sent for `notula://` links, and for bubble and notification clicks. */
  'deeplink:received': DeepLinkEvent
  'deeplink:unsupported': DeepLinkUnsupported
  /** To the bubble and the main window. */
  'bubble:shown': { visible: boolean }
  'bubble:hovered': { hovered: boolean }
  'bubble:note': BubbleDocument | null
  'notify:animate-out': { id: string }
  'meetings:mic-apps-changed': MicApp[]
  'capture:health': CaptureHealth
  'capture:inactivity': InactivityWarning | null
  'power:resumed': PowerResumed
  /** At most one per 250 ms per model; the final state is always sent. */
  'asr:local-model-state-changed': LocalModelState
  'templates:changed': { ids: string[] }
  'recipes:changed': { ids: string[] }
  'chat:event': ChatEvent
  'chat:changed': { threadIds: string[] }

  // ---------- calendar, people, folders and search ----------
  /** After every calendar write: sync, visibility, removal. */
  'calendar:changed': { sourceIds: string[] }
  'folders:changed': { folderIds: string[] }

  // ---------- feature channels ----------
  'attribution:status-changed': AttributionStatus
  'attribution:active-speaker': { noteId: string; participantName: string | null }
  'speaker-names:changed': { noteId: string }
  'imports:changed': ImportJob
  /**
   * The media-worker window only: a transferred MessagePort with no payload, sent with
   * `webContents.postMessage`. Not a bridge member: the preload forwards the port to the
   * page with `window.postMessage({ type: 'notula:media-port' }, '*', ports)`.
   */
  'imports:media-port': void
  'attachments:changed': { parentType: AttachmentParentType; parentId: string }
  'action-items:regenerate-progress': ActionItemsRegenerateEvent
  'action-items:changed': { noteIds: string[] }
  'follow-up:progress': { runId: string; noteId: string; step: 'drafting' }
  'follow-up:result': { runId: string; draft: FollowUpDraft }
  'follow-up:error': { runId: string; noteId: string; message: string }
  /** People and companies, after each map rebuild. */
  'people:changed': void
  /** The quick-ask window. */
  'quick-ask:shown': { visible: boolean }
  /** The main window only. */
  'quick-ask:send-chat-message': QuickAskMessage
  'captions:state': CaptionsState
  'briefs:changed': { eventId: string; status: BriefStatus; statusMessage?: string }
  'demo:state-changed': DemoState
  'demo:closed': void
  'screen-snapshots:state': ScreenSnapshotsState
  'screen-snapshots:added': { noteId: string; attachmentId: string }
  'snapshot-region:image': { dataUrl: string; scaleFactor: number }
  'screen-guide:layout': ScreenGuideLayout
  'screen-guide:closed': void
  'integrations:changed': { provider: IntegrationProvider }
  'integrations:delivery': IntegrationDelivery
  'mcp:changed': { ids: string[] }
  'mcp-server:changed': McpLocalServerStatus
  /** The pill window. */
  'dictation:state': DictationState
  /** The pill window. */
  'dictation:capture': DictationCaptureCommand
  'dictation:history-changed': void
  'netdoctor:progress': { completed: number; total: number }
  'scratchpad:changed': { date: string; sourceWebContentsId: number }
  'window:mode-changed': { mode: WindowMode }
  /** The preview window only. */
  'window:preview-src': { src: string }
  /** The screen-corner panel only. */
  'screen-corner:visible': { visible: boolean }
  'diag:trace-state': { state: 'started' | 'stopped' | 'error'; path: string | null }
  'shortcuts:changed': void
  'export:progress': DataExportProgress
  'export:done': DataExportDone

  // ---------- privacy, workflows, Labs and the meeting windows ----------
  'consent:status-changed': ConsentStatus
  'voiceprint:sample-progress': { sessionId: string; elapsedMs: number; level: number }
  'voiceprint:status-changed': VoiceprintStatus
  'retention:changed': RetentionState
  /** The meeting-dock window. */
  'meeting-dock:state': MeetingDockState
  /** The card window. */
  'live-context:card': LiveContextCard | null
  'reminders:changed': void
  'reminder-cards:cards': ReminderCardsState
  /** That card's window. */
  'notify:last-time': { notificationId: string; lastTime: LastTimeRecap }
  'tasks:changed': void
  'user-context:draft-progress': UserContextDraftEvent
  'user-context:changed': void
  'dispatch:changed': void
  'local-api:changed': LocalApiStatus
  'privacy:local-only-changed': LocalOnlyStatus
  'device-lock:changed': DeviceLockStatus
  'transcription-rules:decision': RuleDecision
  'blocks:changed': { blockId: string }
  'automations:changed': { ruleIds: string[] }
  'webhooks:changed': { ids: string[] }

  // ---------- the dictation bar ----------
  /** The pill window. */
  'dictation-bar:state': DictationBarState
  /** The menu overlay. */
  'dictation-bar:menu': DictationBarMenu
  'shortcuts:hook-status': HookStatus

  // ---------- content sources ----------
  'sources:status-changed': SourcesStatus
  'sources:playing-changed': PlayingItem[]
  /** About once a second while a source note is open and bound to the playing video. */
  'sources:position': SourcePosition
  /** Sources, series, catalogs or spans changed. */
  'sources:changed': { noteIds: string[]; seriesIds: string[] }
  'sources:captions-progress': { noteId: string; state: SourceTrackState; reason: string | null }
  'sources:tools-progress': ToolsStatus
  /** Mark this moment: the main window appends an empty stamped paragraph to that note. */
  'sources:mark': SourceMark
  'ext-bridge:status-changed': ExtBridgeStatus

  // ---------- import notes ----------
  'notes-import:scan-progress': ImportScanProgress
  'notes-import:progress': ImportProgress
  'notes-import:changed': ImportBatch
}

export type InvokeChannel = keyof InvokeChannels
export type SendChannel = keyof SendChannels
export type PushChannel = keyof PushChannels
/** Every channel name. */
export type Channel = InvokeChannel | SendChannel | PushChannel

export type InvokeReq<C extends InvokeChannel> = InvokeChannels[C][0]
export type InvokeRes<C extends InvokeChannel> = InvokeChannels[C][1]
export type SendPayload<C extends SendChannel> = SendChannels[C]
export type PushPayload<C extends PushChannel> = PushChannels[C]

export type Unsubscribe = () => void

/** A bridge member for an invoke channel: no argument when the request is void. */
export type InvokeMember<C extends InvokeChannel> = [InvokeReq<C>] extends [void]
  ? () => Promise<InvokeRes<C>>
  : (req: InvokeReq<C>) => Promise<InvokeRes<C>>

/** A bridge member for a send channel: no argument when the payload is void. */
export type SendMember<C extends SendChannel> = [SendPayload<C>] extends [void]
  ? () => void
  : (payload: SendPayload<C>) => void

/** A bridge member for a push channel: subscribes and returns the unsubscribe function. */
export type PushMember<C extends PushChannel> = (
  cb: [PushPayload<C>] extends [void] ? () => void : (payload: PushPayload<C>) => void
) => Unsubscribe

/** `window.notula`: the nested bridge. Members are `notula.<area>.<camelCaseVerb>`. */
export interface NotulaApi {
  app: {
    info: InvokeMember<'app:info'>
    getOpenAtLogin: InvokeMember<'app:get-open-at-login'>
    setLaunchAtLogin: SendMember<'app:set-open-at-login'>
    setTheme: SendMember<'app:set-theme'>
    relaunch: InvokeMember<'app:relaunch'>
    reportInteraction: SendMember<'app:user-interacted'>
    setViewingNote: SendMember<'app:viewing-note'>
  }
  update: {
    getState: InvokeMember<'update:get-state'>
    install: InvokeMember<'update:install'>
    delay: SendMember<'update:delay'>
    onState: PushMember<'update:state'>
    setChannel: InvokeMember<'update:set-channel'>
  }
  deeplink: {
    getPending: InvokeMember<'deeplink:get-pending'>
    onReceived: PushMember<'deeplink:received'>
    onUnsupported: PushMember<'deeplink:unsupported'>
  }
  bubble: {
    getState: InvokeMember<'bubble:get-state'>
    setDocument: SendMember<'bubble:set-document'>
    dragStart: SendMember<'bubble:drag-start'>
    dragEnd: SendMember<'bubble:drag-end'>
    openNote: SendMember<'bubble:open-note'>
    onVisible: PushMember<'bubble:shown'>
    onHover: PushMember<'bubble:hovered'>
    onDocument: PushMember<'bubble:note'>
    takeSnapshot: InvokeMember<'bubble:take-snapshot'>
  }
  notify: {
    getPayload: InvokeMember<'notify:get-payload'>
    action: SendMember<'notify:action'>
    reportHeight: SendMember<'notify:content-height'>
    setMenuOpen: SendMember<'notify:menu-open'>
    onAnimateOut: PushMember<'notify:animate-out'>
    onLastTime: PushMember<'notify:last-time'>
  }
  meetings: {
    getMicApps: InvokeMember<'meetings:get-mic-apps'>
    getStatus: InvokeMember<'meetings:get-status'>
    onMicAppsChanged: PushMember<'meetings:mic-apps-changed'>
  }
  storage: {
    getStatus: InvokeMember<'storage:get-status'>
    recover: InvokeMember<'storage:recover'>
    onStatusChanged: PushMember<'storage:status-changed'>
  }
  notes: {
    list: InvokeMember<'notes:list'>
    get: InvokeMember<'notes:get'>
    create: InvokeMember<'notes:create'>
    update: InvokeMember<'notes:update'>
    trash: InvokeMember<'notes:trash'>
    restore: InvokeMember<'notes:restore'>
    findByEvent: InvokeMember<'notes:find-by-event'>
    onChanged: PushMember<'notes:changed'>
    onNewRequested: PushMember<'notes:new-requested'>
    onNewBlocked: PushMember<'notes:new-blocked'>
    listTrash: InvokeMember<'notes:list-trash'>
    deletePermanently: InvokeMember<'notes:delete-permanently'>
    autoDeleteIfEmpty: InvokeMember<'notes:auto-delete-if-empty'>
  }
  clipboard: {
    write: InvokeMember<'clipboard:write'>
    writeText: InvokeMember<'clipboard:copy-text'>
    writeImageRect: InvokeMember<'clipboard:write-image-rect'>
  }
  ydoc: {
    load: InvokeMember<'ydoc:load'>
    append: InvokeMember<'ydoc:append'>
    onUpdated: PushMember<'ydoc:updated'>
  }
  panels: {
    list: InvokeMember<'panels:list'>
    update: InvokeMember<'panels:update'>
  }
  prefs: {
    get: InvokeMember<'prefs:get'>
    set: SendMember<'prefs:set'>
    onChanged: PushMember<'prefs:changed'>
  }
  capture: {
    setDesiredState: SendMember<'capture:set-desired-state'>
    awaitSessionStopped: InvokeMember<'capture:await-session-stopped'>
    onSystemState: PushMember<'capture:system-state'>
    onCommand: PushMember<'capture:command'>
    sendEvent: SendMember<'capture:event'>
    onVolume: PushMember<'capture:volume'>
    onSystemSourceChanged: PushMember<'capture:system-source-changed'>
    getStatus: InvokeMember<'capture:get-status'>
    restart: InvokeMember<'capture:restart'>
    onStopRequested: PushMember<'capture:stop-requested'>
    getHealth: InvokeMember<'capture:get-health'>
    onHealth: PushMember<'capture:health'>
    getInactivity: InvokeMember<'capture:get-inactivity'>
    onInactivity: PushMember<'capture:inactivity'>
    answerInactivity: SendMember<'capture:inactivity-action'>
  }
  power: {
    preventDisplaySleep: SendMember<'power:prevent-display-sleep'>
    allowDisplaySleep: SendMember<'power:allow-display-sleep'>
    getResumed: InvokeMember<'power:get-resumed'>
    onResumed: PushMember<'power:resumed'>
    dismissResumed: SendMember<'power:dismiss-resumed'>
  }
  input: {
    getState: InvokeMember<'input:get-state'>
    setPreference: SendMember<'input:set-preference'>
    onStateChanged: PushMember<'input:state-changed'>
    onDevicesChanged: PushMember<'input:devices-changed'>
    onActiveDeviceChanged: PushMember<'input:active-device-changed'>
  }
  system: {
    openAudioSettings: SendMember<'system:open-sound-settings'>
    openPrivacySettings: SendMember<'system:open-privacy-settings'>
    getLanguages: InvokeMember<'system:get-languages'>
  }
  transcription: {
    onSessionState: PushMember<'transcription:session-state'>
  }
  transcript: {
    get: InvokeMember<'transcript:get'>
    onChanged: PushMember<'transcript:changed'>
    deleteSections: InvokeMember<'transcript:delete-sections'>
  }
  asr: {
    setKey: InvokeMember<'asr:set-key'>
    hasKey: InvokeMember<'asr:has-key'>
    clearKey: InvokeMember<'asr:clear-key'>
    test: InvokeMember<'asr:test'>
    getLocalModelState: InvokeMember<'asr:get-local-model-state'>
    downloadLocalModel: InvokeMember<'asr:download-local-model'>
    deleteLocalModel: InvokeMember<'asr:delete-local-model'>
    onLocalModelStateChanged: PushMember<'asr:local-model-state-changed'>
  }
  enhance: {
    generate: InvokeMember<'enhance:generate'>
    rewrite: InvokeMember<'enhance:rewrite'>
    generateTitle: InvokeMember<'enhance:title'>
    getActive: InvokeMember<'enhance:get-active'>
    onEvent: PushMember<'enhance:event'>
  }
  llm: {
    setKey: InvokeMember<'llm:set-key'>
    hasKey: InvokeMember<'llm:has-key'>
    clearKey: InvokeMember<'llm:clear-key'>
    test: InvokeMember<'llm:test'>
    listModels: InvokeMember<'llm:list-models'>
  }
  permissions: {
    getState: InvokeMember<'permissions:get-state'>
    requestMicrophone: InvokeMember<'permissions:request-microphone'>
    requestSystemAudio: InvokeMember<'permissions:request-system-audio'>
    checkSystemAudio: InvokeMember<'permissions:check-system-audio'>
    onChanged: PushMember<'permissions:changed'>
  }
  onboarding: {
    setState: SendMember<'onboarding:set-state'>
  }
  settings: {
    open: SendMember<'settings:open'>
    onOpen: PushMember<'settings:open'>
  }
  templates: {
    list: InvokeMember<'templates:list'>
    create: InvokeMember<'templates:create'>
    update: InvokeMember<'templates:update'>
    delete: InvokeMember<'templates:delete'>
    onChanged: PushMember<'templates:changed'>
    setNoteTemplate: SendMember<'templates:set-note-template'>
  }
  recipes: {
    list: InvokeMember<'recipes:list'>
    upsert: InvokeMember<'recipes:upsert'>
    delete: InvokeMember<'recipes:delete'>
    restore: InvokeMember<'recipes:restore'>
    onChanged: PushMember<'recipes:changed'>
    usage: InvokeMember<'recipes:usage'>
    save: InvokeMember<'recipes:save'>
    unsave: InvokeMember<'recipes:unsave'>
  }
  chat: {
    sendMessage: InvokeMember<'chat:send-message'>
    stop: InvokeMember<'chat:stop'>
    listThreads: InvokeMember<'chat:list-threads'>
    getThread: InvokeMember<'chat:get-thread'>
    updateThread: InvokeMember<'chat:update-thread'>
    deleteThread: InvokeMember<'chat:delete-thread'>
    updateToolCall: InvokeMember<'chat:update-tool-call'>
    onEvent: PushMember<'chat:event'>
    onChanged: PushMember<'chat:changed'>
  }
  calendar: {
    sources: InvokeMember<'calendar:sources'>
    addIcs: InvokeMember<'calendar:add-ics'>
    removeSource: InvokeMember<'calendar:remove-source'>
    setOAuthClient: InvokeMember<'calendar:set-oauth-client'>
    connect: InvokeMember<'calendar:connect'>
    calendars: InvokeMember<'calendar:calendars'>
    setVisible: InvokeMember<'calendar:set-visible'>
    resetVisible: InvokeMember<'calendar:reset-visible'>
    refresh: InvokeMember<'calendar:refresh'>
    range: InvokeMember<'calendar:range'>
    upcoming: InvokeMember<'calendar:upcoming'>
    join: InvokeMember<'calendar:join'>
    setViewingEvent: SendMember<'calendar:viewing-event'>
    onChanged: PushMember<'calendar:changed'>
    setGrant: InvokeMember<'calendar:set-grant'>
    eventColors: InvokeMember<'calendar:event-colors'>
  }
  people: {
    participants: InvokeMember<'people:participants'>
    list: InvokeMember<'people:list'>
    get: InvokeMember<'people:get'>
    onChanged: PushMember<'people:changed'>
  }
  folders: {
    list: InvokeMember<'folders:list'>
    create: InvokeMember<'folders:create'>
    update: InvokeMember<'folders:update'>
    delete: InvokeMember<'folders:delete'>
    addNotes: InvokeMember<'folders:add-notes'>
    removeNote: InvokeMember<'folders:remove-note'>
    setRule: InvokeMember<'folders:set-rule'>
    deleteRule: InvokeMember<'folders:delete-rule'>
    suggest: InvokeMember<'folders:suggest'>
    onChanged: PushMember<'folders:changed'>
  }
  search: {
    query: InvokeMember<'search:query'>
  }

  // ---------- feature channels ----------
  attribution: {
    getStatus: InvokeMember<'attribution:get-status'>
    onStatusChanged: PushMember<'attribution:status-changed'>
    onCurrentSpeaker: PushMember<'attribution:active-speaker'>
  }
  speakerNames: {
    list: InvokeMember<'speaker-names:list'>
    accept: InvokeMember<'speaker-names:accept'>
    reject: InvokeMember<'speaker-names:reject'>
    onChanged: PushMember<'speaker-names:changed'>
  }
  recordings: {
    list: InvokeMember<'recordings:list'>
    export: InvokeMember<'recordings:export'>
    delete: InvokeMember<'recordings:delete'>
    usage: InvokeMember<'recordings:usage'>
    deleteAll: InvokeMember<'recordings:delete-all'>
  }
  imports: {
    start: InvokeMember<'imports:start'>
    list: InvokeMember<'imports:list'>
    dismiss: InvokeMember<'imports:dismiss'>
    onChanged: PushMember<'imports:changed'>
  }
  /** Preload-only: sends nothing. */
  files: {
    /** `webUtils.getPathForFile`: dropped and picked files reach main as paths, never bytes. */
    pathForFile(file: File): string
  }
  attachments: {
    addImages: InvokeMember<'attachments:add-images'>
    addFiles: InvokeMember<'attachments:add-files'>
    list: InvokeMember<'attachments:list'>
    remove: InvokeMember<'attachments:remove'>
    read: InvokeMember<'attachments:read'>
    copyImage: InvokeMember<'attachments:copy-image'>
    saveAs: InvokeMember<'attachments:save-as'>
    onChanged: PushMember<'attachments:changed'>
  }
  attachedLinks: {
    update: InvokeMember<'attached-links:update'>
  }
  actionItems: {
    list: InvokeMember<'action-items:list'>
    review: InvokeMember<'action-items:review'>
    archive: InvokeMember<'action-items:archive'>
    feedback: InvokeMember<'action-items:feedback'>
    regeneratePreview: InvokeMember<'action-items:regenerate-preview'>
    onRegenerateProgress: PushMember<'action-items:regenerate-progress'>
    applyRegenerated: InvokeMember<'action-items:apply-regenerated'>
    onChanged: PushMember<'action-items:changed'>
  }
  tags: {
    classify: InvokeMember<'tags:classify'>
  }
  followUp: {
    get: InvokeMember<'follow-up:get'>
    generate: InvokeMember<'follow-up:generate'>
    onProgress: PushMember<'follow-up:progress'>
    onResult: PushMember<'follow-up:result'>
    onError: PushMember<'follow-up:error'>
    rewrite: InvokeMember<'follow-up:rewrite'>
    update: InvokeMember<'follow-up:update'>
    handoff: InvokeMember<'follow-up:handoff'>
    discard: InvokeMember<'follow-up:discard'>
    listSuggested: InvokeMember<'follow-up:list-suggested'>
  }
  companies: {
    list: InvokeMember<'companies:list'>
    get: InvokeMember<'companies:get'>
    icon: InvokeMember<'companies:icon'>
  }
  quickAsk: {
    onVisible: PushMember<'quick-ask:shown'>
    submit: SendMember<'quick-ask:send'>
    dismiss: SendMember<'quick-ask:close'>
    onMessage: PushMember<'quick-ask:send-chat-message'>
    getPending: InvokeMember<'quick-ask:get-pending'>
    getStatus: InvokeMember<'quick-ask:get-status'>
  }
  captions: {
    getState: InvokeMember<'captions:get-state'>
    setEnabled: InvokeMember<'captions:set-enabled'>
    setMode: InvokeMember<'captions:set-mode'>
    onState: PushMember<'captions:state'>
  }
  briefs: {
    get: InvokeMember<'briefs:get'>
    ensure: InvokeMember<'briefs:ensure'>
    onChanged: PushMember<'briefs:changed'>
  }
  demo: {
    start: InvokeMember<'demo:start'>
    join: SendMember<'demo:join'>
    close: SendMember<'demo:close'>
    isActive: InvokeMember<'demo:is-active'>
    getState: InvokeMember<'demo:get-state'>
    setPlaying: SendMember<'demo:set-playing'>
    onStateChanged: PushMember<'demo:state-changed'>
    onClosed: PushMember<'demo:closed'>
  }
  screenSnapshots: {
    listSources: InvokeMember<'screen-snapshots:list-sources'>
    openPicker: SendMember<'screen-snapshots:open-picker'>
    start: InvokeMember<'screen-snapshots:start'>
    stop: InvokeMember<'screen-snapshots:stop'>
    getState: InvokeMember<'screen-snapshots:get-state'>
    onState: PushMember<'screen-snapshots:state'>
    onAdded: PushMember<'screen-snapshots:added'>
  }
  snapshotRegion: {
    ready: SendMember<'snapshot-region:ready'>
    done: SendMember<'snapshot-region:done'>
    cancel: SendMember<'snapshot-region:cancel'>
    onImage: PushMember<'snapshot-region:image'>
  }
  screenGuide: {
    open: SendMember<'screen-guide:open'>
    dismiss: SendMember<'screen-guide:dismiss'>
    getConfig: InvokeMember<'screen-guide:get-config'>
    ready: SendMember<'screen-guide:ready'>
    startDrag: SendMember<'screen-guide:start-drag'>
    onLayout: PushMember<'screen-guide:layout'>
    onClosed: PushMember<'screen-guide:closed'>
  }
  integrations: {
    status: InvokeMember<'integrations:status'>
    setCredential: InvokeMember<'integrations:set-credential'>
    removeCredential: InvokeMember<'integrations:remove-credential'>
    validate: InvokeMember<'integrations:validate'>
    listDestinations: InvokeMember<'integrations:list-destinations'>
    saveDestination: InvokeMember<'integrations:save-destination'>
    testDestination: InvokeMember<'integrations:test-destination'>
    search: InvokeMember<'integrations:search'>
    share: InvokeMember<'integrations:share'>
    listAutomations: InvokeMember<'integrations:list-automations'>
    setAutomation: InvokeMember<'integrations:set-automation'>
    listDeliveries: InvokeMember<'integrations:list-deliveries'>
    retryDelivery: InvokeMember<'integrations:retry-delivery'>
    cancelDelivery: InvokeMember<'integrations:cancel-delivery'>
    slackDraft: InvokeMember<'integrations:slack-draft'>
    onChanged: PushMember<'integrations:changed'>
    onDelivery: PushMember<'integrations:delivery'>
    connectOAuth: InvokeMember<'integrations:connect-oauth'>
    cancelOAuth: InvokeMember<'integrations:cancel-oauth'>
  }
  mcp: {
    listServers: InvokeMember<'mcp:list-servers'>
    addServer: InvokeMember<'mcp:add-server'>
    updateServer: InvokeMember<'mcp:update-server'>
    removeServer: InvokeMember<'mcp:remove-server'>
    reconnectServer: InvokeMember<'mcp:reconnect-server'>
    listTools: InvokeMember<'mcp:list-tools'>
    setToolPolicy: InvokeMember<'mcp:set-tool-policy'>
    getLog: InvokeMember<'mcp:get-log'>
    onChanged: PushMember<'mcp:changed'>
  }
  mcpServer: {
    getStatus: InvokeMember<'mcp-server:get-status'>
    setConfig: InvokeMember<'mcp-server:set-config'>
    createToken: InvokeMember<'mcp-server:create-token'>
    listTokens: InvokeMember<'mcp-server:list-tokens'>
    revokeToken: InvokeMember<'mcp-server:revoke-token'>
    getStdioConfig: InvokeMember<'mcp-server:get-stdio-config'>
    getActivity: InvokeMember<'mcp-server:get-activity'>
    onChanged: PushMember<'mcp-server:changed'>
  }
  dictation: {
    getStatus: InvokeMember<'dictation:get-status'>
    setShortcut: InvokeMember<'dictation:set-shortcut'>
    suspendShortcut: SendMember<'dictation:suspend-shortcut'>
    onState: PushMember<'dictation:state'>
    onCapture: PushMember<'dictation:capture'>
    sendAudio: SendMember<'dictation:audio'>
    captureEvent: SendMember<'dictation:capture-event'>
    pillAction: SendMember<'dictation:pill-action'>
    /** The one nested namespace. */
    history: {
      list: InvokeMember<'dictation:history-list'>
      delete: InvokeMember<'dictation:history-delete'>
      clear: InvokeMember<'dictation:history-clear'>
      retry: InvokeMember<'dictation:history-retry'>
      onChanged: PushMember<'dictation:history-changed'>
    }
    chatStart: InvokeMember<'dictation:chat-start'>
    chatStop: InvokeMember<'dictation:chat-stop'>
    chatCancel: SendMember<'dictation:chat-cancel'>
  }
  /** The dictation bar (the pill window). */
  dictationBar: {
    onState: PushMember<'dictation-bar:state'>
    action: InvokeMember<'dictation-bar:action'>
    reportHitRects: SendMember<'dictation-bar:hit-rects'>
    drag: SendMember<'dictation-bar:drag'>
    /** The menu overlay window. */
    onMenu: PushMember<'dictation-bar:menu'>
    pickMenu: SendMember<'dictation-bar:menu-pick'>
  }
  netdoctor: {
    run: InvokeMember<'netdoctor:run'>
    cancel: InvokeMember<'netdoctor:cancel'>
    onProgress: PushMember<'netdoctor:progress'>
  }
  scratchpad: {
    listDays: InvokeMember<'scratchpad:list-days'>
    getDay: InvokeMember<'scratchpad:get-day'>
    saveDay: InvokeMember<'scratchpad:save-day'>
    onChanged: PushMember<'scratchpad:changed'>
  }
  window: {
    setMode: SendMember<'window:mode'>
    ensureMinWidth: SendMember<'window:ensure-min-width'>
    showPreview: SendMember<'window:preview-show'>
    hidePreview: SendMember<'window:preview-hide'>
    onModeChanged: PushMember<'window:mode-changed'>
    getMode: InvokeMember<'window:get-mode'>
    onPreviewSrc: PushMember<'window:preview-src'>
    previewReady: SendMember<'window:preview-ready'>
    previewLoaded: SendMember<'window:preview-loaded'>
  }
  screenCorner: {
    onVisible: PushMember<'screen-corner:visible'>
    click: SendMember<'screen-corner:click'>
  }
  diag: {
    exportLogs: InvokeMember<'diag:export-logs'>
    showLogsFolder: SendMember<'diag:show-logs-folder'>
    startTrace: InvokeMember<'diag:trace-start'>
    onTraceState: PushMember<'diag:trace-state'>
    toggleUnifiedLog: InvokeMember<'diag:unified-log-toggle'>
    unifiedLogStatus: InvokeMember<'diag:unified-log-status'>
  }
  shortcuts: {
    list: InvokeMember<'shortcuts:list'>
    set: InvokeMember<'shortcuts:set'>
    /** Row 490. */
    onHookStatus: PushMember<'shortcuts:hook-status'>
    onChanged: PushMember<'shortcuts:changed'>
  }
  dataExport: {
    chooseFolder: InvokeMember<'export:choose-folder'>
    start: InvokeMember<'export:start'>
    cancel: InvokeMember<'export:cancel'>
    onProgress: PushMember<'export:progress'>
    onDone: PushMember<'export:done'>
  }

  // ---------- privacy, workflows, Labs and the meeting windows ----------
  consent: {
    getStatus: InvokeMember<'consent:get-status'>
    onStatusChanged: PushMember<'consent:status-changed'>
    postNow: InvokeMember<'consent:post-now'>
    copyMessage: InvokeMember<'consent:copy-message'>
    markPosted: InvokeMember<'consent:mark-posted'>
    resolvePending: InvokeMember<'consent:resolve-pending'>
  }
  voiceprint: {
    getStatus: InvokeMember<'voiceprint:get-status'>
    recordSample: InvokeMember<'voiceprint:record-sample'>
    sendSampleAudio: SendMember<'voiceprint:sample-audio'>
    onSampleProgress: PushMember<'voiceprint:sample-progress'>
    cancelSample: SendMember<'voiceprint:cancel-sample'>
    setPassive: InvokeMember<'voiceprint:set-passive'>
    identifyNote: InvokeMember<'voiceprint:identify-note'>
    forget: InvokeMember<'voiceprint:forget'>
    onStatusChanged: PushMember<'voiceprint:status-changed'>
  }
  transcriptReport: {
    create: InvokeMember<'transcript-report:create'>
    list: InvokeMember<'transcript-report:list'>
    delete: InvokeMember<'transcript-report:delete'>
    export: InvokeMember<'transcript-report:export'>
  }
  retention: {
    get: InvokeMember<'retention:get'>
    preview: InvokeMember<'retention:preview'>
    set: InvokeMember<'retention:set'>
    cancelPending: InvokeMember<'retention:cancel-pending'>
    getLog: InvokeMember<'retention:get-log'>
    onChanged: PushMember<'retention:changed'>
  }
  meetingDock: {
    show: InvokeMember<'meeting-dock:show'>
    close: InvokeMember<'meeting-dock:close'>
    setBounds: SendMember<'meeting-dock:set-bounds'>
    setView: SendMember<'meeting-dock:set-view'>
    getState: InvokeMember<'meeting-dock:get-state'>
    onState: PushMember<'meeting-dock:state'>
    getHistory: InvokeMember<'meeting-dock:history-get'>
    saveHistory: InvokeMember<'meeting-dock:history-save'>
  }
  liveContext: {
    onCard: PushMember<'live-context:card'>
    getCard: InvokeMember<'live-context:get-card'>
    dismiss: SendMember<'live-context:dismiss'>
    setIgnoreMouse: SendMember<'live-context:set-ignore-mouse'>
    openDraft: InvokeMember<'live-context:open-draft'>
    rate: SendMember<'live-context:rate'>
  }
  reminders: {
    listActive: InvokeMember<'reminders:list-active'>
    act: SendMember<'reminders:act'>
    dismiss: SendMember<'reminders:dismiss'>
    onChanged: PushMember<'reminders:changed'>
  }
  reminderCards: {
    getState: InvokeMember<'reminder-cards:get-state'>
    action: SendMember<'reminder-cards:action'>
    setIgnoreMouse: SendMember<'reminder-cards:set-ignore-mouse'>
    resize: SendMember<'reminder-cards:resize'>
    onCards: PushMember<'reminder-cards:cards'>
  }
  tasks: {
    list: InvokeMember<'tasks:list'>
    toggle: InvokeMember<'tasks:toggle'>
    add: InvokeMember<'tasks:add'>
    delete: InvokeMember<'tasks:delete'>
    getBadge: InvokeMember<'tasks:get-badge'>
    onChanged: PushMember<'tasks:changed'>
  }
  summaryFeedback: {
    eligibility: InvokeMember<'summary-feedback:eligibility'>
    shown: InvokeMember<'summary-feedback:shown'>
    rate: InvokeMember<'summary-feedback:rate'>
    dismiss: InvokeMember<'summary-feedback:dismiss'>
    list: InvokeMember<'summary-feedback:list'>
    suggestTemplateEdits: InvokeMember<'summary-feedback:suggest-template-edits'>
  }
  userContext: {
    get: InvokeMember<'user-context:get'>
    update: InvokeMember<'user-context:update'>
    setNames: InvokeMember<'user-context:set-names'>
    draft: InvokeMember<'user-context:draft'>
    onDraftProgress: PushMember<'user-context:draft-progress'>
    onChanged: PushMember<'user-context:changed'>
  }
  dispatch: {
    list: InvokeMember<'dispatch:list'>
    runNote: InvokeMember<'dispatch:run-note'>
    runMorning: InvokeMember<'dispatch:run-morning'>
    setStatus: InvokeMember<'dispatch:set-status'>
    start: InvokeMember<'dispatch:start'>
    onChanged: PushMember<'dispatch:changed'>
  }
  localApi: {
    getStatus: InvokeMember<'local-api:get-status'>
    setEnabled: InvokeMember<'local-api:set-enabled'>
    listKeys: InvokeMember<'local-api:list-keys'>
    createKey: InvokeMember<'local-api:create-key'>
    updateKey: InvokeMember<'local-api:update-key'>
    revokeKey: InvokeMember<'local-api:revoke-key'>
    deleteKey: InvokeMember<'local-api:delete-key'>
    getActivity: InvokeMember<'local-api:get-activity'>
    onChanged: PushMember<'local-api:changed'>
  }
  companionCli: {
    getStatus: InvokeMember<'companion-cli:get-status'>
    install: InvokeMember<'companion-cli:install'>
    remove: InvokeMember<'companion-cli:remove'>
    openLocation: InvokeMember<'companion-cli:open-location'>
  }
  device: {
    getInfo: InvokeMember<'device:get-info'>
    revealDataFolder: SendMember<'device:reveal-data-folder'>
  }
  licenses: {
    get: InvokeMember<'licenses:get'>
    openFolder: SendMember<'licenses:open-folder'>
  }
  feedback: {
    systemInfo: InvokeMember<'feedback:system-info'>
    saveReport: InvokeMember<'feedback:save-report'>
    open: InvokeMember<'feedback:open'>
  }
  appIcon: {
    getState: InvokeMember<'app-icon:get-state'>
    set: InvokeMember<'app-icon:set'>
  }
  nux: {
    dismiss: SendMember<'nux:dismiss'>
    increment: SendMember<'nux:increment'>
    reset: InvokeMember<'nux:reset'>
    getWhatsNew: InvokeMember<'nux:whats-new'>
  }
  privacy: {
    dataUsage: InvokeMember<'privacy:data-usage'>
    localOnlyStatus: InvokeMember<'privacy:local-only-status'>
    setLocalOnly: InvokeMember<'privacy:set-local-only'>
    onLocalOnlyChanged: PushMember<'privacy:local-only-changed'>
    listHeldSends: InvokeMember<'privacy:list-held-sends'>
    releaseHeldSend: InvokeMember<'privacy:release-held-send'>
  }
  deviceLock: {
    getStatus: InvokeMember<'device-lock:get-status'>
    setEnabled: InvokeMember<'device-lock:set-enabled'>
    unlock: InvokeMember<'device-lock:unlock'>
    onChanged: PushMember<'device-lock:changed'>
  }
  transcriptionRules: {
    list: InvokeMember<'transcription-rules:list'>
    save: InvokeMember<'transcription-rules:save'>
    decide: InvokeMember<'transcription-rules:decide'>
    resolve: InvokeMember<'transcription-rules:resolve'>
    onDecision: PushMember<'transcription-rules:decision'>
  }
  blocks: {
    get: InvokeMember<'blocks:get'>
    list: InvokeMember<'blocks:list'>
    update: InvokeMember<'blocks:update'>
    execute: InvokeMember<'blocks:execute'>
    onChanged: PushMember<'blocks:changed'>
  }
  automations: {
    list: InvokeMember<'automations:list'>
    save: InvokeMember<'automations:save'>
    delete: InvokeMember<'automations:delete'>
    listRuns: InvokeMember<'automations:list-runs'>
    resolveRun: InvokeMember<'automations:resolve-run'>
    onChanged: PushMember<'automations:changed'>
  }
  customerCalls: {
    status: InvokeMember<'customer-calls:status'>
    enable: InvokeMember<'customer-calls:enable'>
    disable: InvokeMember<'customer-calls:disable'>
    setExclusions: InvokeMember<'customer-calls:set-exclusions'>
    listBacklog: InvokeMember<'customer-calls:list-backlog'>
    add: InvokeMember<'customer-calls:add'>
    syncStatus: InvokeMember<'customer-calls:sync-status'>
  }
  webhooks: {
    list: InvokeMember<'webhooks:list'>
    create: InvokeMember<'webhooks:create'>
    update: InvokeMember<'webhooks:update'>
    delete: InvokeMember<'webhooks:delete'>
    test: InvokeMember<'webhooks:test'>
    rotateSecret: InvokeMember<'webhooks:rotate-secret'>
    onChanged: PushMember<'webhooks:changed'>
  }
  mail: {
    status: InvokeMember<'mail:status'>
    searchThreads: InvokeMember<'mail:search-threads'>
    saveDraft: InvokeMember<'mail:save-draft'>
    send: InvokeMember<'mail:send'>
    cancelSend: InvokeMember<'mail:cancel-send'>
  }
  connectors: {
    listFilesStatus: InvokeMember<'connectors:list-files-status'>
    searchFiles: InvokeMember<'connectors:search-files'>
    readFile: InvokeMember<'connectors:read-file'>
  }

  // ---------- content sources and import notes ----------
  sources: {
    getStatus: InvokeMember<'sources:get-status'>
    listPlaying: InvokeMember<'sources:list-playing'>
    createNote: InvokeMember<'sources:create-note'>
    getForNote: InvokeMember<'sources:get-for-note'>
    link: InvokeMember<'sources:link'>
    update: InvokeMember<'sources:update'>
    unlink: InvokeMember<'sources:unlink'>
    search: InvokeMember<'sources:search'>
    fetchCaptions: InvokeMember<'sources:fetch-captions'>
    setTranscriptPlan: InvokeMember<'sources:set-transcript-plan'>
    listSeries: InvokeMember<'sources:list-series'>
    getSeries: InvokeMember<'sources:get-series'>
    updateSeries: InvokeMember<'sources:update-series'>
    ungroupSeries: InvokeMember<'sources:ungroup-series'>
    importCatalog: InvokeMember<'sources:import-catalog'>
    deleteCatalog: InvokeMember<'sources:delete-catalog'>
    backfillPreview: InvokeMember<'sources:backfill-preview'>
    backfillApply: InvokeMember<'sources:backfill-apply'>
    backfillUndo: InvokeMember<'sources:backfill-undo'>
    mergeNotes: InvokeMember<'sources:merge-notes'>
    mergeUndo: InvokeMember<'sources:merge-undo'>
    grant: InvokeMember<'sources:grant'>
    toolsStatus: InvokeMember<'sources:tools-status'>
    toolsDownload: InvokeMember<'sources:tools-download'>
    dismissHint: InvokeMember<'sources:dismiss-hint'>
    onStatusChanged: PushMember<'sources:status-changed'>
    onPlayingChanged: PushMember<'sources:playing-changed'>
    onPosition: PushMember<'sources:position'>
    onChanged: PushMember<'sources:changed'>
    onCaptionsProgress: PushMember<'sources:captions-progress'>
    onToolsProgress: PushMember<'sources:tools-progress'>
    onMark: PushMember<'sources:mark'>
  }
  extBridge: {
    getStatus: InvokeMember<'ext-bridge:get-status'>
    setEnabled: InvokeMember<'ext-bridge:set-enabled'>
    repair: InvokeMember<'ext-bridge:repair'>
    onStatusChanged: PushMember<'ext-bridge:status-changed'>
  }
  notesImport: {
    chooseFolder: InvokeMember<'notes-import:choose-folder'>
    chooseFiles: InvokeMember<'notes-import:choose-files'>
    scan: InvokeMember<'notes-import:scan'>
    getPreview: InvokeMember<'notes-import:get-preview'>
    setOptions: InvokeMember<'notes-import:set-options'>
    start: InvokeMember<'notes-import:start'>
    cancel: InvokeMember<'notes-import:cancel'>
    listBatches: InvokeMember<'notes-import:list-batches'>
    undoPreview: InvokeMember<'notes-import:undo-preview'>
    undo: InvokeMember<'notes-import:undo'>
    clearHistory: InvokeMember<'notes-import:clear-history'>
    getCandidates: InvokeMember<'notes-import:get-candidates'>
    onScanProgress: PushMember<'notes-import:scan-progress'>
    onProgress: PushMember<'notes-import:progress'>
    onChanged: PushMember<'notes-import:changed'>
  }
}
