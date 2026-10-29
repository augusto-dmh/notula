// SPDX-License-Identifier: Apache-2.0
// What index.ts hands to every module's register function: the main-only contracts.
//
// The shared services (`capture`, `transcription`, `ui`, `notify`, `enhance`, `calendar`,
// `speech`, `attachments`, `chat`, `imports`, `windowModes`, `shortcuts`, `deviceLock`,
// `promptExtras`, `meetingDock`, `integrations`, `emailContext`, `tags`) start as
// placeholders and are replaced during wiring by the module that owns them. Read them
// at call time (`ctx.notify.show(…)`), never at register time. `audioTaps` and
// `integrationPlugins` are complete from the start.

import type { BrowserWindow, BrowserWindowConstructorOptions, NativeImage, WebContents } from 'electron'
import type { SpeakerTurn } from '@shared/lib/speakers'
import type { AttachmentInfo, AttachmentParentType } from '@shared/types/attachments'
import type { CalendarGrant, CalendarSource } from '@shared/types/calendar'
import type { AudioSource, IsoTime, StopReason } from '@shared/types/common'
import type { ProtectedTarget } from '@shared/types/device-lock'
import type { RewriteRequest } from '@shared/types/enhance'
import type { IntegrationProvider, IntegrationShareRequest, IntegrationStatus } from '@shared/types/integrations'
import type { EmailContext } from '@shared/types/mail'
import type { CalendarEvent, DocumentTag, Note, NoteAttachment, ScreenShareContext } from '@shared/types/notes'
import type {
  ConferenceProvider,
  LastTimeRecap,
  NotificationAction,
  NotificationInfoAction,
  NotificationPayload,
  NotificationVariant
} from '@shared/types/notify'
import type { SecretId, SettingKey, Settings } from '@shared/types/settings'
import type { CustomisableShortcutId } from '@shared/types/shortcuts'
import type { SourceCardPayload } from '@shared/types/sources'
import type { TranscriptChunk } from '@shared/types/transcript'
import type { WindowMode, WindowModeReason } from '@shared/types/window-modes'
import type { MainBus } from './bus'
import type { ChatApi } from './chat/tool-api'
import type { IntegrationPluginsApi } from './integration-plugins'
import type { StorageApi } from './storage/api'
import type { SpeechApi } from './transcription/api'

/** API keys. Plaintext exists only in main, only while a request needs it. */
export interface SecretsApi {
  get(id: SecretId): Promise<string | null>
  set(id: SecretId, value: string): Promise<void>
  has(id: SecretId): Promise<boolean>
  clear(id: SecretId): Promise<void>
}

/** Typed preferences: defaults merged with the stored rows. */
export interface SettingsApi {
  getAll(): Promise<Settings>
  get<K extends SettingKey>(key: K): Promise<Settings[K]>
  set<K extends SettingKey>(key: K, value: Settings[K]): Promise<Settings>
}

/**
 * The windows Notula draws besides the main window. Each loads the shared bundle
 * at its route: the meeting bubble and notifications; captions, demo, snapshot picker and
 * region, and screen-guide windows; the never-shown media worker; quick ask; the dictation
 * pill; the screen corner and window preview; and the assistant windows.
 */
export type SecondaryKind =
  | 'bubble'
  | 'bubble-transcript'
  | 'bubble-inactivity'
  | 'notification'
  | 'captions'
  | 'media-worker'
  | 'demo'
  | 'snapshot-picker'
  | 'snapshot-region'
  | 'screen-guide'
  | 'screen-guide-spotlight'
  | 'quick-ask'
  | 'dictation-pill'
  | 'dictation-bar-menu'
  | 'screen-corner'
  | 'window-preview'
  // Content windows, hidden while Notula is locked
  | 'meeting-dock'
  | 'live-context'
  | 'reminder-cards'

/**
 * `windows.createSecondary` options. `webPreferences` and `show` are the factory's:
 * every secondary window gets the literal sandboxed preferences and starts hidden.
 * `route` is the window's hash route (`/bubble`, `/notification`, `/captions`, …).
 */
export type SecondaryWindowOptions = Omit<BrowserWindowConstructorOptions, 'webPreferences' | 'show'> & {
  kind: SecondaryKind
  route: string
}

export interface WindowsApi {
  main(): BrowserWindow | null
  /** Every live renderer that receives pushes. Push sites loop over it and write the literal. */
  targets(): WebContents[]
  /**
   * The only other `new BrowserWindow` in Notula. Loads `index.html#<route>`,
   * hidden; the caller shows it with `showInactive()`. External http(s) links open in
   * the browser, everything else is denied, and navigation is prevented.
   */
  createSecondary(opts: SecondaryWindowOptions): BrowserWindow
  /** Which window a renderer belongs to; null for an unknown sender. */
  kindOf(wc: WebContents): 'main' | SecondaryKind | null
  /**
   * Hides the visible CONTENT_SECONDARY_KINDS windows and remembers them; while
   * locked, `show` / `showInactive` on those kinds do nothing. Unlocking re-shows what it hid.
   */
  setContentLocked(locked: boolean): void
  /** The icon of every window now and later; null restores the default. */
  setAppIcon(image: NativeImage | null): void
}

export interface CaptureQuery {
  isCapturing(): boolean
  currentNoteId(): string | null
  /**
   * The single way main stops a meeting (sleep, inactivity, app-left, trash).
   * Stops through the same drained path as a renderer stop, pushes
   * `capture:stop-requested { reason }` so the renderer's desired state follows, and
   * resolves after the bus `capture:stopped` for that session. Resolves at once when idle.
   */
  stop(reason: StopReason): Promise<void>
  /** Runs before a fresh start and before a switch to another note, in registration order. */
  registerStartGate(g: CaptureStartGate): () => void
  /** The start that a gate is holding, if any. */
  heldStart(): { noteId: string; gateId: string } | null
  /** Runs the remaining gates, then starts. */
  releaseHeldStart(noteId: string): void
  /** Pushes `capture:stop-requested { reason }`, so the renderer's desired state goes off. */
  cancelHeldStart(noteId: string, reason: StopReason): void
  /**
   * "I'm still here" with Labs `capture.restartOnStillHere` on: restarts the note's
   * transcription session, then its capture sources. Logs and skips when the note is no
   * longer capturing; never throws.
   */
  recoverAfterInactivity(noteId: string): Promise<void>
}

/** The consent deferral and the transcription rules. */
export interface CaptureStartGate {
  id: 'consent' | 'transcription-rules'
  beforeStart(req: {
    noteId: string
    kind: 'start' | 'switch'
  }): Promise<{ result: 'proceed' } | { result: 'hold' } | { result: 'block'; reason: StopReason }>
}

/** One 16 kHz s16le mono batch, as it goes to transcription. A tap only buffers. */
export type AudioTap = (f: {
  noteId: string
  sessionId: string
  source: AudioSource
  pcm: Buffer
  captureTimeMs: number
}) => void

export interface AudioTapsApi {
  register(tap: AudioTap): () => void
}

export interface TranscriptionService {
  flush(noteId: string): Promise<void>
  liveChunks(noteId: string): TranscriptChunk[]
}

/** `registerLifecycle`: what the renderer and the window currently show. */
export interface UiStateApi {
  viewingNoteId(): string | null
  inOnboarding(): boolean
  mainWindowFocused(): boolean
  /** ms since the epoch; 0 when none yet. */
  lastInteractionAt(): number
}

/** What the lifecycle module exposes to index.ts. The launch queue drains into it. */
export interface LifecycleHooks {
  ui: UiStateApi
  onLaunchArgs(argv: string[], source: 'first-instance' | 'second-instance'): void
  onOpenUrl(url: string): void
}

/** One card for `ctx.notify.show`. */
export interface NotificationRequest {
  id?: string
  variant: NotificationVariant
  title: string
  body: string
  calendarEventId?: string | null
  eventStart?: IsoTime | null
  joinUrl?: string | null
  conferenceProvider?: ConferenceProvider | null
  micAppId?: string | null
  micAppName?: string | null
  autoStart?: boolean
  countdownMs?: number | null
  calendarColor?: string | null
  location?: string | null
  /** Copied to `NotificationPayload.detail` (a meaningful brief's headline). */
  detail?: string | null
  showDelayMs: number
  hideAfterMs: number | null
  quietWhileRecording: boolean
  allowDuringOnboarding: boolean
  /** Re-checked just before the card shows; false drops it. */
  lastMomentCheck?(): Promise<boolean>
  /** Every action except the ones the window system handles itself (hide, block, …). */
  onAction(action: NotificationAction): void
  /** Only with `variant: 'info'`; at most 3. Their clicks arrive as `info:<id>`. */
  infoActions?: NotificationInfoAction[]
  /** Only with `variant: 'source-detected'`. Its clicks arrive as `source:<action>`. */
  source?: SourceCardPayload
}

/** `registerNotify`. */
export interface NotifyApi {
  /** Queues the card, then runs the show-time checks. Returns its id. */
  show(req: NotificationRequest): string
  hide(id: string): void
  visible(): NotificationPayload[]
  /**
   * Awaited for `scheduled-meeting` cards, capped at RECAP_LIMITS.decorateWaitMs.
   * Returns the unregister function.
   */
  registerDecorator(
    d: (req: NotificationRequest & { id: string }) => Promise<{ lastTime?: LastTimeRecap | null }>
  ): () => void
  /** The card window, for `notify:last-time`. */
  cardWebContents(id: string): WebContents | null
}

/** Everything a note chat needs from enhance's prompt builder. */
export interface NoteChatInputs {
  note: Note
  /** Every summary prompt variable, plus `selection_text` when given. */
  vars: Record<string, string>
  turns: SpeakerTurn[]
  latestSummaryMarkdown: string
  latestSummaryPanelId: string | null
  latestSummaryTemplateSlug: string | null
}

/** `registerEnhance`. */
export interface EnhanceApi {
  /** `enhance:rewrite` semantics. */
  rewrite(req: RewriteRequest): Promise<{ panelId: string }>
  /** Resolves true without an LLM call while `capture.llmAutoStop` is off. */
  didMeetingEnd(noteId: string): Promise<boolean>
  noteChatInputs(
    noteId: string,
    opts: { targetMarkdown?: string; selectionMarkdown?: string | null }
  ): Promise<NoteChatInputs>
  /**
   * Stop and summarize, for the automatic stops and the floating-indicator stop. Runs the end-of-meeting preflight on the live note (no
   * summary panel yet, at least 2,500 characters of transcript; an error counts as "no
   * summary"), then calls `stop`, then, when the preflight passed, starts end-of-meeting
   * generation at once, so the note shows its generating panel from the moment of the
   * stop. The stop's `capture:stopped` generates nothing further. Resolves when
   * `stop`'s promise does, with whether a summary is being generated.
   */
  stopAndSummarize(noteId: string, stop: () => Promise<void>): Promise<{ summarizing: boolean }>
  /**
   * The end-of-meeting generation path, used by the demo meeting and by imports.
   * `transcriptText` replaces the transcript input; `fallbackMarkdown` becomes the panel
   * when no LLM is set up. Resolves `null` when nothing
   * was generated.
   */
  autoGenerate(
    noteId: string,
    opts?: { transcriptText?: string; fallbackMarkdown?: string }
  ): Promise<{ panelId: string } | null>
}

/**
 * `registerCalendar`. Until the calendar module registers, the
 * placeholder gives `[]`, `null`, `null`, `[profile.email]`, `null`, and `join` opens
 * http(s) links only, with `shell.openExternal`.
 */
export interface CalendarApi {
  /** Deduped, timed events, by start. */
  listEvents(range: { from: IsoTime; to: IsoTime }): Promise<CalendarEvent[]>
  getEvent(id: string): Promise<CalendarEvent | null>
  /** Started, not ended, not cancelled, attended; the first by start. */
  currentEvent(at?: Date): Promise<CalendarEvent | null>
  /** `profile.email`, every OAuth account email and every ICS "my email": lower-cased, unique. */
  myEmails(): Promise<string[]>
  /** From `calendar:viewing-event`, only while the main window is visible. */
  viewingEventId(): string | null
  /** The `calendar:join` routine: resolves whether a link was opened. */
  join(url: string, calendarId?: string | null): Promise<boolean>
  /** The account's held incremental grants. */
  grants(sourceId: string): Promise<CalendarGrant[]>
  /**
   * Re-runs the loopback-and-PKCE consent with the held grants plus or minus this one.
   * Rejects `invalid-input` for an ICS source.
   */
  setGrant(sourceId: string, grant: CalendarGrant, enabled: boolean): Promise<CalendarSource>
  /** Refreshes as needed; null asks only for the read scope. Throws `provider-error: <CalendarGrantError>`. */
  accessToken(sourceId: string, grant: CalendarGrant | null): Promise<string>
  refreshSource(sourceId: string): void
}


/** `registerAttachments`: note images and chat or folder files, for main-side callers. */
export interface AttachmentsApi {
  /**
   * Resizes in main with `nativeImage`, keeping the format, then stores it encrypted.
   * Rejects `invalid-input: Maximum of 10 attachments reached` only when counted.
   */
  addNoteImage(
    noteId: string,
    image: { bytes: Buffer; mimeType: 'image/png' | 'image/jpeg'; fileName?: string },
    opts?: {
      id?: string
      screenShareContext?: ScreenShareContext | null
      /** Default true. */
      countTowardLimit?: boolean
      /** Default 2,000. */
      maxSide?: number
    }
  ): Promise<NoteAttachment>
  setScreenShareContext(attachmentId: string, ctx: ScreenShareContext): Promise<void>
  remove(attachmentId: string): Promise<void>
  list(parent: { type: AttachmentParentType; id: string }): Promise<AttachmentInfo[]>
  readBytes(attachmentId: string): Promise<{ mimeType: string; bytes: Buffer } | null>
  readContent(
    attachmentId: string,
    maxChars?: number
  ): Promise<{ name: string; markdown: string | null; summary: string | null } | null>
  /**
   * Through `notula-convert`, in memory, with the attachment limits; `.doc` and `.xls` are
   * rejected (only `.docx`, `.xlsx` and PDF are parsed).
   */
  convertBytes(f: { name: string; mimeType: string; bytes: Buffer }): Promise<{ markdown: string | null; error: string | null }>
}

/** `registerImports`. */
export interface ImportsApi {
  /** The File menu's "Import recording…": main's file dialog, then the `imports:start` path. */
  promptAndStart(): Promise<void>
}

/** `registerWindowModes`. */
export interface WindowModesApi {
  mode(): WindowMode
  /**
   * A `join` reason is applied only while `window.repositionForMeetings` is on; side
   * bounds only when the call also focuses.
   */
  set(mode: WindowMode, opts?: { focus?: boolean; reason?: WindowModeReason }): Promise<void>
  /** The post-meeting timer. Enhance calls it at the end-of-meeting summary step when nothing is capturing. */
  scheduleResetAfterMeeting(): void
  cancelReset(): void
}

/** `registerShortcuts`. */
export interface ShortcutsApi {
  /** The stored accelerator, or the platform default. */
  effective(id: CustomisableShortcutId): string
  /** The error copy (reserved, modifier-only, or "Already used by <action>."), or null when valid. */
  validate(id: CustomisableShortcutId, accelerator: string): string | null
  /** Quick ask and dictation hand over the code that re-registers their global shortcut. Returns the unregister function. */
  registerApplier(
    id: Exclude<CustomisableShortcutId, 'newNote'>,
    apply: (accelerator: string) => Promise<{ ok: boolean; error: string | null }>
  ): () => void
}


/** `registerDeviceLock`. */
export interface DeviceLockApi {
  isLocked(): boolean
  /** Shows the main window's lock view and resolves after the OS prompt. */
  requestUnlock(): Promise<boolean>
  /** True at once while the lock is off. */
  confirmProtectedChange(target: ProtectedTarget): Promise<boolean>
}

/** `registerUserContext`. */
export interface PromptExtrasApi {
  summaryVars(noteId: string): Promise<{ author_context: string }>
  chatContext(): Promise<string>
  asrVocabulary(): Promise<string[]>
}

/** `registerMeetingDock`. */
export interface MeetingDockApi {
  /** On, capturing, and currently hidden. */
  isAvailable(): boolean
  show(): Promise<void>
}

/** The integration layer, for main-side callers (calendar writes, mail, files, CRM). */
export interface IntegrationsApi {
  /** The renderer's share path, from main. */
  share(req: IntegrationShareRequest): Promise<{ deliveryIds: string[] }>
  /** The provider's folder path, user-initiated, in batches of 100. */
  folderSend(q: { provider: IntegrationProvider; folderId: string; noteIds: string[] }): Promise<{ deliveryIds: string[] }>
  status(provider: IntegrationProvider): Promise<IntegrationStatus>
}

/** `registerMail`: `[]` when mail is off, without a `mail-read` grant, or local-only. */
export interface EmailContextApi {
  forEvent(eventId: string): Promise<EmailContext[]>
}

/** The tags module's `meeting-classify` path; the egress guard applies. */
export interface TagsApi {
  classify(noteId: string): Promise<DocumentTag[]>
}

export interface MainContext {
  storage: StorageApi
  secrets: SecretsApi
  settings: SettingsApi
  bus: MainBus
  windows: WindowsApi
  /** Replaced by `registerCapture(ctx)` during wiring. */
  capture: CaptureQuery
  /** Replaced by `registerTranscription(ctx)` during wiring. */
  transcription: TranscriptionService
  /** Replaced by `registerLifecycle(ctx, windows).ui` during wiring. */
  ui: UiStateApi
  /** Replaced by `registerNotify(ctx)` during wiring. */
  notify: NotifyApi
  /** Replaced by `registerEnhance(ctx)` during wiring. */
  enhance: EnhanceApi
  /** Replaced by `registerCalendar(ctx)` during wiring. */
  calendar: CalendarApi
  /** Replaced by `createSpeechApi(ctx)` during wiring. */
  speech: SpeechApi
  /** Replaced by `registerAttachments(ctx)` during wiring. */
  attachments: AttachmentsApi
  /** Replaced by `registerChat(ctx)` during wiring. */
  chat: ChatApi
  /** Replaced by `registerImports(ctx)` during wiring. */
  imports: ImportsApi
  /** Replaced by `registerWindowModes(ctx)` during wiring. */
  windowModes: WindowModesApi
  /** Replaced by `registerShortcuts(ctx)` during wiring. */
  shortcuts: ShortcutsApi
  /** Complete from the start; no module registers a tap since the voiceprint tap was retired. */
  audioTaps: AudioTapsApi
  /** Replaced by `registerDeviceLock(ctx)` during wiring. */
  deviceLock: DeviceLockApi
  /** Replaced by `registerUserContext(ctx)` during wiring. */
  promptExtras: PromptExtrasApi
  /** Replaced by `registerMeetingDock(ctx)` during wiring. */
  meetingDock: MeetingDockApi
  /** Replaced by `registerIntegrations(ctx)` during wiring. */
  integrations: IntegrationsApi
  /** The fixed plug-in registry: the plug-ins register, the integration layer consults it. */
  integrationPlugins: IntegrationPluginsApi
  /** Replaced by `registerMail(ctx)` during wiring. */
  emailContext: EmailContextApi
  /** Replaced by `registerTags(ctx)` during wiring. */
  tags: TagsApi
  userDataPath: string
  isDev: boolean
}
