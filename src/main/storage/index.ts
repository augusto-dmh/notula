// SPDX-License-Identifier: Apache-2.0
// createStorage(): main's StorageApi, an RPC client to the notula-storage utility
// process (out/main/storage.js). Main owns the safeStorage-wrapped key
// (keyfile.ts) and the recovery actions, which never delete user data; the worker owns SQLite.
//
// Data methods reject with `storage-unavailable` unless the status is `ready`.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, shell, utilityProcess, type UtilityProcess } from 'electron'
import { notulaError, parseError } from '@shared/errors'
import type { RecoveryAction, StorageStatus } from '@shared/types/storage'
import { expected } from '../ipc-expected'
import { log } from '../log'
import type { StorageApi, StorageChange, StorageIdentity } from './api'
import type { EngineStatus } from './engine'
import { loadOrCreateKey } from './keyfile'
import {
  isReply,
  SCHEMA_VERSION,
  type DataMethod,
  type DataMethods,
  type DebugSearchResult,
  type OpenParams,
  type WorkerMessage,
  type WorkerMethod,
  type WorkerMethods,
  type WorkerRequest,
  type WorkerStatus
} from './protocol'
import { exportCopy, LOCAL_STATE_FILE, moveAside } from './recovery'

export interface StorageOptions {
  userDataPath: string
}

const CLOSE_TIMEOUT_MS = 4_000
/** An unexpected exit of the storage process is reopened at once, at most this often. */
const AUTO_REOPEN_EVERY_MS = 60_000
const LOCAL_STATE_POLL_MS = 1_000
const LOCAL_STATE_WATCH_MS = 60_000

/**
 * Windows: safeStorage's master key lives in Chromium's `Local State`, which
 * Chromium commits about 10 s after it creates the key, and Electron has no way to
 * flush it sooner. Until then a crash strands a new notula.key (key-unavailable on
 * the next start; the recovery copy says so). This only records when the window
 * closed, for diagnostics.
 */
function watchLocalState(userDataPath: string): void {
  if (process.platform !== 'win32') return
  const started = Date.now()
  const check = async (): Promise<void> => {
    let committed = false
    try {
      const parsed = JSON.parse(await readFile(join(userDataPath, LOCAL_STATE_FILE), 'utf8')) as {
        os_crypt?: { encrypted_key?: unknown }
      }
      committed = typeof parsed.os_crypt?.encrypted_key === 'string'
    } catch {
      // Not written yet, or mid-write.
    }
    const ms = Date.now() - started
    if (committed) log('info', 'storage:local-state-committed', { ms })
    else if (ms >= LOCAL_STATE_WATCH_MS) log('warn', 'storage:local-state-not-committed', { ms })
    else setTimeout(() => void check(), LOCAL_STATE_POLL_MS)
  }
  void check()
}

/** Main-side extras of the client that are not part of the StorageApi contract. */
interface StorageInternals {
  onStatus(cb: (status: StorageStatus) => void): () => void
  debugSearch(query: string): Promise<DebugSearchResult>
}

const internals = new WeakMap<StorageApi, StorageInternals>()

/**
 * Subscribes to status changes after `open()`: recovery actions and mid-session
 * failures. The IPC module forwards them as `storage:status-changed`.
 */
export function onStorageStatus(storage: StorageApi, cb: (status: StorageStatus) => void): () => void {
  return internals.get(storage)?.onStatus(cb) ?? (() => undefined)
}

/** Dev only: FTS lookup in the storage process. */
export function debugSearch(storage: StorageApi, query: string): Promise<DebugSearchResult> {
  const i = internals.get(storage)
  return i ? i.debugSearch(query) : Promise.reject(notulaError('storage-unavailable', 'no storage client'))
}

type Pending = { resolve(v: unknown): void; reject(e: Error): void; method: WorkerMethod }

export function createStorage(opts: StorageOptions): StorageApi {
  const dataDir = join(opts.userDataPath, 'data')
  const workerPath = join(__dirname, 'storage.js')

  let status: StorageStatus = { state: 'starting', dataPath: dataDir, expectedVersion: SCHEMA_VERSION }
  let identity: StorageIdentity | null = null
  let child: UtilityProcess | null = null
  let spawned: Promise<UtilityProcess> | null = null
  let nextId = 1
  let stopping = false
  /** Reached `ready` once in this app run: later opens skip startup housekeeping. */
  let everReady = false
  let lastAutoReopen = 0
  /** open / recover / close run one at a time. */
  let lifecycle: Promise<unknown> = Promise.resolve()

  const pending = new Map<number, Pending>()
  const changeListeners = new Set<(c: StorageChange) => void>()
  const statusListeners = new Set<(s: StorageStatus) => void>()

  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = lifecycle.then(fn, fn)
    lifecycle = run.catch(() => undefined)
    return run
  }

  function setStatus(next: StorageStatus): void {
    status = next
    for (const cb of statusListeners) {
      try {
        cb({ ...next })
      } catch (err) {
        log('error', 'storage:status-listener-failed', { err })
      }
    }
  }

  function fromWorker(ws: EngineStatus): StorageStatus {
    return {
      state: ws.state === 'closed' ? 'starting' : ws.state,
      dataPath: dataDir,
      expectedVersion: ws.expectedVersion,
      ...(ws.detail ? { detail: ws.detail } : {}),
      ...(ws.backupPath ? { backupPath: ws.backupPath } : {}),
      ...(ws.schemaVersion !== undefined ? { schemaVersion: ws.schemaVersion } : {}),
      ...(typeof ws.damagedRooms === 'number' && ws.damagedRooms > 0 ? { damagedRooms: ws.damagedRooms } : {})
    }
  }

  // ---------- the utility process ----------

  function spawn(): Promise<UtilityProcess> {
    if (spawned) return spawned
    // The storage process never holds a plaintext API key, so the
    // dev-only NOTULA_SECRET_* variables are not passed down.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('NOTULA_SECRET_')))
    const proc = utilityProcess.fork(workerPath, [], { serviceName: 'notula-storage', env })
    child = proc
    spawned = new Promise<UtilityProcess>((resolve, reject) => {
      proc.on('message', (m: WorkerMessage) => {
        if (!isReply(m) && m.type === 'hello') resolve(proc)
        else onMessage(m)
      })
      proc.once('exit', (code) => reject(notulaError('storage-unavailable', `storage process exited (${code})`)))
    })
    proc.on('exit', (code) => onExit(proc, code))
    return spawned
  }

  function onMessage(m: WorkerMessage): void {
    if (isReply(m)) {
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      if (m.ok) p.resolve(m.result)
      else p.reject(notulaError(m.error.code, m.error.message))
      return
    }
    switch (m.type) {
      case 'changed': {
        const change: StorageChange = { tables: m.tables, ids: m.ids }
        for (const cb of changeListeners) {
          try {
            cb(change)
          } catch (err) {
            log('error', 'storage:change-listener-failed', { err })
          }
        }
        return
      }
      case 'status':
        if (m.status.state !== 'ready') identity = null
        log('error', 'storage:status', { state: m.status.state, detail: m.status.detail })
        setStatus(fromWorker(m.status))
        return
      case 'log':
        log(m.level, `storage:${m.event}`, m.data)
        return
      default:
        return
    }
  }

  function onExit(proc: UtilityProcess, code: number): void {
    if (proc !== child) return
    child = null
    spawned = null
    identity = null
    for (const [id, p] of pending) {
      pending.delete(id)
      p.reject(notulaError('storage-unavailable', `storage process exited during ${p.method}`))
    }
    if (stopping) return
    log('error', 'storage:process-exited', { code })
    if (status.state !== 'ready') return
    const detail = `The storage process stopped unexpectedly (exit code ${code}). Your data is unchanged.`
    // A one-off crash is reopened at once (a crash loop is not): capture keeps
    // running meanwhile, and the transcript's write-behind retries until then.
    if (Date.now() - lastAutoReopen >= AUTO_REOPEN_EVERY_MS) {
      lastAutoReopen = Date.now()
      setStatus({ state: 'starting', dataPath: dataDir, expectedVersion: status.expectedVersion, detail })
      void serial(openFlow).then(
        (s) => log(s.state === 'ready' ? 'info' : 'error', 'storage:auto-reopen', { state: s.state }),
        (err: unknown) => {
          log('error', 'storage:auto-reopen-failed', { err })
          setStatus({ state: 'open-failed', dataPath: dataDir, expectedVersion: SCHEMA_VERSION, detail })
        }
      )
      return
    }
    setStatus({ state: 'open-failed', dataPath: dataDir, expectedVersion: status.expectedVersion, detail })
  }

  async function call<M extends WorkerMethod>(
    method: M,
    params: Parameters<WorkerMethods[M]>
  ): Promise<ReturnType<WorkerMethods[M]>> {
    const proc = await spawn()
    return new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method })
      proc.postMessage({ id, method, params } satisfies WorkerRequest)
    })
  }

  /** A StorageApi data method: gated on `ready`, then forwarded. */
  function data<M extends DataMethod>(method: M) {
    return ((...params: Parameters<DataMethods[M]>) => {
      if (status.state !== 'ready') {
        // Expected while the recovery screen is up.
        return Promise.reject(expected(notulaError('storage-unavailable', `storage is ${status.state}`)))
      }
      return call(method, params as unknown as Parameters<WorkerMethods[M]>)
    }) as unknown as DataMethods[M]
  }

  // ---------- lifecycle ----------

  async function openFlow(): Promise<StorageStatus> {
    identity = null
    const key = loadOrCreateKey(dataDir)
    if (!key.ok) {
      if (child) await call('close', []).catch(() => undefined)
      log('error', 'storage:key-unavailable', { state: key.state, detail: key.detail })
      setStatus({ state: key.state, detail: key.detail, dataPath: dataDir, expectedVersion: SCHEMA_VERSION })
      return { ...status }
    }
    if (key.created) {
      log('info', 'storage:key-created', { dataDir })
      watchLocalState(opts.userDataPath)
    }

    const dev = !app.isPackaged
    const params: OpenParams = {
      dataDir,
      keyHex: key.keyHex,
      appVersion: app.getVersion(),
      devFailMigration: dev && process.env['NOTULA_DEV_FAIL_MIGRATION'] === '1',
      devVersionAhead: dev && process.env['NOTULA_DEV_VERSION_AHEAD'] === '1',
      housekeeping: !everReady
    }
    let ws: WorkerStatus
    try {
      ws = await call('open', [params])
    } catch (err) {
      ws = { state: 'open-failed', expectedVersion: SCHEMA_VERSION, detail: parseError(err).message }
    }
    if (ws.state === 'ready') {
      everReady = true
      try {
        identity = await call('identity', [])
      } catch (err) {
        log('error', 'storage:identity-failed', { err })
      }
    }
    setStatus(fromWorker(ws))
    log(ws.state === 'ready' ? 'info' : 'error', 'storage:open', {
      state: ws.state,
      detail: ws.detail,
      schemaVersion: ws.schemaVersion,
      expectedVersion: ws.expectedVersion,
      backupPath: ws.backupPath
    })
    return { ...status }
  }

  async function recoverFlow(action: RecoveryAction): Promise<StorageStatus> {
    switch (action) {
      case 'retry':
        return status.state === 'ready' ? { ...status } : openFlow()

      case 'open-data-folder': {
        const err = await shell.openPath(dataDir)
        if (err) log('warn', 'storage:open-data-folder-failed', { err })
        return { ...status }
      }

      case 'export-copy': {
        const options: Electron.OpenDialogOptions = {
          title: 'Choose where to save a copy of your Notula data',
          buttonLabel: 'Save copy here',
          properties: ['openDirectory', 'createDirectory']
        }
        const win = BrowserWindow.getFocusedWindow()
        const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
        const destRoot = res.filePaths[0]
        if (res.canceled || !destRoot) return { ...status }
        // While open, fold the WAL into the .db so the copy is complete on its own.
        if (status.state === 'ready') await call('checkpoint', [])
        const { dir, copied } = exportCopy(opts.userDataPath, dataDir, destRoot)
        log('info', 'storage:exported-copy', { dir, copied })
        void shell.openPath(dir)
        return { ...status }
      }

      case 'start-fresh': {
        if (status.state === 'ready' || status.state === 'starting') {
          throw notulaError('invalid-input', 'start-fresh is only available while storage needs recovery')
        }
        // The worker holds no handle on the files in a recovery state; make sure.
        if (child) await call('close', [])
        let aside: { dir: string; moved: string[] }
        try {
          aside = await moveAside(opts.userDataPath, dataDir)
        } catch (err) {
          log('error', 'storage:move-aside-failed', { err })
          throw notulaError('internal', err instanceof Error ? err.message : String(err))
        }
        log('warn', 'storage:moved-aside', { dir: aside.dir, moved: aside.moved })
        return openFlow()
      }

      default:
        throw notulaError('invalid-input', `unknown recovery action ${String(action)}`)
    }
  }

  async function closeFlow(): Promise<void> {
    stopping = true
    const proc = child
    if (!proc) return
    const started = Date.now()
    let timedOut = false
    try {
      await Promise.race([
        call('close', []),
        new Promise((resolve) =>
          setTimeout(() => {
            timedOut = true
            resolve(undefined)
          }, CLOSE_TIMEOUT_MS)
        )
      ])
    } catch (err) {
      log('error', 'storage:close-failed', { err })
    } finally {
      proc.kill()
      log(timedOut ? 'warn' : 'info', 'storage:closed', { ms: Date.now() - started, timedOut })
    }
  }

  const api: StorageApi = {
    open: () => serial(openFlow),
    status: async () => ({ ...status }),
    recover: (action) => serial(() => recoverFlow(action)),
    identity: async () => {
      if (status.state !== 'ready') throw notulaError('storage-unavailable', `storage is ${status.state}`)
      identity ??= await call('identity', [])
      return { ...identity }
    },
    onChange: (cb) => {
      changeListeners.add(cb)
      return () => {
        changeListeners.delete(cb)
      }
    },
    close: () => serial(closeFlow),

    listNotes: data('listNotes'),
    getNote: data('getNote'),
    createNote: data('createNote'),
    updateNote: data('updateNote'),
    setAttachedLinks: data('setAttachedLinks'),
    trashNote: data('trashNote'),
    restoreNote: data('restoreNote'),
    findNoteByEvent: data('findNoteByEvent'),
    setTranscribe: data('setTranscribe'),
    incrementMeetingEndCount: data('incrementMeetingEndCount'),
    loadYdoc: data('loadYdoc'),
    appendYdoc: data('appendYdoc'),
    listPanels: data('listPanels'),
    getPanel: data('getPanel'),
    createPanel: data('createPanel'),
    updatePanel: data('updatePanel'),
    listGeneratingPanels: data('listGeneratingPanels'),
    getTranscript: data('getTranscript'),
    upsertChunks: data('upsertChunks'),
    createSession: data('createSession'),
    endSession: data('endSession'),
    latestSession: data('latestSession'),
    getSettingsRaw: data('getSettingsRaw'),
    setSettingRaw: data('setSettingRaw'),
    getSecretBlob: data('getSecretBlob'),
    setSecretBlob: data('setSecretBlob'),
    deleteSecretBlob: data('deleteSecretBlob'),
    listSecretIds: data('listSecretIds'),
    listTrash: data('listTrash'),
    deleteNotePermanently: data('deleteNotePermanently'),
    noteEmptiness: data('noteEmptiness'),
    markNoteDeleted: data('markNoteDeleted'),
    queryNotes: data('queryNotes'),
    searchFts: data('searchFts'),
    exportYdocState: data('exportYdocState'),
    listTemplates: data('listTemplates'),
    getTemplate: data('getTemplate'),
    createTemplate: data('createTemplate'),
    updateTemplate: data('updateTemplate'),
    listRecipes: data('listRecipes'),
    getRecipe: data('getRecipe'),
    upsertRecipe: data('upsertRecipe'),
    setRecipeDeleted: data('setRecipeDeleted'),
    listChatThreads: data('listChatThreads'),
    getChatThread: data('getChatThread'),
    upsertChatThread: data('upsertChatThread'),
    deleteChatThread: data('deleteChatThread'),
    listChatMessages: data('listChatMessages'),
    upsertChatMessage: data('upsertChatMessage'),
    truncateChatMessagesAfter: data('truncateChatMessagesAfter'),
    listCalendarSources: data('listCalendarSources'),
    upsertCalendarSource: data('upsertCalendarSource'),
    setCalendarSourceGrants: data('setCalendarSourceGrants'),
    removeCalendarSource: data('removeCalendarSource'),
    listCalendars: data('listCalendars'),
    replaceCalendars: data('replaceCalendars'),
    setCalendarVisible: data('setCalendarVisible'),
    replaceSourceEvents: data('replaceSourceEvents'),
    listEventsInRange: data('listEventsInRange'),
    getCalendarEvent: data('getCalendarEvent'),
    upcomingEvents: data('upcomingEvents'),
    followEventUpdates: data('followEventUpdates'),
    participants: data('participants'),
    listFolders: data('listFolders'),
    createFolder: data('createFolder'),
    updateFolder: data('updateFolder'),
    deleteFolder: data('deleteFolder'),
    addNotesToFolder: data('addNotesToFolder'),
    removeNoteFromFolder: data('removeNoteFromFolder'),
    setFolderRule: data('setFolderRule'),
    deleteFolderRule: data('deleteFolderRule'),
    searchNotes: data('searchNotes'),
    listSpeakerNameSuggestions: data('listSpeakerNameSuggestions'),
    replaceSpeakerNameSuggestions: data('replaceSpeakerNameSuggestions'),
    deleteSpeakerNameSuggestion: data('deleteSpeakerNameSuggestion'),
    createRecording: data('createRecording'),
    updateRecording: data('updateRecording'),
    listRecordings: data('listRecordings'),
    deleteRecordings: data('deleteRecordings'),
    recordingsUsage: data('recordingsUsage'),
    markInterruptedRecordings: data('markInterruptedRecordings'),
    createImportJob: data('createImportJob'),
    updateImportJob: data('updateImportJob'),
    listImportJobs: data('listImportJobs'),
    deleteImportJob: data('deleteImportJob'),
    createAttachment: data('createAttachment'),
    readAttachment: data('readAttachment'),
    updateAttachment: data('updateAttachment'),
    listAttachments: data('listAttachments'),
    attachmentContent: data('attachmentContent'),
    deleteAttachment: data('deleteAttachment'),
    listActionItems: data('listActionItems'),
    replaceNoteActionItems: data('replaceNoteActionItems'),
    reviewActionItem: data('reviewActionItem'),
    archiveActionItem: data('archiveActionItem'),
    addActionItemFeedback: data('addActionItemFeedback'),
    setActionItemDraftThread: data('setActionItemDraftThread'),
    applyRegeneratedActionItems: data('applyRegeneratedActionItems'),
    setClassifierTags: data('setClassifierTags'),
    setManualMeetingType: data('setManualMeetingType'),
    undoManualMeetingType: data('undoManualMeetingType'),
    getFollowUpDraft: data('getFollowUpDraft'),
    upsertFollowUpDraft: data('upsertFollowUpDraft'),
    listFollowUpDrafts: data('listFollowUpDrafts'),
    listPeople: data('listPeople'),
    getPerson: data('getPerson'),
    listCompanies: data('listCompanies'),
    getCompany: data('getCompany'),
    recordRecipeUse: data('recordRecipeUse'),
    recipeUsage: data('recipeUsage'),
    setRecipeSaved: data('setRecipeSaved'),
    listSavedRecipeIds: data('listSavedRecipeIds'),
    getCompanyIcon: data('getCompanyIcon'),
    putCompanyIcon: data('putCompanyIcon'),
    deleteAllCompanyIcons: data('deleteAllCompanyIcons'),
    getBrief: data('getBrief'),
    upsertBrief: data('upsertBrief'),
    briefContext: data('briefContext'),
    listIntegrationDestinations: data('listIntegrationDestinations'),
    upsertIntegrationDestination: data('upsertIntegrationDestination'),
    deleteIntegrationDestinations: data('deleteIntegrationDestinations'),
    listIntegrationAutomations: data('listIntegrationAutomations'),
    upsertIntegrationAutomation: data('upsertIntegrationAutomation'),
    setIntegrationAutomationsEnabled: data('setIntegrationAutomationsEnabled'),
    claimAutomationRun: data('claimAutomationRun'),
    createIntegrationDeliveries: data('createIntegrationDeliveries'),
    updateIntegrationDelivery: data('updateIntegrationDelivery'),
    listIntegrationDeliveries: data('listIntegrationDeliveries'),
    dueIntegrationDeliveries: data('dueIntegrationDeliveries'),
    pendingAutomationNotes: data('pendingAutomationNotes'),
    expireIntegrationDeliveries: data('expireIntegrationDeliveries'),
    listMcpConnections: data('listMcpConnections'),
    upsertMcpConnection: data('upsertMcpConnection'),
    deleteMcpConnection: data('deleteMcpConnection'),
    listMcpServerTokens: data('listMcpServerTokens'),
    createMcpServerToken: data('createMcpServerToken'),
    findMcpServerToken: data('findMcpServerToken'),
    touchMcpServerToken: data('touchMcpServerToken'),
    deleteMcpServerToken: data('deleteMcpServerToken'),
    createDictationAttempt: data('createDictationAttempt'),
    updateDictationAttempt: data('updateDictationAttempt'),
    listDictationAttempts: data('listDictationAttempts'),
    getDictationAttempt: data('getDictationAttempt'),
    deleteDictationAttempts: data('deleteDictationAttempts'),
    markInterruptedDictations: data('markInterruptedDictations'),
    listScratchpadDays: data('listScratchpadDays'),
    getScratchpadDay: data('getScratchpadDay'),
    saveScratchpadDay: data('saveScratchpadDay'),
    listExportNotes: data('listExportNotes'),
    writeExportNotes: data('writeExportNotes'),
    writeExportIndex: data('writeExportIndex'),
    writeExportReadme: data('writeExportReadme'),
    writeDatabaseCopy: data('writeDatabaseCopy'),
    // src/main/repos/
    getConsentPost: data('getConsentPost'),
    upsertConsentPost: data('upsertConsentPost'),
    getVoiceprint: data('getVoiceprint'),
    saveVoiceprint: data('saveVoiceprint'),
    deleteVoiceprints: data('deleteVoiceprints'),
    createTranscriptReport: data('createTranscriptReport'),
    listTranscriptReports: data('listTranscriptReports'),
    deleteTranscriptReport: data('deleteTranscriptReport'),
    reportExcerpt: data('reportExcerpt'),
    previewRetention: data('previewRetention'),
    purgeTranscripts: data('purgeTranscripts'),
    recordRetentionRun: data('recordRetentionRun'),
    listRetentionRuns: data('listRetentionRuns'),
    deleteTranscriptSections: data('deleteTranscriptSections'),
    getMeetingDockHistory: data('getMeetingDockHistory'),
    saveMeetingDockHistory: data('saveMeetingDockHistory'),
    listReminders: data('listReminders'),
    upsertReminders: data('upsertReminders'),
    pruneReminders: data('pruneReminders'),
    previousSeriesNote: data('previousSeriesNote'),
    getRecurringRecap: data('getRecurringRecap'),
    putRecurringRecap: data('putRecurringRecap'),
    findFreeSlot: data('findFreeSlot'),
    listTasks: data('listTasks'),
    toggleTaskItem: data('toggleTaskItem'),
    addManualTask: data('addManualTask'),
    setManualTask: data('setManualTask'),
    deleteManualTask: data('deleteManualTask'),
    taskBadge: data('taskBadge'),
    summaryFeedbackFacts: data('summaryFeedbackFacts'),
    upsertSummaryFeedback: data('upsertSummaryFeedback'),
    listSummaryFeedback: data('listSummaryFeedback'),
    listUserContextSections: data('listUserContextSections'),
    upsertUserContextSection: data('upsertUserContextSection'),
    userContextPeople: data('userContextPeople'),
    userContextDraftInputs: data('userContextDraftInputs'),
    listDispatchTodos: data('listDispatchTodos'),
    upsertDispatchTodos: data('upsertDispatchTodos'),
    setDispatchTodoStatus: data('setDispatchTodoStatus'),
    listDispatches: data('listDispatches'),
    insertDispatches: data('insertDispatches'),
    resurfaceDispatches: data('resurfaceDispatches'),
    archiveUnstartedDispatches: data('archiveUnstartedDispatches'),
    setDispatch: data('setDispatch'),
    getDispatchRun: data('getDispatchRun'),
    upsertDispatchRun: data('upsertDispatchRun'),
    pruneDispatchRuns: data('pruneDispatchRuns'),
    listLocalApiKeys: data('listLocalApiKeys'),
    createLocalApiKey: data('createLocalApiKey'),
    findLocalApiKey: data('findLocalApiKey'),
    updateLocalApiKey: data('updateLocalApiKey'),
    touchLocalApiKey: data('touchLocalApiKey'),
    deleteLocalApiKey: data('deleteLocalApiKey'),
    apiListNotes: data('apiListNotes'),
    apiGetNotes: data('apiGetNotes'),
    apiTranscript: data('apiTranscript'),
    apiListFolders: data('apiListFolders'),
    apiListSeries: data('apiListSeries'),
    apiGetSeries: data('apiGetSeries'),
    getNoteSource: data('getNoteSource'),
    getNoteSourceView: data('getNoteSourceView'),
    createNoteSource: data('createNoteSource'),
    updateNoteSource: data('updateNoteSource'),
    deleteNoteSource: data('deleteNoteSource'),
    findNotesBySource: data('findNotesBySource'),
    listNoteSources: data('listNoteSources'),
    addSourceSpans: data('addSourceSpans'),
    listSourceSpans: data('listSourceSpans'),
    upsertSeries: data('upsertSeries'),
    getSeries: data('getSeries'),
    findSeriesByFolder: data('findSeriesByFolder'),
    listSeries: data('listSeries'),
    getSeriesDetail: data('getSeriesDetail'),
    updateSeries: data('updateSeries'),
    pauseSeries: data('pauseSeries'),
    replaceCatalog: data('replaceCatalog'),
    listCatalog: data('listCatalog'),
    deleteCatalog: data('deleteCatalog'),
    findCatalogItem: data('findCatalogItem'),
    applyLessonNumbers: data('applyLessonNumbers'),
    listSourceDuplicates: data('listSourceDuplicates'),
    mergeSourceNotes: data('mergeSourceNotes'),
    getSourceMerge: data('getSourceMerge'),
    setSourceMergeExtra: data('setSourceMergeExtra'),
    undoSourceMerge: data('undoSourceMerge'),
    createImportBatch: data('createImportBatch'),
    getImportBatch: data('getImportBatch'),
    listImportBatches: data('listImportBatches'),
    listImportItems: data('listImportItems'),
    updateImportBatch: data('updateImportBatch'),
    updateImportItem: data('updateImportItem'),
    findImportMatches: data('findImportMatches'),
    importNoteItem: data('importNoteItem'),
    importUndoPreview: data('importUndoPreview'),
    undoImportBatch: data('undoImportBatch'),
    clearImportHistory: data('clearImportHistory'),
    getImportCandidates: data('getImportCandidates'),
    noteCount: data('noteCount'),
    databaseCreatedAt: data('databaseCreatedAt'),
    holdDueIntegrationDeliveries: data('holdDueIntegrationDeliveries'),
    listHeldIntegrationDeliveries: data('listHeldIntegrationDeliveries'),
    releaseHeldIntegrationDelivery: data('releaseHeldIntegrationDelivery'),
    getWorkflowBlock: data('getWorkflowBlock'),
    listWorkflowBlocks: data('listWorkflowBlocks'),
    createWorkflowBlock: data('createWorkflowBlock'),
    updateWorkflowBlock: data('updateWorkflowBlock'),
    setBlockExecution: data('setBlockExecution'),
    listAutomationRules: data('listAutomationRules'),
    upsertAutomationRule: data('upsertAutomationRule'),
    deleteAutomationRule: data('deleteAutomationRule'),
    claimAutomationRunOnce: data('claimAutomationRunOnce'),
    updateAutomationRun: data('updateAutomationRun'),
    listAutomationRuns: data('listAutomationRuns'),
    endedMeetingNotes: data('endedMeetingNotes'),
    automationFacts: data('automationFacts'),
    customerCallsBacklog: data('customerCallsBacklog'),
    customerCallsSyncStatus: data('customerCallsSyncStatus'),
    listWebhookEndpoints: data('listWebhookEndpoints'),
    upsertWebhookEndpoint: data('upsertWebhookEndpoint'),
    deleteWebhookEndpoint: data('deleteWebhookEndpoint'),
    recordWebhookResult: data('recordWebhookResult')
  }

  internals.set(api, {
    onStatus: (cb) => {
      statusListeners.add(cb)
      return () => {
        statusListeners.delete(cb)
      }
    },
    debugSearch: (query) =>
      status.state === 'ready'
        ? call('debugSearch', [query])
        : Promise.reject(notulaError('storage-unavailable', `storage is ${status.state}`))
  })

  return api
}
