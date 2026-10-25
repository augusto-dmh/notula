// SPDX-License-Identifier: Apache-2.0
// Main-process wiring. Every feature module plugs in through its register function; this
// file only orders them.

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, screen, session, shell } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel } from '@shared/ipc'
import { APP_ID, APP_TASK_ARG_PREFIX } from '@shared/types/app'
import type { AppInfo } from '@shared/types/common'
import type { Settings } from '@shared/types/settings'
import { CUSTOMISABLE_SHORTCUTS, defaultShortcut, type CustomisableShortcutId } from '@shared/types/shortcuts'
import { registerActionItems } from './action-items'
import { registerLiveContext } from './live-context'
import { registerAppIcon } from './app-icon'
import { registerLocalAsr } from './asr'
import { registerAttachments } from './attachments'
import { registerAutomations } from './automations'
import { registerBlocks } from './blocks'
import { registerBriefs } from './briefs'
import { createBus, type MainBus } from './bus'
import { registerCalendar } from './calendar'
import { registerCalendarWrite } from './calendar-write'
import { registerCaptions } from './captions'
import { registerCapture } from './capture'
import { audioTaps } from './capture/taps'
import { registerChat } from './chat'
import type { ChatApi } from './chat/tool-api'
import { registerClipboard } from './clipboard'
import { registerCompanies } from './companies'
import { registerCompanionCli } from './companion-cli'
import { registerConsent } from './consent'
import type {
  AttachmentsApi,
  CalendarApi,
  CaptureQuery,
  DeviceLockApi,
  EmailContextApi,
  ImportsApi,
  IntegrationsApi,
  LifecycleHooks,
  MainContext,
  MeetingDockApi,
  NotifyApi,
  PromptExtrasApi,
  SettingsApi,
  ShortcutsApi,
  TagsApi,
  UiStateApi,
  WindowModesApi
} from './context'
import { registerCustomerCalls } from './crm'
import { registerDataExport } from './data-export'
import { registerDemo } from './demo'
import { registerDeviceInfo } from './device-info'
import { registerLicenses } from './licenses'
import { registerDeviceLock } from './device-lock'
import { registerDiagnostics } from './diagnostics'
import { registerDictation } from './dictation'
import { registerDispatcher } from './dispatch'
import { registerEnhance } from './enhance'
import { registerFeedback } from './feedback'
import { registerFileConnectors } from './file-connectors'
import { registerFolders } from './folders'
import { registerFollowUp } from './follow-up'
import { registerImports } from './imports'
import { registerMarkdownImports } from './imports-md'
import { integrationPlugins } from './integration-plugins'
import { registerIntegrations } from './integrations'
import { registerIntegrationsPlus } from './integrations-plus'
import { installIpcGuard } from './ipc-guard'
import { registerLifecycle } from './lifecycle'
import { registerLocalApi } from './local-api'
import { registerLocalOnly } from './local-only'
import { abortNonLocalLlmRequests } from './llm/registry'
import { log } from './log'
import { registerMail } from './mail'
import { registerMcpClient } from './mcp'
import { registerMcpServer } from './mcp-server'
import { registerMeetings } from './meetings'
import { registerMeetingDock } from './meeting-dock'
import { registerMedia } from './media'
import { installRequestFilters, installSocketGuard } from './net/egress'
import { registerNetDoctor } from './netdoctor'
import { registerNotesIpc } from './notes'
import { registerNotify } from './notify'
import { registerBubble } from './bubble'
import { registerNux } from './nux'
import { registerPeople } from './people'
import { registerPermissions } from './permissions'
import { registerPower } from './power'
import { registerPreferences } from './preferences'
import { setLocalOnlyCache } from './privacy'
import { registerQuickAsk } from './quick-ask'
import { registerRecipes } from './recipes'
import { registerRecordings } from './recordings'
import { registerRecurringRecap } from './recurring-recap'
import { registerReleaseChannel } from './release-channel'
import { registerReminderCards } from './reminder-cards'
import { registerRetention } from './retention'
import { registerScratchpad } from './scratchpad'
import { registerScreenGuide } from './screen-guide'
import { registerSearch } from './search'
import { createSecrets } from './secrets'
import { bindProtectedChanges, createSettings } from './settings'
import { registerShell } from './shell'
import { registerShortcuts } from './shortcuts'
import { registerSnapshots } from './snapshots'
import { registerSources } from './sources'
import { registerSpeakerTags } from './speakers'
import { registerSummaryFeedback } from './summary-feedback'
import { createStorage } from './storage'
import { registerTags } from './tags'
import { registerTasks } from './tasks'
import { registerTemplates } from './templates'
import { registerTranscriptReports } from './transcript-reports'
import { createSpeechApi, RecognizerError, registerTranscription, type SpeechApi } from './transcription'
import { registerTranscriptionRules } from './transcription-rules'
import { registerTray } from './tray'
import { registerUpdater } from './updater'
import { registerUserContext } from './user-context'
import { registerVoiceprint } from './voiceprint'
import { registerWebhooks } from './webhooks'
import { registerWindowModes } from './window-modes'
import { createWindows, type Windows } from './windows'

const STORAGE_CLOSE_TIMEOUT_MS = 5_000

// 1. In dev, keep data apart from a packaged install.
// NOTULA_USER_DATA_DIR (unpackaged builds only) points a dev or test run at a throwaway
// profile, so harnesses never touch the real Notula-dev profile.
if (!app.isPackaged) {
  const override = process.env.NOTULA_USER_DATA_DIR
  app.setPath('userData', override ? override : join(app.getPath('appData'), 'Notula-dev'))
}

/**
 * Dev and test runs only: NOTULA_DEV_DISPLAY=secondary (or a display index) puts every window
 * on that display, so harness runs never cover the user's main screen. Code that places
 * secondary windows asks for the primary display, so that call answers with the chosen one,
 * and any window that still opens elsewhere is moved onto it.
 */
function applyDevDisplay(): void {
  const want = process.env.NOTULA_DEV_DISPLAY
  if (app.isPackaged || !want) return
  const all = screen.getAllDisplays()
  const primary = screen.getPrimaryDisplay()
  const target = want === 'secondary' ? all.find((d) => d.id !== primary.id) : all[Number(want)]
  if (!target) return
  screen.getPrimaryDisplay = () => target
  app.on('browser-window-created', (_e, win) => {
    setImmediate(() => {
      if (win.isDestroyed()) return
      const b = win.getBounds()
      const wa = target.workArea
      const cx = b.x + b.width / 2
      const cy = b.y + b.height / 2
      if (cx >= wa.x && cx < wa.x + wa.width && cy >= wa.y && cy < wa.y + wa.height) return
      const width = Math.min(b.width, Math.round(wa.width * 0.9))
      const height = Math.min(b.height, Math.round(wa.height * 0.9))
      const bounds = {
        x: wa.x + Math.round((wa.width - width) / 2),
        y: wa.y + Math.round((wa.height - height) / 2),
        width,
        height
      }
      // Moving onto a display with a different scale factor: Windows rescales the window
      // after the first move, so set the bounds again once it is on the target display.
      win.setBounds(bounds)
      setTimeout(() => {
        if (!win.isDestroyed()) win.setBounds(bounds)
      }, 50)
    })
  })
}

/** Runs one wiring step; a failing module is logged and never blocks the window. */
function wire(step: string, fn: () => void): void {
  try {
    fn()
  } catch (err) {
    log('error', 'main:wire-failed', { step, err })
  }
}

// ---------- the launch queue ----------
// Launch arguments and `open-url` events arrive before the lifecycle module is wired
// (a cold start through a deep link or a jump-list task). They wait here and drain
// into LifecycleHooks once wiring has run.

type LaunchItem =
  | { kind: 'args'; argv: string[]; source: 'first-instance' | 'second-instance' }
  | { kind: 'url'; url: string }

const launchQueue: LaunchItem[] = []
let lifecycle: LifecycleHooks | null = null

function deliver(hooks: LifecycleHooks, item: LaunchItem): void {
  try {
    if (item.kind === 'url') hooks.onOpenUrl(item.url)
    else hooks.onLaunchArgs(item.argv, item.source)
  } catch (err) {
    log('error', 'main:launch-item-failed', { kind: item.kind, err })
  }
}

function pushLaunch(item: LaunchItem): void {
  if (lifecycle) deliver(lifecycle, item)
  else launchQueue.push(item)
}

/** `ctx.ui` until the lifecycle module registers. */
function placeholderUi(windows: Windows): UiStateApi {
  return {
    viewingNoteId: () => null,
    inOnboarding: () => false,
    mainWindowFocused: () => windows.main()?.isFocused() ?? false,
    lastInteractionAt: () => 0
  }
}

/**
 * `ctx.calendar` until the calendar module registers: no events, "my emails" is the
 * profile email, and `join` opens http(s) links only, in the default browser.
 */
function placeholderCalendar(settings: SettingsApi): CalendarApi {
  return {
    listEvents: async () => [],
    getEvent: async () => null,
    currentEvent: async () => null,
    myEmails: async () => {
      const email = (await settings.get('profile.email')).trim().toLowerCase()
      return email ? [email] : []
    },
    viewingEventId: () => null,
    // No grants until the calendar service fills them.
    grants: async () => [],
    setGrant: () => Promise.reject(notulaError('internal', 'calendar not registered')),
    accessToken: () => Promise.reject(notulaError('internal', 'calendar not registered')),
    refreshSource: () => undefined,
    join: async (url) => {
      let protocol: string
      try {
        protocol = new URL(url).protocol
      } catch {
        return false
      }
      if (protocol !== 'http:' && protocol !== 'https:') return false
      try {
        await shell.openExternal(url)
        return true
      } catch (err) {
        log('warn', 'calendar:join-failed', { err })
        return false
      }
    }
  }
}

// ---------- placeholders, until each module registers ----------

/** `ctx.speech` until it registers: every recognizer fails to start, and the warm worker is a no-op. */
function placeholderSpeech(): SpeechApi {
  return {
    openRecognizer: () => {
      throw new RecognizerError('transcription_start', 'speech not registered')
    },
    setLocalWarm: () => undefined
  }
}

/** `ctx.attachments` until it registers: every method rejects `internal`. */
function placeholderAttachments(): AttachmentsApi {
  const reject = (): Promise<never> => Promise.reject(notulaError('internal', 'attachments not registered'))
  return {
    addNoteImage: reject,
    setScreenShareContext: reject,
    remove: reject,
    list: reject,
    readBytes: reject,
    readContent: reject,
    convertBytes: reject
  }
}

/** `ctx.chat` until it registers: providers are ignored, there are no library tools. */
function placeholderChat(): ChatApi {
  return {
    registerToolProvider: () => () => undefined,
    libraryTools: () => [],
    runLibraryTool: () => Promise.reject(notulaError('internal', 'chat not registered'))
  }
}

/** `ctx.imports` until it registers: the File menu item only logs. */
function placeholderImports(): ImportsApi {
  return {
    promptAndStart: async () => {
      log('info', 'imports:not-registered')
    }
  }
}

/** `ctx.windowModes` until it registers: always wide, and every request is a no-op. */
function placeholderWindowModes(): WindowModesApi {
  return {
    mode: () => 'wide',
    set: async () => undefined,
    scheduleResetAfterMeeting: () => undefined,
    cancelReset: () => undefined
  }
}

/**
 * `ctx.shortcuts` until it registers: the stored accelerator (cached from settings) or the platform
 * default; no validation; appliers are not called (quick ask and dictation register their own shortcuts).
 */
function placeholderShortcuts(settings: SettingsApi, bus: MainBus): ShortcutsApi {
  const stored = new Map<CustomisableShortcutId, string | null>()
  const read = (all: Settings): void => {
    for (const id of Object.keys(CUSTOMISABLE_SHORTCUTS) as CustomisableShortcutId[]) {
      stored.set(id, all[CUSTOMISABLE_SHORTCUTS[id].settingKey])
    }
  }
  void settings
    .getAll()
    .then(read)
    .catch((err: unknown) => log('warn', 'shortcuts:placeholder-read-failed', { err }))
  bus.on('settings:changed', (e) => read(e.settings))
  return {
    effective: (id) => stored.get(id) ?? defaultShortcut(id, process.platform),
    validate: () => null,
    registerApplier: () => () => undefined
  }
}


/** `ctx.capture` until the capture module registers: idle, and no gate ever runs. */
function placeholderCapture(): CaptureQuery {
  return {
    isCapturing: () => false,
    currentNoteId: () => null,
    stop: async () => undefined,
    registerStartGate: () => () => undefined,
    heldStart: () => null,
    releaseHeldStart: () => undefined,
    cancelHeldStart: () => undefined,
    recoverAfterInactivity: async () => undefined
  }
}

/** `ctx.notify` until the notify module registers. */
function placeholderNotify(): NotifyApi {
  return {
    show: (req) => req.id ?? randomUUID(),
    hide: () => undefined,
    visible: () => [],
    registerDecorator: () => () => undefined,
    cardWebContents: () => null
  }
}

/** `ctx.deviceLock` until it registers: never locked, and every protected change is allowed. */
function placeholderDeviceLock(): DeviceLockApi {
  return {
    isLocked: () => false,
    requestUnlock: async () => true,
    confirmProtectedChange: async () => true
  }
}

/** `ctx.promptExtras` until it registers: nothing extra in prompts. */
function placeholderPromptExtras(): PromptExtrasApi {
  return {
    summaryVars: async () => ({ author_context: '' }),
    chatContext: async () => '',
    asrVocabulary: async () => []
  }
}

/** `ctx.meetingDock` until it registers. */
function placeholderMeetingDock(): MeetingDockApi {
  return { isAvailable: () => false, show: async () => undefined }
}

/** `ctx.integrations` until the integration layer returns it. */
function placeholderIntegrations(): IntegrationsApi {
  return {
    share: () => Promise.reject(notulaError('internal', 'integrations not registered')),
    folderSend: () => Promise.reject(notulaError('internal', 'integrations not registered')),
    status: async (provider) => ({
      provider,
      state: 'not_configured',
      accountLabel: null,
      maskedCredential: null,
      lastValidatedAt: null,
      detail: null,
      blockedByLocalOnly: false
    })
  }
}

/** `ctx.emailContext` until the mail module registers. */
function placeholderEmailContext(): EmailContextApi {
  return { forEvent: async () => [] }
}

/** `ctx.tags` until the tags module returns it. */
function placeholderTags(): TagsApi {
  return { classify: () => Promise.reject(notulaError('internal', 'tags not registered')) }
}

/** Used only when `registerLifecycle` failed: a second instance just shows the window. */
function fallbackLifecycle(windows: Windows, ui: UiStateApi): LifecycleHooks {
  return {
    ui,
    onLaunchArgs: (_argv, source) => {
      if (source === 'second-instance') windows.showMain()
    },
    onOpenUrl: () => undefined
  }
}

/** Points the launch queue at the lifecycle hooks (or the fallback) and drains it. */
function drainLaunchQueue(hooks: LifecycleHooks): void {
  lifecycle = hooks
  for (const item of launchQueue.splice(0)) deliver(hooks, item)
}

/**
 * User data files that older builds stored under other names move once, before any module
 * reads them. Only builds that include the legacy upgrade (storage/legacy-upgrade.ts) know
 * the old names.
 */
function moveLegacyUserDataFiles(userDataPath: string): void {
  type Legacy = { moveLegacyUserDataFiles(path: string): { moved: string[] } }
  for (const legacy of Object.values(import.meta.glob<Legacy>('./storage/legacy-upgrade.ts', { eager: true }))) {
    try {
      const { moved } = legacy.moveLegacyUserDataFiles(userDataPath)
      if (moved.length) log('info', 'user-data-files-moved', { moved })
    } catch (err) {
      log('warn', 'user-data-files-move-failed', { err })
    }
  }
}

async function start(windows: Windows): Promise<void> {
  app.setAppUserModelId(APP_ID)
  const userDataPath = app.getPath('userData')
  moveLegacyUserDataFiles(userDataPath)
  const bus = createBus()

  // The egress catch-all and the IPC guard, before any register function or handler.
  let lockState: () => boolean = () => false
  installSocketGuard()
  installIpcGuard(() => lockState(), ipcMain as unknown as Parameters<typeof installIpcGuard>[1])
  installRequestFilters(session.defaultSession)
  app.on('session-created', (s) => installRequestFilters(s))

  // 3. Storage. Any state other than `ready` still continues: the renderer shows
  //    the recovery screen.
  const storage = createStorage({ userDataPath })
  try {
    const status = await storage.open()
    log('info', 'storage:opened', { state: status.state })
  } catch (err) {
    log('error', 'storage:open-threw', { err })
  }

  // 4. Secrets, settings, and a placeholder for every main-only service until its
  //    module registers.
  const settings = createSettings(storage, bus)
  const ctx: MainContext = {
    storage,
    secrets: createSecrets(storage),
    settings,
    bus,
    windows,
    capture: placeholderCapture(),
    transcription: { flush: async () => undefined, liveChunks: () => [] },
    ui: placeholderUi(windows),
    notify: placeholderNotify(),
    enhance: {
      rewrite: () => Promise.reject(notulaError('internal', 'enhance not registered')),
      didMeetingEnd: () => Promise.reject(notulaError('internal', 'enhance not registered')),
      noteChatInputs: () => Promise.reject(notulaError('internal', 'enhance not registered')),
      // Without enhance the stop still happens; nothing is summarized.
      stopAndSummarize: async (_noteId, stop) => {
        await stop()
        return { summarizing: false }
      },
      // Nothing is generated without enhance.
      autoGenerate: async () => null
    },
    calendar: placeholderCalendar(settings),
    speech: placeholderSpeech(),
    attachments: placeholderAttachments(),
    chat: placeholderChat(),
    imports: placeholderImports(),
    windowModes: placeholderWindowModes(),
    shortcuts: placeholderShortcuts(settings, bus),
    audioTaps,
    deviceLock: placeholderDeviceLock(),
    promptExtras: placeholderPromptExtras(),
    meetingDock: placeholderMeetingDock(),
    integrations: placeholderIntegrations(),
    integrationPlugins,
    emailContext: placeholderEmailContext(),
    tags: placeholderTags(),
    userDataPath,
    isDev: !app.isPackaged
  }

  lockState = () => ctx.deviceLock.isLocked()
  // The two protected notification transitions, whoever asks for them.
  bindProtectedChanges(settings, (target) => ctx.deviceLock.confirmProtectedChange(target))

  // The synchronous local-only cache behind the socket guard and request filters.
  try {
    setLocalOnlyCache(await settings.get('privacy.localOnly'))
  } catch (err) {
    log('warn', 'privacy:local-only-read-failed', { err })
  }
  bus.on('settings:changed', (e) => {
    if (!e.keys.includes('privacy.localOnly')) return
    setLocalOnlyCache(e.settings['privacy.localOnly'])
    // In-flight cloud LLM requests stop at once.
    if (e.settings['privacy.localOnly']) abortNonLocalLlmRequests()
  })

  ipcMain.handle(
    'app:info' satisfies InvokeChannel,
    (): AppInfo => ({
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform
    })
  )

  // 5. Feature modules, each after the services it reads at register time.
  //    The device lock first, right after settings and storage: a cold start with the lock on
  //    comes up locked.
  wire('device-lock', () => {
    ctx.deviceLock = registerDeviceLock(ctx)
  })
  wire('local-only', () => registerLocalOnly(ctx))
  //    5.1 library
  wire('notes', () => registerNotesIpc(ctx))
  wire('clipboard', () => registerClipboard(ctx))
  //    5.2 capture, speech
  wire('capture', () => {
    ctx.capture = registerCapture(ctx)
  })
  wire('transcription', () => {
    ctx.transcription = registerTranscription(ctx)
  })
  //    speech for dictation
  wire('speech', () => {
    ctx.speech = createSpeechApi(ctx)
  })
  wire('local-asr', () => registerLocalAsr(ctx))
  //    5.3 shell; window modes and the shortcut registry, so the menu, quick ask and dictation find them
  wire('shell', () => registerShell(ctx))
  wire('window-modes', () => {
    ctx.windowModes = registerWindowModes(ctx)
  })
  wire('shortcuts', () => {
    ctx.shortcuts = registerShortcuts(ctx)
  })
  let hooks: LifecycleHooks | null = null
  wire('lifecycle', () => {
    hooks = registerLifecycle(ctx, windows)
    ctx.ui = hooks.ui
  })
  wire('tray', () => registerTray(ctx))
  wire('updater', () => registerUpdater(ctx))
  //    5.4 templates and recipes, chat
  wire('enhance', () => {
    ctx.enhance = registerEnhance(ctx)
  })
  wire('templates', () => registerTemplates(ctx))
  wire('recipes', () => registerRecipes(ctx))
  wire('chat', () => {
    ctx.chat = registerChat(ctx)
  })
  //    5.5 settings and permissions
  wire('preferences', () => registerPreferences(ctx))
  wire('permissions', () => registerPermissions(ctx))
  //    5.6 live meeting
  wire('notify', () => {
    ctx.notify = registerNotify(ctx)
  })
  wire('meetings', () => registerMeetings(ctx))
  wire('bubble', () => registerBubble(ctx))
  wire('power', () => registerPower(ctx))
  //    5.7 calendar, organize
  wire('calendar', () => {
    ctx.calendar = registerCalendar(ctx)
  })
  wire('folders', () => registerFolders(ctx))
  wire('search', () => registerSearch(ctx))
  //    5.8 transcript and audio
  wire('speaker-tags', () => registerSpeakerTags(ctx))
  wire('recordings', () => registerRecordings(ctx))
  wire('imports', () => {
    ctx.imports = registerImports(ctx)
  })
  //    5.9 notes and AI
  wire('attachments', () => {
    ctx.attachments = registerAttachments(ctx)
  })
  wire('action-items', () => registerActionItems(ctx))
  wire('tags', () => {
    ctx.tags = registerTags(ctx)
  })
  wire('follow-up', () => registerFollowUp(ctx))
  //    5.10 people, companies, quick ask
  wire('people', () => registerPeople(ctx))
  wire('companies', () => registerCompanies(ctx))
  wire('quick-ask', () => registerQuickAsk(ctx))
  //    5.11 meetings
  wire('captions', () => registerCaptions(ctx))
  wire('briefs', () => registerBriefs(ctx))
  wire('demo', () => registerDemo(ctx))
  wire('snapshots', () => registerSnapshots(ctx))
  wire('screen-guide', () => registerScreenGuide(ctx))
  //    5.12 integrations
  wire('integrations', () => {
    ctx.integrations = registerIntegrations(ctx)
  })
  //    5.13 MCP and dictation
  wire('mcp-client', () => registerMcpClient(ctx))
  wire('mcp-server', () => registerMcpServer(ctx))
  wire('dictation', () => registerDictation(ctx))
  //    5.14 network doctor, scratchpad, diagnostics, data export
  wire('netdoctor', () => registerNetDoctor(ctx))
  wire('scratchpad', () => registerScratchpad(ctx))
  wire('diagnostics', () => registerDiagnostics(ctx))
  wire('data-export', () => registerDataExport(ctx))
  //    5.15 voice and transcripts
  wire('consent', () => registerConsent(ctx))
  wire('voiceprint', () => registerVoiceprint(ctx))
  wire('transcript-reports', () => registerTranscriptReports(ctx))
  wire('retention', () => registerRetention(ctx))
  //    5.16 assistants
  wire('meeting-dock', () => {
    ctx.meetingDock = registerMeetingDock(ctx)
  })
  wire('live-context', () => registerLiveContext(ctx))
  wire('reminder-cards', () => registerReminderCards(ctx))
  wire('recurring-recap', () => registerRecurringRecap(ctx))
  //    5.17 knowledge and tasks
  wire('user-context', () => {
    ctx.promptExtras = registerUserContext(ctx)
  })
  wire('tasks', () => registerTasks(ctx))
  wire('summary-feedback', () => registerSummaryFeedback(ctx))
  wire('dispatch', () => registerDispatcher(ctx))
  //    5.18 Local API and CLI
  wire('local-api', () => registerLocalApi(ctx))
  wire('companion-cli', () => registerCompanionCli(ctx))
  //    5.19 general settings and shell
  wire('device-info', () => registerDeviceInfo(ctx))
  wire('licenses', () => registerLicenses())
  wire('feedback', () => registerFeedback(ctx))
  wire('app-icon', () => registerAppIcon(ctx))
  wire('nux', () => registerNux(ctx))
  wire('release-channel', () => registerReleaseChannel(ctx))
  //    5.20 calendar writes, blocks, mail, files (after integrations and the calendar)
  wire('blocks', () => registerBlocks(ctx))
  wire('calendar-write', () => registerCalendarWrite(ctx))
  wire('mail', () => {
    ctx.emailContext = registerMail(ctx)
  })
  wire('file-connectors', () => registerFileConnectors(ctx))
  //    5.21 rules, automations, CRM, webhooks, CRM plug-ins
  wire('transcription-rules', () => registerTranscriptionRules(ctx))
  wire('automations', () => registerAutomations(ctx))
  wire('crm', () => registerCustomerCalls(ctx))
  wire('webhooks', () => registerWebhooks(ctx))
  wire('integrations-plus', () => registerIntegrationsPlus(ctx))
  //    5.22 content sources (the passive provider, then sources and its parts) and import notes
  wire('media', () => registerMedia(ctx))
  wire('sources', () => registerSources(ctx))
  wire('markdown-imports', () => registerMarkdownImports(ctx))

  // The launch queue drains into the lifecycle hooks.
  drainLaunchQueue(hooks ?? fallbackLifecycle(windows, ctx.ui))

  // 6. Close storage last on quit. A module that needs async work first (capture's
  //    app_shutdown flush) defers in `before-quit` and calls app.quit() again.
  let closing = false
  app.on('will-quit', (e) => {
    if (closing) return
    closing = true
    e.preventDefault()
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, STORAGE_CLOSE_TIMEOUT_MS))
    void Promise.race([storage.close(), timeout])
      .catch((err: unknown) => log('error', 'storage:close-failed', { err }))
      .finally(() => app.exit(0))
  })

  // 7. The window, created whatever the storage state. A first instance launched with
  //    `--notula-task=background` (the MCP shim) starts in the tray only.
  if (!process.argv.includes(`${APP_TASK_ARG_PREFIX}background`)) windows.showMain()

  // The dev-only egress, IPC-guard and capture-gate harness.
  if (!app.isPackaged && process.env.NOTULA_DEV_EGRESS_HARNESS === '1') {
    void import('./net/egress-harness').then((m) => m.runEgressHarness(ctx))
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) windows.showMain()
  })
}

// 2. Single instance. Launch arguments and URLs queue until the lifecycle module is wired.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  const windows = createWindows()

  app.on('second-instance', (_e, argv) => pushLaunch({ kind: 'args', argv, source: 'second-instance' }))
  app.on('open-url', (e, url) => {
    e.preventDefault()
    pushLaunch({ kind: 'url', url })
  })
  pushLaunch({ kind: 'args', argv: process.argv, source: 'first-instance' })

  void app
    .whenReady()
    .then(() => {
      applyDevDisplay()
      return start(windows)
    })
    .catch((err: unknown) => {
      log('error', 'main:start-failed', { err })
      if (!lifecycle) drainLaunchQueue(fallbackLifecycle(windows, placeholderUi(windows)))
      windows.showMain()
    })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
