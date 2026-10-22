// SPDX-License-Identifier: Apache-2.0
// Chat threads and messages.
// Stored records use snake_case field names plus the workspace and owner fields that
// keep a future multi-user build possible; requests and events are camelCase. The engine
// runs in main.

import type { IsoTime } from './common'
import type { RecipeUpsert } from './recipes'

export type ChatCreationPlatform = 'web' | 'macos' | 'ios' | 'windows' | 'android' | 'watchos' | 'mcp'
export type ChatRole = 'user' | 'assistant'
export type ChatMessageStatus = 'in_progress' | 'completed' | 'error' | 'cancelled'
/** `meeting_dock` is offered read-only tools only. */
export type ChatSurface = 'sidebar' | 'floating' | 'fullscreen' | 'quick_ask' | 'meeting_dock'

export interface DocRef {
  id: string
  title: string
}

export interface ChatThread {
  id: string
  workspace_id: string
  owner_id: string
  created_at: IsoTime
  updated_at: IsoTime
  deleted_at: IsoTime | null
  creation_platform: ChatCreationPlatform
  title: string | null
  grouping_key: string | null
  initiated_by: 'user' | 'dispatch'
  is_pinned: boolean
  /** Computed, not stored. The newest assistant message has a pending approval or question. */
  needs_input: boolean
}

export interface MeetingRef {
  id: string
  title: string
  created_at: IsoTime
}

export type ChatViewContext =
  | {
      view: 'global'
      oldestMeeting: MeetingRef | null
      newestMeeting: MeetingRef | null
      totalNotes: number
      attendedNotes: number
      sharedNotes: number
      upcomingMeetings: { id: string; title: string; start: IsoTime; attendees: string[]; creator: string | null }[]
      recentMeetings: { id: string; title: string; created_at: IsoTime; attendees: string[] }[]
    }
  | {
      view: 'search'
      query: string
      type: 'person' | 'company' | 'freeform'
      documentIds: string[]
      person?: { name: string; email: string }
      company?: { name: string; domain: string }
    }
  /** A folder page's chat (`FolderPage`). */
  | {
      view: 'list'
      folderId: string
      folderName: string
      folderDescription: string | null
      totalNotes: number
      subFolderCount: number
      oldestMeeting: MeetingRef | null
      newestMeeting: MeetingRef | null
    }
  | {
      view: 'meeting'
      meetingId: string
      selectionText: string | null
      relatedMeetings: DocRef[]
      isUpcoming: boolean
      includeUpcoming: boolean
      /** A meaningful brief while `prepBrief.inChat` is on. */
      prepBrief: PrepBriefRef | null
    }
  | {
      view: 'live-meeting'
      meetingId: string
      selectionText: string | null
      relatedMeetings: DocRef[]
      includeUpcoming: boolean
      prepBrief: PrepBriefRef | null
    }

export interface ChatContext {
  mode: 'all' | 'recent' | 'this_week' | 'last_week' | 'past_month' | 'past_quarter' | 'custom' | 'deepdive'
  activeView: ChatViewContext
  includeTranscripts: boolean
  selectedDocuments?: DocRef[]
  additionalContext?: {
    pickedNotes?: DocRef[]
    mentionedNotes?: DocRef[]
    changedBlocks?: unknown[]
  }
  /** The folder tree (from `listFolders`). */
  directoryContext?: DirectoryContext | null
}

/** One folder of `directoryContext`, with its subfolders. */
export interface DirectoryFolder {
  id: string
  name: string
  noteCount: number
  children: DirectoryFolder[]
}

/** The user's folders as the chat sees them: Favorites, then My notes. */
export interface DirectoryContext {
  sections: { name: 'Favorites' | 'My notes'; folders: DirectoryFolder[] }[]
}

export interface ChatCitation {
  message_id: string
  meeting_id: string | null
  /** The brief a `prep_brief` citation points at. */
  brief_id: string | null
  answer_line: number
  message_index?: number
  source_kind: 'transcript' | 'summary' | 'prep_brief' | 'email' | 'calendar' | 'web'
  source_quote: string | null
}

export interface ChatToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  argsDelta?: string
  renderInline: boolean
  shownInChat: boolean
  providerExecuted: boolean
  completed: boolean
  startedAtMs: number
  completedAtMs: number | null
  reverted: boolean
  error: string | null
  result: unknown
  confirmationRequired: boolean
  confirmationStatus?: 'pending' | 'confirmed' | 'cancelled'
  /** `proposedArgs` holds a write tool's arguments, or an `askUser`'s questions. */
  approval?: {
    id: string
    status: 'pending' | 'approved' | 'denied'
    reason?: string
    proposedArgs?: Record<string, unknown>
  }
  category?: ChatToolCategory
  /** The MCP server a `mcp__<server>__<tool>` call went to. */
  mcpLinkId?: string
  mcpEndpoint?: string
  mcpToolLabel?: string
}

export type ChatOutput =
  | { type: 'reasoning'; text: string; durationSeconds: number }
  | { type: 'text'; text: string }
  | {
      type: 'cited_text'
      plain_text: string
      answer_lines: { line_text: string; citations: ChatCitation[]; line_index: number }[]
    }
  | { type: 'tool_call'; tool_call: ChatToolCall }
  /** Reserved for draft previews; nothing produces it yet. */
  | { type: 'draft_preview'; draft: unknown }

export interface ChatContextSources {
  totalSources: number
  scannedDocuments: Record<string, DocRef>
  citationIds: string[]
}

export interface ChatMessage {
  id: string
  thread_id: string
  workspace_id: string
  owner_id: string
  created_at: IsoTime
  updated_at: IsoTime
  deleted_at: IsoTime | null
  role: ChatRole
  turn_index: number
  /** `AttachmentRef` items. */
  attachments: unknown[]
  raw_text: string
  context: ChatContext | null
  sources: ChatContextSources | null
  outputs: ChatOutput[] | null
  status: ChatMessageStatus
  custom_type: string | null
  trace_id: string | null
}

/** `messages` oldest first. */
export interface ChatThreadWithMessages {
  thread: ChatThread
  messages: ChatMessage[]
}

/** No `groupingKey` = every key. Dispatch-initiated threads only when asked. */
export interface ChatThreadQuery {
  groupingKey?: string
  includeDispatch?: boolean
}

/**
 * Where a chat runs. For `search`, `query` is the person's email when `type` is
 * `person` and the company's domain when it is `company` (they form the grouping key).
 */
export type ChatPlace =
  | { kind: 'global' }
  | { kind: 'meeting'; noteId: string }
  | { kind: 'search'; query: string; type: 'person' | 'company' | 'freeform'; documentIds: string[] }
  /** A folder page. */
  | { kind: 'list'; folderId: string }

/** The note editor a note chat may edit (its markdown at send time). */
export type ChatEditorTarget = { kind: 'summary'; panelId: string; markdown: string } | { kind: 'notes'; markdown: string }

export interface ChatSendRequest {
  /** A renderer UUID; also the preview's thread id. */
  requestId: string
  /** null: main creates the thread. */
  threadId: string | null
  groupingKey: string
  surface: ChatSurface
  place: ChatPlace
  text: string
  mentions: DocRef[]
  recipeId: string | null
  selectedDocuments: DocRef[]
  target: ChatEditorTarget | null
  selectionMarkdown: string | null
  editWithAi: boolean
  responseStyle: 'default' | 'detailed'
  /** Re-send from an edited user message; later messages are soft-deleted. */
  edit: { messageId: string } | null
  /**
   * A tool-approval decision. An `askUser` answer is one whose `args` is
   * `{ questions: AskUserQuestion[]; answers: Record<string, string[]> }`.
   */
  approval: {
    assistantMessageId: string
    toolCallId: string
    approvalId: string
    status: 'approved' | 'denied'
    reason?: string
    args?: Record<string, unknown>
  } | null
  /** Test recipe: streamed, never stored. */
  preview: { recipe: RecipeUpsert; noteIds: string[] } | null
  /**
   * Chat files added before this send. Files added before a chat's first
   * send are stored under the request id and re-parented to the new thread.
   */
  attachmentIds?: string[]
}

/** `chat:send-message` resolves at acceptance; progress arrives on `chat:event`. */
export interface ChatSendAccepted {
  threadId: string
  /** null for a preview or an approval-only send. */
  userMessageId: string | null
  assistantMessageId: string
}

/** Chat failures travel as `chat:event` errors, not as IPC `ErrorCode`s. */
export type ChatErrorCode = 'refusal' | 'empty-response' | 'provider-error' | 'missing-key' | 'no-model' | 'timeout'

export type ChatEvent = { threadId: string; assistantMessageId: string; requestId: string } & (
  | { type: 'text_delta'; delta: string }
  | {
      type: 'sources_progress'
      totalSources?: number
      scannedDocuments?: Record<string, DocRef>
      citationIds?: string[]
    }
  | { type: 'context_full'; attachments: { filtered: string[]; unavailable: string[]; excluded: string[] } }
  | { type: 'outputs'; outputs: ChatOutput[] }
  | { type: 'output_update'; index: number; output: ChatOutput }
  | {
      type: 'stream_done'
      outputs: ChatOutput[]
      reasoning: { text: string; durationSeconds: number } | null
      metadata: {
        finishReason: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'cancelled'
        model: string
        noTools: boolean
      }
    }
  | { type: 'error'; error: string; code: ChatErrorCode | null }
)

/** `chat:update-tool-call`: the renderer reports an edit it applied, reverted or could not apply. */
export interface ToolCallUpdate {
  threadId: string
  messageId: string
  toolCallId: string
  patch: { reverted?: boolean; error?: string | null }
}

/** The core chat tools. */
export const CHAT_CORE_TOOLS = [
  'getCurrentTime',
  'findMeetingsByTerms',
  'findMeetingsWithPeople',
  'gatherMeetingContext',
  'listMeetings',
  'getMeetings',
  'readMeetings',
  'readTranscript',
  'editNote',
  'rewriteNote'
] as const

export const CHAT_LIMITS = {
  titleCodePoints: 40,
  renameMax: 100,
  maxPinned: 10,
  floatingAutoClearMs: 7_200_000,
  maxToolRounds: 8,
  readMeetingsChars: 8_000,
  readTranscriptChars: 6_000,
  transcriptWindowChars: 1_500
} as const

/**
 * The grouping key of a place: `global`,
 * `meeting:<noteId>`, `search`, `search:person:<email>`, `search:company:<domain>`
 * or `list:<folderId>`.
 */
export function groupingKeyFor(place: ChatPlace): string {
  switch (place.kind) {
    case 'global':
      return 'global'
    case 'meeting':
      return `meeting:${place.noteId}`
    case 'search':
      return place.type === 'freeform' ? 'search' : `search:${place.type}:${place.query}`
    case 'list':
      return `list:${place.folderId}`
  }
}

// ---------- task and meeting dock threads ----------

/** Per-task threads and the meeting dock's per-note thread. */
export const TASK_GROUPING_PREFIX = 'task:'
export const MEETING_DOCK_GROUPING_PREFIX = 'meeting-dock:'

/** `task:<documentId>:<nodePath joined by '.'>` or `task:manual:<id>`. */
export function taskGroupingKey(t: { documentId: string; nodePath: number[] } | { manualId: string }): string {
  return 'manualId' in t ? `${TASK_GROUPING_PREFIX}manual:${t.manualId}` : `${TASK_GROUPING_PREFIX}${t.documentId}:${t.nodePath.join('.')}`
}

/** `meeting-dock:<noteId>`. */
export function meetingDockGroupingKey(noteId: string): string {
  return `${MEETING_DOCK_GROUPING_PREFIX}${noteId}`
}

// ---------- agentic tools, quick ask and briefs ----------

export type ChatToolCategory = 'search' | 'calendar' | 'notes' | 'email' | 'generic'

/** Items of `ChatMessage.attachments`. */
export interface AttachmentRef {
  id: string
  name: string
  mimeType: string
}

/** `ChatViewContext.prepBrief`. */
export interface PrepBriefRef {
  id: string
  shortBrief: string
  isNotable: boolean
}

export interface AskUserQuestion {
  id: string
  question: string
  options: { label: string; description: string }[]
  multiSelect?: boolean
}

export const ASK_USER_LIMITS = { questionsMin: 1, questionsMax: 3, optionsMin: 2, optionsMax: 4 } as const

/** The decision's `reason` when the user skips a question card. */
export const QUESTIONS_SKIPPED_REASON = 'The user skipped these questions.'

/** The agentic tools, plus `askUser`. */
export const CHAT_AGENTIC_TOOLS = [
  'fetchMeetings',
  'findMeetingsWithPeopleOrCompanies',
  'exploreMeetings',
  'openAttachment',
  'readEventNote',
  'appendToEventNote',
  'editEventNote',
  'list_todos',
  'show_todo_cards',
  'readPrepBrief',
  'listUpcomingEvents',
  'searchCalendar',
  'listEventsInRange',
  'findEvents',
  'readEvent',
  'findPeopleOrCompanies',
  'findPeople',
  'resolvePerson',
  'findFolders',
  'locateNotes',
  'createFolder',
  'organizeNote',
  'listFolderAttachments',
  'readFile',
  'loadRecipe',
  'askUser'
] as const

/** Write tools: they always ask for approval, since they change the user's notes or folders. */
export const WRITE_TOOLS_NEEDING_APPROVAL = ['appendToEventNote', 'editEventNote', 'createFolder', 'organizeNote'] as const

/** `quick-ask:send-chat-message` / `quick-ask:get-pending`. */
export interface QuickAskMessage {
  message: string
  chatSurface: 'quick_ask'
}

export interface QuickAskStatus {
  enabled: boolean
  registered: boolean
  accelerator: string
  error: string | null
}

/** Alt+Space opens the window menu on Windows. */
export const QUICK_ASK_SHORTCUT = { darwin: 'Alt+Space', default: 'Control+Alt+Space' } as const

export const QUICK_ASK_GEOMETRY = { width: 620, height: 104, pill: 56, blurGraceMs: 150, blurHideMs: 80 } as const
