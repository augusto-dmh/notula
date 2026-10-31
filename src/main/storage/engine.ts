// SPDX-License-Identifier: Apache-2.0
// The notula-storage engine: one SQLCipher connection, migrations with
// backups, the change feed, the FTS indexer and the Yjs log. Runs only inside the
// utility process; main never calls SQLite.
//
// Never wipes user data: a failed migration rolls back and keeps a backup,
// a newer schema is only read (never migrated), and a file that will not open is
// left exactly where it is.

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { ErrorCode } from '@shared/errors'
import { PREFS_VERSION } from '@shared/types/settings'
import * as actionItems from './action-items-repo'
import type { StorageIdentity } from './api'
import * as attachments from './attachments-repo'
import * as briefs from './briefs-repo'
import * as calendar from './calendar-repo'
import * as chat from './chat-repo'
import * as companyIcons from './company-icons-repo'
import * as dictation from './dictation-repo'
import * as dataExport from './export-repo'
import * as folders from './folders-repo'
import * as followUp from './follow-up-repo'
import { FtsIndexer, searchFts } from './fts'
import * as imports from './imports-repo'
import * as integrations from './integrations-repo'
import * as kv from './kv-repo'
import * as mcp from './mcp-repo'
import { BASELINE_VERSION, DEV_FAIL_MIGRATION, MIGRATIONS, type Migration } from './migrations'
import * as notes from './notes-repo'
import * as panels from './panels-repo'
import * as people from './people-repo'
import * as recipeUsage from './recipe-usage-repo'
import * as recipes from './recipes-repo'
import * as recordings from './recordings-repo'
import * as scratchpad from './scratchpad-repo'
import * as importsMd from './imports-md-repo'
import * as search from './search-repo'
import * as sources from './sources-repo'
import * as speakerNames from './speaker-names-repo'
import * as speakerAgreements from './speaker-agreements-repo'
import * as speakerPeople from './speaker-people-repo'
import * as speakerVoice from './speaker-voice-repo'
import * as tags from './tags-repo'
import * as templates from './templates-repo'
import * as trash from './trash-repo'
// The newer feature repos live in src/main/repos/, outside this folder.
import * as consentRepo from '../repos/consent-repo'
import * as voiceprintRepo from '../repos/voiceprint-repo'
import * as transcriptReportsRepo from '../repos/transcript-reports-repo'
import * as retentionRepo from '../repos/retention-repo'
import * as meetingDockRepo from '../repos/meeting-dock-repo'
import * as remindersRepo from '../repos/reminders-repo'
import * as recurringRecapRepo from '../repos/recurring-recap-repo'
import * as liveContextRepo from '../repos/live-context-repo'
import * as tasksRepo from '../repos/tasks-repo'
import * as summaryFeedbackRepo from '../repos/summary-feedback-repo'
import * as userContextRepo from '../repos/user-context-repo'
import * as dispatchRepo from '../repos/dispatch-repo'
import * as localApiRepo from '../repos/local-api-repo'
import * as generalRepo from '../repos/general-repo'
import * as localOnlyRepo from '../repos/local-only-repo'
import * as blocksRepo from '../repos/blocks-repo'
import * as automationsRepo from '../repos/automations-repo'
import * as crmRepo from '../repos/crm-repo'
import * as webhooksRepo from '../repos/webhooks-repo'
import {
  DB_FILE,
  SCHEMA_VERSION,
  type DataMethods,
  type OpenParams,
  type SyncMethods,
  type WorkerEvent,
  type WorkerMethod,
  type WorkerReply,
  type WorkerRequest,
  type WorkerStatus
} from './protocol'
import { StoreError, type Db, type StoreCtx } from './store'
import * as transcript from './transcript-repo'
import { exportYdocState, YdocLog } from './ydoc-log'

/**
 * The upgrade from the early schemas (1–7) to the baseline, when this build includes it
 * (legacy-upgrade.ts). Without it an early database fails to open as `migration-failed`,
 * untouched; it is never re-created.
 */
interface LegacyUpgrade {
  upgradeToBaseline(db: Db, from: number): void
}
const LEGACY: LegacyUpgrade | null =
  Object.values(import.meta.glob<LegacyUpgrade>('./legacy-upgrade.ts', { eager: true }))[0] ?? null

/** Slow-query log threshold (10 s). */
const SLOW_MS = 10_000

/** The trash purge and stale-room cleanup run shortly after open, then every 24 h. */
const RETENTION_FIRST_DELAY_MS = 3_000
const RETENTION_EVERY_MS = 24 * 3_600_000

/**
 * Calls whose rows queue files in `file_deletions` (directly or through the migration-4
 * triggers): the queue is processed right after each one.
 */
const DELETING_METHODS: ReadonlySet<string> = new Set([
  'deleteNotePermanently',
  'deleteAttachment',
  'deleteRecordings',
  'deleteDictationAttempts',
  'deleteFolder',
  'deleteChatThread',
  // Deletes the batch's emptied folders.
  'undoImportBatch'
])

/** The worker status plus the open-time count of damaged rooms (StorageStatus.damagedRooms). */
export type EngineStatus = WorkerStatus & { damagedRooms?: number }

const KEY_HEX = /^[0-9a-f]{64}$/i

type LogLevel = Extract<WorkerEvent, { type: 'log' }>['level']

function sqliteCode(err: unknown): string {
  return typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : ''
}

function isCorruption(err: unknown): boolean {
  const code = sqliteCode(err)
  return code === 'SQLITE_NOTADB' || code.startsWith('SQLITE_CORRUPT')
}

function describe(err: unknown): string {
  const code = sqliteCode(err)
  if (code === 'SQLITE_NOTADB') {
    return 'The database could not be opened with this computer’s key, or the file is damaged (SQLITE_NOTADB).'
  }
  if (code.startsWith('SQLITE_CORRUPT')) return `The database file is damaged (${code}).`
  const message = err instanceof Error ? err.message : String(err)
  return code ? `${message} (${code})` : message
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/** A partial copy and its side files, when present. */
function removeCopy(path: string): void {
  for (const f of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) {
    try {
      if (existsSync(f) && statSync(f).isFile()) rmSync(f)
    } catch {
      // left in the backups folder; never read back (it isn't a .db)
    }
  }
}

export class StorageEngine {
  private db: Db | null = null
  private store: StoreCtx | null = null
  private status: WorkerStatus = { state: 'closed', expectedVersion: SCHEMA_VERSION }
  private fts: FtsIndexer | null = null
  private ydocs: YdocLog | null = null
  private retentionTimer: NodeJS.Timeout | null = null
  private readonly pending = { tables: new Set<string>(), ids: new Set<string>(), queued: false }

  constructor(private readonly emit: (e: WorkerEvent) => void) {}

  // ---------- dispatch ----------

  handle(req: WorkerRequest): WorkerReply {
    const started = Date.now()
    try {
      const fn = Object.hasOwn(this.methods, req.method)
        ? (this.methods[req.method] as (...a: unknown[]) => unknown)
        : undefined
      if (!fn) throw new StoreError('invalid-input', `unknown storage method ${String(req.method)}`)
      const result = fn(...(Array.isArray(req.params) ? req.params : []))
      if (DELETING_METHODS.has(req.method)) this.processFileDeletions()
      return { id: req.id, ok: true, result: result === undefined ? null : result }
    } catch (err) {
      return { id: req.id, ok: false, error: this.toError(req.method, err) }
    } finally {
      const ms = Date.now() - started
      if (ms >= SLOW_MS) this.log('warn', 'sqlite-exec-slow', { method: req.method, ms })
    }
  }

  private toError(method: WorkerMethod, err: unknown): { code: ErrorCode; message: string } {
    if (err instanceof StoreError) return { code: err.code, message: err.message }
    if (isCorruption(err) && this.db) {
      // Mid-session corruption: stop using the file and tell main.
      this.log('error', 'sqlite-corrupt', { method, err })
      this.fail('open-failed', { expectedVersion: this.status.expectedVersion }, describe(err))
      this.emit({ type: 'status', status: this.status })
      return { code: 'storage-unavailable', message: describe(err) }
    }
    const code = sqliteCode(err)
    this.log('error', 'sqlite-exec-error', { method, code, message: err instanceof Error ? err.message : String(err) })
    if (code.startsWith('SQLITE_CONSTRAINT')) return { code: 'invalid-input', message: describe(err) }
    return { code: 'internal', message: describe(err) }
  }

  /** The repositories' context while `ready`; otherwise `storage-unavailable`. */
  private need(): StoreCtx {
    if (this.status.state !== 'ready' || !this.store) {
      throw new StoreError('storage-unavailable', `storage is ${this.status.state}`)
    }
    return this.store
  }

  private readonly data: SyncMethods<DataMethods> = {
    identity: () => this.need().identity,
    listNotes: (q) => notes.listNotes(this.need(), q),
    getNote: (id, opts) => notes.getNote(this.need(), id, opts),
    createNote: (input) => notes.createNote(this.need(), input),
    updateNote: (id, patch) => notes.updateNote(this.need(), id, patch),
    setAttachedLinks: (id, links) => notes.updateNote(this.need(), id, { saved_links: links }),
    trashNote: (id) => notes.trashNote(this.need(), id),
    restoreNote: (id) => notes.restoreNote(this.need(), id),
    findNoteByEvent: (eventId, startTime) => notes.findNoteByEvent(this.need(), eventId, startTime),
    setTranscribe: (id, value) => notes.setTranscribe(this.need(), id, value),
    incrementMeetingEndCount: (id) => notes.incrementMeetingEndCount(this.need(), id),
    loadYdoc: (roomId) => {
      this.need()
      return this.ydocs!.load(roomId)
    },
    appendYdoc: (roomId, update, origin) => {
      this.need()
      return this.ydocs!.append(roomId, update, origin)
    },
    listPanels: (noteId, opts) => panels.listPanels(this.need(), noteId, opts),
    getPanel: (id) => panels.getPanel(this.need(), id),
    createPanel: (p) => panels.createPanel(this.need(), p),
    updatePanel: (id, patch) => panels.updatePanel(this.need(), id, patch),
    listGeneratingPanels: () => panels.listGeneratingPanels(this.need()),
    getTranscript: (noteId) => transcript.getTranscript(this.need(), noteId),
    upsertChunks: (chunks) => transcript.upsertChunks(this.need(), chunks),
    createSession: (x) => transcript.createSession(this.need(), x),
    endSession: (id, endedAt, reason) => transcript.endSession(this.need(), id, endedAt, reason),
    latestSession: (noteId) => transcript.latestSession(this.need(), noteId),
    getSettingsRaw: () => kv.getSettingsRaw(this.need()),
    setSettingRaw: (key, value) => kv.setSettingRaw(this.need(), key, value),
    getSecretBlob: (id) => kv.getSecretBlob(this.need(), id),
    setSecretBlob: (id, blob) => kv.setSecretBlob(this.need(), id, blob),
    deleteSecretBlob: (id) => kv.deleteSecretBlob(this.need(), id),
    listSecretIds: () => kv.listSecretIds(this.need()),
    listTrash: () => trash.listTrash(this.need()),
    deleteNotePermanently: (id) => trash.deleteNotePermanently(this.need(), id),
    noteEmptiness: (id) => trash.noteEmptiness(this.need(), id),
    markNoteDeleted: (id) => trash.markNoteDeleted(this.need(), id),
    queryNotes: (q) => notes.queryNotes(this.need(), q),
    searchFts: (q) => searchFts(this.need(), q),
    exportYdocState: (roomId) => exportYdocState(this.need(), roomId),
    listTemplates: () => templates.listTemplates(this.need()),
    getTemplate: (id) => templates.getTemplate(this.need(), id),
    createTemplate: (t) => templates.createTemplate(this.need(), t),
    updateTemplate: (id, patch) => templates.updateTemplate(this.need(), id, patch),
    listRecipes: () => recipes.listRecipes(this.need()),
    getRecipe: (id) => recipes.getRecipe(this.need(), id),
    upsertRecipe: (r) => recipes.upsertRecipe(this.need(), r),
    setRecipeDeleted: (id, deleted) => recipes.setRecipeDeleted(this.need(), id, deleted),
    listChatThreads: (q) => chat.listChatThreads(this.need(), q),
    getChatThread: (id) => chat.getChatThread(this.need(), id),
    upsertChatThread: (t) => chat.upsertChatThread(this.need(), t),
    deleteChatThread: (id) => chat.deleteChatThread(this.need(), id),
    listChatMessages: (threadId) => chat.listChatMessages(this.need(), threadId),
    upsertChatMessage: (m) => chat.upsertChatMessage(this.need(), m),
    truncateChatMessagesAfter: (threadId, messageId) => chat.truncateChatMessagesAfter(this.need(), threadId, messageId),
    listCalendarSources: () => calendar.listCalendarSources(this.need()),
    upsertCalendarSource: (src) => calendar.upsertCalendarSource(this.need(), src),
    setCalendarSourceGrants: (sourceId, grants) => calendar.setCalendarSourceGrants(this.need(), sourceId, grants),
    removeCalendarSource: (id) => calendar.removeCalendarSource(this.need(), id),
    listCalendars: (sourceId) => calendar.listCalendars(this.need(), sourceId),
    replaceCalendars: (sourceId, calendars, defaults) =>
      calendar.replaceCalendars(this.need(), sourceId, calendars, defaults),
    setCalendarVisible: (calendarId, visible) => calendar.setCalendarVisible(this.need(), calendarId, visible),
    replaceSourceEvents: (sourceId, events, scope) => calendar.replaceSourceEvents(this.need(), sourceId, events, scope),
    listEventsInRange: (q) => calendar.listEventsInRange(this.need(), q),
    getCalendarEvent: (id) => calendar.getCalendarEvent(this.need(), id),
    upcomingEvents: (q) => calendar.upcomingEvents(this.need(), q),
    followEventUpdates: (events) => calendar.followEventUpdates(this.need(), events),
    participants: (q) => calendar.participants(this.need(), q),
    listFolders: () => folders.listFolders(this.need()),
    createFolder: (f) => folders.createFolder(this.need(), f),
    updateFolder: (id, patch) => folders.updateFolder(this.need(), id, patch),
    deleteFolder: (id) => {
      const s = this.need()
      // Migration 9's trigger pauses the series filed into the folder inside SQLite; publish them.
      const series = typeof id === 'string' ? sources.seriesInFolders(s, [id]) : []
      folders.deleteFolder(s, id)
      if (series.length) s.touch('source_series', ...series)
    },
    addNotesToFolder: (folderId, noteIds, source) => folders.addNotesToFolder(this.need(), folderId, noteIds, source),
    removeNoteFromFolder: (folderId, noteId) => folders.removeNoteFromFolder(this.need(), folderId, noteId),
    setFolderRule: (r) => folders.setFolderRule(this.need(), r),
    deleteFolderRule: (id) => folders.deleteFolderRule(this.need(), id),
    searchNotes: (query) => search.searchNotes(this.need(), query),
    listSpeakerNameSuggestions: (noteId) => speakerNames.listSpeakerNameSuggestions(this.need(), noteId),
    replaceSpeakerNameSuggestions: (noteId, rows) => speakerNames.replaceSpeakerNameSuggestions(this.need(), noteId, rows),
    deleteSpeakerNameSuggestion: (noteId, identityKey) => speakerNames.deleteSpeakerNameSuggestion(this.need(), noteId, identityKey),
    patchSpeakerNameSuggestion: (...a) => speakerNames.patchSpeakerNameSuggestion(this.need(), ...a),
    // speaker profiles (migration 12)
    ensureSelfPerson: (...a) => speakerPeople.ensureSelfPerson(this.need(), ...a),
    getSpeakerPerson: (...a) => speakerPeople.getSpeakerPerson(this.need(), ...a),
    findSpeakerPersonByEmail: (...a) => speakerPeople.findSpeakerPersonByEmail(this.need(), ...a),
    listSpeakerPeople: (...a) => speakerPeople.listSpeakerPeople(this.need(), ...a),
    createSpeakerPerson: (...a) => speakerPeople.createSpeakerPerson(this.need(), ...a),
    updateSpeakerPerson: (...a) => speakerPeople.updateSpeakerPerson(this.need(), ...a),
    linkSpeakerPersonEmail: (...a) => speakerPeople.linkSpeakerPersonEmail(this.need(), ...a),
    previewSpeakerMerge: (...a) => speakerPeople.previewSpeakerMerge(this.need(), ...a),
    mergeSpeakerPeople: (...a) => speakerPeople.mergeSpeakerPeople(this.need(), ...a),
    deleteSpeakerPerson: (...a) => speakerPeople.deleteSpeakerPerson(this.need(), ...a),
    knownSpeakerPeople: (...a) => speakerPeople.knownSpeakerPeople(this.need(), ...a),
    speakerPersonView: (...a) => speakerPeople.speakerPersonView(this.need(), ...a),
    speakerVoiceSummary: (...a) => speakerPeople.speakerVoiceSummary(this.need(), ...a),
    speakerVoiceGallery: (...a) => speakerVoice.speakerVoiceGallery(this.need(), ...a),
    addSpeakerExemplar: (...a) => speakerVoice.addSpeakerExemplar(this.need(), ...a),
    listSpeakerSamples: (...a) => speakerVoice.listSpeakerSamples(this.need(), ...a),
    removeSpeakerExemplar: (...a) => speakerVoice.removeSpeakerExemplar(this.need(), ...a),
    convertLegacyVoiceprints: (...a) => voiceprintRepo.convertLegacyVoiceprints(this.need(), ...a),
    saveSpeakerClusterVectors: (...a) => speakerVoice.saveSpeakerClusterVectors(this.need(), ...a),
    listSpeakerClusterVectors: (...a) => speakerVoice.listSpeakerClusterVectors(this.need(), ...a),
    notesWithSpeakerClusterVectors: (...a) => speakerVoice.notesWithSpeakerClusterVectors(this.need(), ...a),
    deleteSpeakerClusterVectors: (...a) => speakerVoice.deleteSpeakerClusterVectors(this.need(), ...a),
    addSpeakerNegative: (...a) => speakerVoice.addSpeakerNegative(this.need(), ...a),
    deleteSpeakerNegative: (...a) => speakerVoice.deleteSpeakerNegative(this.need(), ...a),
    listSpeakerNegatives: (...a) => speakerVoice.listSpeakerNegatives(this.need(), ...a),
    remapSpeakerNegatives: (...a) => speakerVoice.remapSpeakerNegatives(this.need(), ...a),
    addSpeakerPending: (...a) => speakerVoice.addSpeakerPending(this.need(), ...a),
    listSpeakerPending: (...a) => speakerVoice.listSpeakerPending(this.need(), ...a),
    deleteSpeakerPending: (...a) => speakerVoice.deleteSpeakerPending(this.need(), ...a),
    recordSpeakerAgreement: (...a) => speakerAgreements.recordSpeakerAgreement(this.need(), ...a),
    getSpeakerAgreement: (...a) => speakerAgreements.getSpeakerAgreement(this.need(), ...a),
    listSpeakerAgreements: (...a) => speakerAgreements.listSpeakerAgreements(this.need(), ...a),
    deleteSpeakerAgreement: (...a) => speakerAgreements.deleteSpeakerAgreement(this.need(), ...a),
    forgetSpeakerVoice: (...a) => speakerVoice.forgetSpeakerVoice(this.need(), ...a),
    forgetAllSpeakerVoices: (...a) => speakerVoice.forgetAllSpeakerVoices(this.need(), ...a),
    sweepSpeakerData: (...a) => speakerVoice.sweepSpeakerData(this.need(), ...a),
    recordSpeakerMatches: (...a) => speakerPeople.recordSpeakerMatches(this.need(), ...a),
    listSpeakerMatches: (...a) => speakerPeople.listSpeakerMatches(this.need(), ...a),
    createRecording: (r) => recordings.createRecording(this.need(), r),
    updateRecording: (id, patch) => recordings.updateRecording(this.need(), id, patch),
    listRecordings: (q) => recordings.listRecordings(this.need(), q),
    deleteRecordings: (ids) => recordings.deleteRecordings(this.need(), ids),
    recordingsUsage: () => recordings.recordingsUsage(this.need()),
    markInterruptedRecordings: () => recordings.markInterruptedRecordings(this.need()),
    createImportJob: (j) => imports.createImportJob(this.need(), j),
    updateImportJob: (id, patch) => imports.updateImportJob(this.need(), id, patch),
    listImportJobs: () => imports.listImportJobs(this.need()),
    deleteImportJob: (id) => imports.deleteImportJob(this.need(), id),
    createAttachment: (a) => attachments.createAttachment(this.need(), a),
    readAttachment: (id) => attachments.readAttachment(this.need(), id),
    updateAttachment: (id, patch) => attachments.updateAttachment(this.need(), id, patch),
    listAttachments: (q) => attachments.listAttachments(this.need(), q),
    attachmentContent: (id) => attachments.attachmentContent(this.need(), id),
    deleteAttachment: (id) => attachments.deleteAttachment(this.need(), id),
    listActionItems: (q) => actionItems.listActionItems(this.need(), q),
    replaceNoteActionItems: (noteId, panelId, items) => actionItems.replaceNoteActionItems(this.need(), noteId, panelId, items),
    reviewActionItem: (id, review, reason) => actionItems.reviewActionItem(this.need(), id, review, reason),
    archiveActionItem: (id) => actionItems.archiveActionItem(this.need(), id),
    addActionItemFeedback: (f) => actionItems.addActionItemFeedback(this.need(), f),
    setActionItemDraftThread: (id, threadId) => actionItems.setActionItemDraftThread(this.need(), id, threadId),
    applyRegeneratedActionItems: (noteIds, items) => actionItems.applyRegeneratedActionItems(this.need(), noteIds, items),
    setClassifierTags: (noteId, t) => tags.setClassifierTags(this.need(), noteId, t),
    setManualMeetingType: (noteIds, value) => tags.setManualMeetingType(this.need(), noteIds, value),
    undoManualMeetingType: (undoToken) => tags.undoManualMeetingType(this.need(), undoToken),
    getFollowUpDraft: (q) => followUp.getFollowUpDraft(this.need(), q),
    upsertFollowUpDraft: (d) => followUp.upsertFollowUpDraft(this.need(), d),
    listFollowUpDrafts: (q) => followUp.listFollowUpDrafts(this.need(), q),
    listPeople: (q) => people.listPeople(this.need(), q),
    getPerson: (email, myEmails) => people.getPerson(this.need(), email, myEmails),
    listCompanies: (q) => people.listCompanies(this.need(), q),
    getCompany: (domain, o) => people.getCompany(this.need(), domain, o),
    recordRecipeUse: (recipeId) => recipeUsage.recordRecipeUse(this.need(), recipeId),
    recipeUsage: () => recipeUsage.recipeUsage(this.need()),
    setRecipeSaved: (recipeId, saved) => recipeUsage.setRecipeSaved(this.need(), recipeId, saved),
    listSavedRecipeIds: () => recipeUsage.listSavedRecipeIds(this.need()),
    getCompanyIcon: (domain) => companyIcons.getCompanyIcon(this.need(), domain),
    putCompanyIcon: (row) => companyIcons.putCompanyIcon(this.need(), row),
    deleteAllCompanyIcons: () => companyIcons.deleteAllCompanyIcons(this.need()),
    getBrief: (eventId) => briefs.getBrief(this.need(), eventId),
    upsertBrief: (b) => briefs.upsertBrief(this.need(), b),
    briefContext: (q) => briefs.briefContext(this.need(), q),
    listIntegrationDestinations: (q) => integrations.listIntegrationDestinations(this.need(), q),
    upsertIntegrationDestination: (d) => integrations.upsertIntegrationDestination(this.need(), d),
    deleteIntegrationDestinations: (q) => integrations.deleteIntegrationDestinations(this.need(), q),
    listIntegrationAutomations: (q) => integrations.listIntegrationAutomations(this.need(), q),
    upsertIntegrationAutomation: (a) => integrations.upsertIntegrationAutomation(this.need(), a),
    setIntegrationAutomationsEnabled: (provider, enabled) => integrations.setIntegrationAutomationsEnabled(this.need(), provider, enabled),
    claimAutomationRun: (automationId, noteId, result, deliveries) => integrations.claimAutomationRun(this.need(), automationId, noteId, result, deliveries),
    createIntegrationDeliveries: (ds) => integrations.createIntegrationDeliveries(this.need(), ds),
    updateIntegrationDelivery: (id, patch) => integrations.updateIntegrationDelivery(this.need(), id, patch),
    listIntegrationDeliveries: (q) => integrations.listIntegrationDeliveries(this.need(), q),
    dueIntegrationDeliveries: (now, limit) => integrations.dueIntegrationDeliveries(this.need(), now, limit),
    pendingAutomationNotes: (since) => integrations.pendingAutomationNotes(this.need(), since),
    expireIntegrationDeliveries: (before) => integrations.expireIntegrationDeliveries(this.need(), before),
    listMcpConnections: () => mcp.listMcpConnections(this.need()),
    upsertMcpConnection: (c) => mcp.upsertMcpConnection(this.need(), c),
    deleteMcpConnection: (id) => mcp.deleteMcpConnection(this.need(), id),
    listMcpServerTokens: () => mcp.listMcpServerTokens(this.need()),
    createMcpServerToken: (t) => mcp.createMcpServerToken(this.need(), t),
    findMcpServerToken: (tokenHash) => mcp.findMcpServerToken(this.need(), tokenHash),
    touchMcpServerToken: (id, at) => mcp.touchMcpServerToken(this.need(), id, at),
    deleteMcpServerToken: (id) => mcp.deleteMcpServerToken(this.need(), id),
    createDictationAttempt: (a) => dictation.createDictationAttempt(this.need(), a),
    updateDictationAttempt: (id, patch) => dictation.updateDictationAttempt(this.need(), id, patch),
    listDictationAttempts: (limit) => dictation.listDictationAttempts(this.need(), limit),
    getDictationAttempt: (id) => dictation.getDictationAttempt(this.need(), id),
    deleteDictationAttempts: (q) => dictation.deleteDictationAttempts(this.need(), q),
    markInterruptedDictations: () => dictation.markInterruptedDictations(this.need()),
    listScratchpadDays: (today) => scratchpad.listScratchpadDays(this.need(), today),
    getScratchpadDay: (date) => scratchpad.getScratchpadDay(this.need(), date),
    saveScratchpadDay: (date, content, hasText) => scratchpad.saveScratchpadDay(this.need(), date, content, hasText),
    listExportNotes: (q) => dataExport.listExportNotes(this.need(), q),
    writeExportNotes: (q) => dataExport.writeExportNotes(this.need(), q),
    writeExportIndex: (q) => dataExport.writeExportIndex(this.need(), q),
    writeExportReadme: (q) => dataExport.writeExportReadme(this.need(), q),
    writeDatabaseCopy: (q) => dataExport.writeDatabaseCopy(this.need(), q),
    getNoteSource: (...a) => sources.getNoteSource(this.need(), ...a),
    getNoteSourceView: (...a) => sources.getNoteSourceView(this.need(), ...a),
    createNoteSource: (...a) => sources.createNoteSource(this.need(), ...a),
    updateNoteSource: (...a) => sources.updateNoteSource(this.need(), ...a),
    deleteNoteSource: (...a) => sources.deleteNoteSource(this.need(), ...a),
    findNotesBySource: (...a) => sources.findNotesBySource(this.need(), ...a),
    listNoteSources: (...a) => sources.listNoteSources(this.need(), ...a),
    addSourceSpans: (...a) => sources.addSourceSpans(this.need(), ...a),
    listSourceSpans: (...a) => sources.listSourceSpans(this.need(), ...a),
    upsertSeries: (...a) => sources.upsertSeries(this.need(), ...a),
    getSeries: (...a) => sources.getSeries(this.need(), ...a),
    findSeriesByFolder: (...a) => sources.findSeriesByFolder(this.need(), ...a),
    listSeries: (...a) => sources.listSeries(this.need(), ...a),
    getSeriesDetail: (...a) => sources.getSeriesDetail(this.need(), ...a),
    updateSeries: (...a) => sources.updateSeries(this.need(), ...a),
    pauseSeries: (...a) => sources.pauseSeries(this.need(), ...a),
    replaceCatalog: (...a) => sources.replaceCatalog(this.need(), ...a),
    listCatalog: (...a) => sources.listCatalog(this.need(), ...a),
    deleteCatalog: (...a) => sources.deleteCatalog(this.need(), ...a),
    findCatalogItem: (...a) => sources.findCatalogItem(this.need(), ...a),
    applyLessonNumbers: (...a) => sources.applyLessonNumbers(this.need(), ...a),
    listSourceDuplicates: (...a) => sources.listSourceDuplicates(this.need(), ...a),
    mergeSourceNotes: (...a) => sources.mergeSourceNotes(this.need(), ...a),
    getSourceMerge: (...a) => sources.getSourceMerge(this.need(), ...a),
    setSourceMergeExtra: (...a) => sources.setSourceMergeExtra(this.need(), ...a),
    undoSourceMerge: (...a) => sources.undoSourceMerge(this.need(), ...a),
    createImportBatch: (...a) => importsMd.createImportBatch(this.need(), ...a),
    getImportBatch: (...a) => importsMd.getImportBatch(this.need(), ...a),
    listImportBatches: (...a) => importsMd.listImportBatches(this.need(), ...a),
    listImportItems: (...a) => importsMd.listImportItems(this.need(), ...a),
    updateImportBatch: (...a) => importsMd.updateImportBatch(this.need(), ...a),
    updateImportItem: (...a) => importsMd.updateImportItem(this.need(), ...a),
    findImportMatches: (...a) => importsMd.findImportMatches(this.need(), ...a),
    importNoteItem: (...a) => importsMd.importNoteItem(this.need(), ...a),
    importUndoPreview: (...a) => importsMd.importUndoPreview(this.need(), ...a),
    undoImportBatch: (...a) => importsMd.undoImportBatch(this.need(), ...a),
    clearImportHistory: (...a) => importsMd.clearImportHistory(this.need(), ...a),
    getImportCandidates: (...a) => importsMd.getImportCandidates(this.need(), ...a),
    // src/main/repos/
    getConsentPost: (...a) => consentRepo.getConsentPost(this.need(), ...a),
    upsertConsentPost: (...a) => consentRepo.upsertConsentPost(this.need(), ...a),
    getVoiceprint: (...a) => voiceprintRepo.getVoiceprint(this.need(), ...a),
    saveVoiceprint: (...a) => voiceprintRepo.saveVoiceprint(this.need(), ...a),
    deleteVoiceprints: (...a) => voiceprintRepo.deleteVoiceprints(this.need(), ...a),
    createTranscriptReport: (...a) => transcriptReportsRepo.createTranscriptReport(this.need(), ...a),
    listTranscriptReports: (...a) => transcriptReportsRepo.listTranscriptReports(this.need(), ...a),
    deleteTranscriptReport: (...a) => transcriptReportsRepo.deleteTranscriptReport(this.need(), ...a),
    reportExcerpt: (...a) => transcriptReportsRepo.reportExcerpt(this.need(), ...a),
    previewRetention: (...a) => retentionRepo.previewRetention(this.need(), ...a),
    purgeTranscripts: (...a) => retentionRepo.purgeTranscripts(this.need(), ...a),
    recordRetentionRun: (...a) => retentionRepo.recordRetentionRun(this.need(), ...a),
    listRetentionRuns: (...a) => retentionRepo.listRetentionRuns(this.need(), ...a),
    deleteTranscriptSections: (...a) => retentionRepo.deleteTranscriptSections(this.need(), ...a),
    getMeetingDockHistory: (...a) => meetingDockRepo.getMeetingDockHistory(this.need(), ...a),
    saveMeetingDockHistory: (...a) => meetingDockRepo.saveMeetingDockHistory(this.need(), ...a),
    listReminders: (...a) => remindersRepo.listReminders(this.need(), ...a),
    upsertReminders: (...a) => remindersRepo.upsertReminders(this.need(), ...a),
    pruneReminders: (...a) => remindersRepo.pruneReminders(this.need(), ...a),
    previousSeriesNote: (...a) => recurringRecapRepo.previousSeriesNote(this.need(), ...a),
    getRecurringRecap: (...a) => recurringRecapRepo.getRecurringRecap(this.need(), ...a),
    putRecurringRecap: (...a) => recurringRecapRepo.putRecurringRecap(this.need(), ...a),
    findFreeSlot: (...a) => liveContextRepo.findFreeSlot(this.need(), ...a),
    listTasks: (...a) => tasksRepo.listTasks(this.need(), ...a),
    toggleTaskItem: (...a) => tasksRepo.toggleTaskItem(this.need(), ...a),
    addManualTask: (...a) => tasksRepo.addManualTask(this.need(), ...a),
    setManualTask: (...a) => tasksRepo.setManualTask(this.need(), ...a),
    deleteManualTask: (...a) => tasksRepo.deleteManualTask(this.need(), ...a),
    taskBadge: (...a) => tasksRepo.taskBadge(this.need(), ...a),
    summaryFeedbackFacts: (...a) => summaryFeedbackRepo.summaryFeedbackFacts(this.need(), ...a),
    upsertSummaryFeedback: (...a) => summaryFeedbackRepo.upsertSummaryFeedback(this.need(), ...a),
    listSummaryFeedback: (...a) => summaryFeedbackRepo.listSummaryFeedback(this.need(), ...a),
    listUserContextSections: (...a) => userContextRepo.listUserContextSections(this.need(), ...a),
    upsertUserContextSection: (...a) => userContextRepo.upsertUserContextSection(this.need(), ...a),
    userContextPeople: (...a) => userContextRepo.userContextPeople(this.need(), ...a),
    userContextDraftInputs: (...a) => userContextRepo.userContextDraftInputs(this.need(), ...a),
    userContextRecordedNotes: (...a) => userContextRepo.userContextRecordedNotes(this.need(), ...a),
    listDispatchTodos: (...a) => dispatchRepo.listDispatchTodos(this.need(), ...a),
    upsertDispatchTodos: (...a) => dispatchRepo.upsertDispatchTodos(this.need(), ...a),
    setDispatchTodoStatus: (...a) => dispatchRepo.setDispatchTodoStatus(this.need(), ...a),
    listDispatches: (...a) => dispatchRepo.listDispatches(this.need(), ...a),
    insertDispatches: (...a) => dispatchRepo.insertDispatches(this.need(), ...a),
    resurfaceDispatches: (...a) => dispatchRepo.resurfaceDispatches(this.need(), ...a),
    archiveUnstartedDispatches: (...a) => dispatchRepo.archiveUnstartedDispatches(this.need(), ...a),
    setDispatch: (...a) => dispatchRepo.setDispatch(this.need(), ...a),
    getDispatchRun: (...a) => dispatchRepo.getDispatchRun(this.need(), ...a),
    upsertDispatchRun: (...a) => dispatchRepo.upsertDispatchRun(this.need(), ...a),
    pruneDispatchRuns: (...a) => dispatchRepo.pruneDispatchRuns(this.need(), ...a),
    listLocalApiKeys: (...a) => localApiRepo.listLocalApiKeys(this.need(), ...a),
    createLocalApiKey: (...a) => localApiRepo.createLocalApiKey(this.need(), ...a),
    findLocalApiKey: (...a) => localApiRepo.findLocalApiKey(this.need(), ...a),
    updateLocalApiKey: (...a) => localApiRepo.updateLocalApiKey(this.need(), ...a),
    touchLocalApiKey: (...a) => localApiRepo.touchLocalApiKey(this.need(), ...a),
    deleteLocalApiKey: (...a) => localApiRepo.deleteLocalApiKey(this.need(), ...a),
    apiListNotes: (...a) => localApiRepo.apiListNotes(this.need(), ...a),
    apiGetNotes: (...a) => localApiRepo.apiGetNotes(this.need(), ...a),
    apiTranscript: (...a) => localApiRepo.apiTranscript(this.need(), ...a),
    apiListFolders: (...a) => localApiRepo.apiListFolders(this.need(), ...a),
    apiListSeries: (...a) => localApiRepo.apiListSeries(this.need(), ...a),
    apiGetSeries: (...a) => localApiRepo.apiGetSeries(this.need(), ...a),
    noteCount: (...a) => generalRepo.noteCount(this.need(), ...a),
    databaseCreatedAt: (...a) => generalRepo.databaseCreatedAt(this.need(), ...a),
    holdDueIntegrationDeliveries: (...a) => localOnlyRepo.holdDueIntegrationDeliveries(this.need(), ...a),
    listHeldIntegrationDeliveries: (...a) => localOnlyRepo.listHeldIntegrationDeliveries(this.need(), ...a),
    releaseHeldIntegrationDelivery: (...a) => localOnlyRepo.releaseHeldIntegrationDelivery(this.need(), ...a),
    getWorkflowBlock: (...a) => blocksRepo.getWorkflowBlock(this.need(), ...a),
    listWorkflowBlocks: (...a) => blocksRepo.listWorkflowBlocks(this.need(), ...a),
    createWorkflowBlock: (...a) => blocksRepo.createWorkflowBlock(this.need(), ...a),
    updateWorkflowBlock: (...a) => blocksRepo.updateWorkflowBlock(this.need(), ...a),
    setBlockExecution: (...a) => blocksRepo.setBlockExecution(this.need(), ...a),
    listAutomationRules: (...a) => automationsRepo.listAutomationRules(this.need(), ...a),
    upsertAutomationRule: (...a) => automationsRepo.upsertAutomationRule(this.need(), ...a),
    deleteAutomationRule: (...a) => automationsRepo.deleteAutomationRule(this.need(), ...a),
    claimAutomationRunOnce: (...a) => automationsRepo.claimAutomationRunOnce(this.need(), ...a),
    updateAutomationRun: (...a) => automationsRepo.updateAutomationRun(this.need(), ...a),
    listAutomationRuns: (...a) => automationsRepo.listAutomationRuns(this.need(), ...a),
    endedMeetingNotes: (...a) => automationsRepo.endedMeetingNotes(this.need(), ...a),
    automationFacts: (...a) => automationsRepo.automationFacts(this.need(), ...a),
    customerCallsBacklog: (...a) => crmRepo.customerCallsBacklog(this.need(), ...a),
    customerCallsSyncStatus: (...a) => crmRepo.customerCallsSyncStatus(this.need(), ...a),
    listWebhookEndpoints: (...a) => webhooksRepo.listWebhookEndpoints(this.need(), ...a),
    upsertWebhookEndpoint: (...a) => webhooksRepo.upsertWebhookEndpoint(this.need(), ...a),
    deleteWebhookEndpoint: (...a) => webhooksRepo.deleteWebhookEndpoint(this.need(), ...a),
    recordWebhookResult: (...a) => webhooksRepo.recordWebhookResult(this.need(), ...a)
  }

  private readonly methods: Record<WorkerMethod, unknown> = {
    ...this.data,
    open: (p: OpenParams) => this.open(p),
    close: () => this.close(),
    checkpoint: () => {
      if (this.db) this.db.pragma('wal_checkpoint(TRUNCATE)')
    },
    debugSearch: (query: string) => {
      this.need()
      return this.fts!.search(query)
    }
  }

  // ---------- lifecycle ----------

  open(p: OpenParams): WorkerStatus {
    this.close()
    const migrations = p.devFailMigration ? [...MIGRATIONS, DEV_FAIL_MIGRATION] : [...MIGRATIONS]
    const target = migrations[migrations.length - 1]!.version
    const base = { expectedVersion: target }
    if (!KEY_HEX.test(p.keyHex)) return this.fail('open-failed', base, 'The database key has the wrong format.')

    const dbPath = join(p.dataDir, DB_FILE)
    try {
      mkdirSync(p.dataDir, { recursive: true })
    } catch (err) {
      return this.fail('open-failed', base, describe(err))
    }
    const existed = existsSync(dbPath) && statSync(dbPath).size > 0
    let version = 0

    // 1. An existing file is probed read-only first: the key and the schema
    //    version are checked before anything can be written.
    if (existed) {
      const sideFiles = [`${dbPath}-wal`, `${dbPath}-shm`]
      const preexisting = sideFiles.filter((f) => existsSync(f))
      let probe: Db | null = null
      try {
        probe = this.connect(dbPath, p.keyHex, { readonly: true, fileMustExist: true })
        version = probe.pragma('user_version', { simple: true }) as number
      } catch (err) {
        this.log('error', 'sqlite-open-failed', { stage: 'probe', err })
        return this.fail('open-failed', base, describe(err))
      } finally {
        probe?.close()
        this.removeProbeLeftovers(sideFiles, preexisting)
      }
      if (version > target || p.devVersionAhead) {
        this.log('warn', 'sqlite-version-ahead', { version, expected: target, simulated: p.devVersionAhead })
        return this.fail(
          'version-ahead',
          { ...base, schemaVersion: p.devVersionAhead && version <= target ? target + 1 : version },
          p.devVersionAhead ? 'Simulated by NOTULA_DEV_VERSION_AHEAD.' : undefined
        )
      }
    } else {
      if (p.devVersionAhead) {
        return this.fail('version-ahead', { ...base, schemaVersion: target + 1 }, 'Simulated by NOTULA_DEV_VERSION_AHEAD.')
      }
      const orphans = [`${dbPath}-wal`, `${dbPath}-shm`].filter((f) => existsSync(f) && statSync(f).size > 0)
      if (orphans.length) {
        return this.fail('open-failed', base, 'Database side files were found without the database file.')
      }
    }

    // 2. Open for writing.
    let db: Db
    try {
      db = this.connect(dbPath, p.keyHex, {})
      db.pragma('journal_mode = WAL')
      db.pragma('synchronous = NORMAL')
      db.pragma('foreign_keys = ON')
      db.pragma('busy_timeout = 5000')
      db.pragma('temp_store = MEMORY')
      version = db.pragma('user_version', { simple: true }) as number
    } catch (err) {
      this.log('error', 'sqlite-open-failed', { stage: 'open', err })
      return this.fail('open-failed', base, describe(err))
    }

    // 3. Migrate: back up, then every pending migration in one transaction.
    let backupPath: string | undefined
    if (version < target) {
      if (existed) {
        try {
          backupPath = this.backup(db, p.dataDir, version)
        } catch (err) {
          db.close()
          this.log('error', 'sqlite-backup-failed', { err })
          return this.fail('migration-failed', { ...base, schemaVersion: version }, `Backup failed: ${describe(err)}`)
        }
      }
      const failure = this.migrate(db, migrations, version, target)
      if (failure) {
        db.close()
        return this.fail('migration-failed', { ...base, schemaVersion: version, ...(backupPath ? { backupPath } : {}) }, failure)
      }
      this.log('info', 'sqlite-migrated', { from: version, to: target, backupPath: backupPath ?? null })
      version = target
    } else {
      this.log('info', 'sqlite-schema-current', { version })
    }

    // 4. Identity, housekeeping, optimize.
    let identity: StorageIdentity
    try {
      identity = kv.ensureMeta(db, p.appVersion, PREFS_VERSION)
    } catch (err) {
      db.close()
      return this.fail('open-failed', { ...base, schemaVersion: version }, describe(err))
    }
    this.db = db
    this.store = {
      db,
      identity,
      tmpDir: trash.tmpDirFor(p.dataDir),
      userDataDir: trash.userDataDirFor(p.dataDir),
      touch: (table, ...ids) => this.touch(table, ids),
      log: (level, event, data) => this.log(level, event, data)
    }
    try {
      attachments.sweepPartials(this.store)
    } catch (err) {
      this.log('error', 'attachment-partial-sweep-failed', { err })
    }
    let damagedRooms = 0
    try {
      damagedRooms = trash.countDamagedRooms(this.store)
      if (damagedRooms) this.log('warn', 'ydoc-damaged-rooms', { rooms: damagedRooms })
    } catch (err) {
      this.log('error', 'ydoc-damaged-count-failed', { err })
    }
    const ready: EngineStatus = {
      state: 'ready',
      schemaVersion: version,
      expectedVersion: target,
      ...(backupPath ? { backupPath } : {}),
      ...(damagedRooms ? { damagedRooms } : {})
    }
    this.status = ready
    this.fts = new FtsIndexer(() => this.liveStore())
    this.ydocs = new YdocLog(() => this.liveStore())
    if (p.housekeeping) {
      try {
        const transcribeReset = notes.resetTranscribeFlags(this.store)
        const chunksFinalized = transcript.finalizePartialChunks(this.store)
        if (transcribeReset || chunksFinalized) this.log('info', 'startup-housekeeping', { transcribeReset, chunksFinalized })
      } catch (err) {
        this.log('error', 'startup-housekeeping-failed', { err })
      }
      // Speaker profiles: the self row exists once the identity does.
      try {
        speakerPeople.ensureSelfPerson(this.store, String(kv.getSettingsRaw(this.store)['profile.name'] ?? ''))
      } catch (err) {
        this.log('error', 'speakers:self-person-failed', { err })
      }
    }
    try {
      db.pragma('optimize = 0x10002')
    } catch (err) {
      this.log('warn', 'sqlite-optimize-failed', { err })
    }
    this.fts.backfill()
    this.scheduleRetention(RETENTION_FIRST_DELAY_MS)
    return this.status
  }

  // ---------- retention ----------

  private scheduleRetention(delay: number): void {
    if (this.retentionTimer) clearTimeout(this.retentionTimer)
    this.retentionTimer = setTimeout(() => {
      this.retentionTimer = null
      this.runRetention()
      if (this.liveStore()) this.scheduleRetention(RETENTION_EVERY_MS)
    }, delay)
  }

  /**
   * The 30-day purge, then the stale-room cleanup, then the queued file deletions.
   * Only while `ready`: never in a recovery or closed state.
   */
  private runRetention(): void {
    const s = this.liveStore()
    if (!s) return
    try {
      trash.purgeExpiredTrash(s, Date.now())
    } catch (err) {
      this.log('error', 'trash-purge-failed', { err })
    }
    try {
      trash.cleanupStaleRooms(s)
    } catch (err) {
      this.log('error', 'stale-room-cleanup-failed', { err })
    }
    try {
      trash.processFileDeletions(s)
    } catch (err) {
      this.log('error', 'file-deletions-failed', { err })
    }
  }

  /** After a deleting call: never fails the call itself (a failure is retried at the next run). */
  private processFileDeletions(): void {
    const s = this.liveStore()
    if (!s) return
    try {
      trash.processFileDeletions(s)
    } catch (err) {
      this.log('error', 'file-deletions-failed', { err })
    }
  }

  close(): void {
    if (this.retentionTimer) clearTimeout(this.retentionTimer)
    this.retentionTimer = null
    this.fts?.stop()
    this.ydocs?.stop()
    this.fts = null
    this.ydocs = null
    if (this.db) {
      try {
        this.db.pragma('optimize')
      } catch {
        // best effort
      }
      try {
        this.db.close()
      } catch (err) {
        this.log('error', 'sqlite-close-failed', { err })
      }
    }
    this.db = null
    this.store = null
    this.status = { state: 'closed', expectedVersion: this.status.expectedVersion }
  }

  private liveStore(): StoreCtx | null {
    return this.status.state === 'ready' ? this.store : null
  }

  private connect(path: string, keyHex: string, opts: { readonly?: boolean; fileMustExist?: boolean }): Db {
    const db = new Database(path, opts)
    try {
      db.pragma(`cipher = 'sqlcipher'`)
      db.pragma('legacy = 4')
      db.pragma(`key = "x'${keyHex}'"`)
      // Any read fails with SQLITE_NOTADB when the key does not match.
      db.prepare('SELECT count(*) FROM sqlite_master').get()
      return db
    } catch (err) {
      db.close()
      throw err
    }
  }

  /**
   * A read-only connection creates an empty -wal and an -shm index it cannot remove
   * on close. Remove only those the probe itself created, and only while the WAL is
   * empty, so a probe leaves the data folder exactly as it found it.
   */
  private removeProbeLeftovers(sideFiles: string[], preexisting: string[]): void {
    const [wal] = sideFiles
    if (!wal || preexisting.length || !existsSync(wal) || statSync(wal).size !== 0) return
    for (const f of sideFiles) {
      try {
        if (existsSync(f)) unlinkSync(f)
      } catch (err) {
        this.log('warn', 'sqlite-probe-cleanup-failed', { file: f, err })
      }
    }
  }

  /**
   * WAL checkpoint, then a copy still encrypted with the same key, written through `VACUUM INTO`
   * with the biometric tables cleared (the speaker-profile voice tables; `speaker_agreements` stays). The copy
   * is checked by `integrity_check` plus per-table row counts against the live database before it
   * is kept, and a retried migration reuses a previous same-version backup only when that check
   * passes again.
   */
  private backup(db: Db, dataDir: string, from: number): string {
    const [cp] = db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[]
    if (cp && cp.busy) throw new Error('the WAL could not be checkpointed')
    const dir = join(dataDir, 'backups')
    mkdirSync(dir, { recursive: true })
    // A retried migration (Try again) meets the same file again: the failed attempt was
    // rolled back. Reuse that backup rather than writing another full copy.
    // Older backups are never pruned or rewritten here: one an earlier build made as a byte copy
    // keeps whatever voice data it held, and the dialogs that forget your own voice say where
    // those backups are (`forgetOldBackups` in the speaker-profile strings).
    const previous = readdirSync(dir)
      .filter((n) => n.startsWith(`notula-v${from}-`) && n.endsWith('.db'))
      .sort()
      .pop()
    if (previous) {
      const why = this.checkBackup(db, join(dir, previous))
      if (!why) {
        this.log('info', 'sqlite-backup-reused', { backup: previous })
        return join(dir, previous)
      }
      this.log('info', 'sqlite-backup-not-reused', { backup: previous, reason: why })
    }
    const dest = join(dir, `notula-v${from}-${stamp()}.db`)
    const partial = `${dest}.partial`
    removeCopy(partial)
    try {
      dataExport.writeCopyWithoutVoices(db, partial, trash.tmpDirFor(dataDir))
      const why = this.checkBackup(db, partial)
      if (why) throw new Error(`the backup check failed: ${why}`)
      renameSync(partial, dest)
    } catch (err) {
      removeCopy(partial)
      throw err
    }
    return dest
  }

  /**
   * Null when the copy at `path` passes `integrity_check`, holds every live table with the same
   * row count (the biometric tables excluded) and holds no biometric row; else the reason.
   */
  private checkBackup(db: Db, path: string): string | null {
    const quoted = path.split("'").join("''")
    try {
      db.exec(`ATTACH DATABASE '${quoted}' AS backup_check`)
    } catch (err) {
      return describe(err)
    }
    try {
      const ok = db.pragma('backup_check.integrity_check', { simple: true })
      if (ok !== 'ok') return `integrity_check: ${String(ok)}`
      const tables = (schema: string): Set<string> =>
        new Set(
          (
            db
              .prepare(
                `SELECT name FROM ${schema}.sqlite_master
                 WHERE type = 'table' AND name NOT LIKE 'sqlite!_%' ESCAPE '!' AND sql NOT LIKE 'CREATE VIRTUAL%'`
              )
              .all() as { name: string }[]
          ).map((r) => r.name)
        )
      const copy = tables('backup_check')
      for (const t of tables('main')) {
        if (!copy.has(t)) return `table ${t} is missing`
        const n = (db.prepare(`SELECT count(*) AS n FROM backup_check."${t}"`).get() as { n: number }).n
        if ((dataExport.BIOMETRIC_TABLES as readonly string[]).includes(t)) {
          if (n !== 0) return `table ${t} holds voice data`
          continue
        }
        const m = (db.prepare(`SELECT count(*) AS n FROM main."${t}"`).get() as { n: number }).n
        if (m !== n) return `table ${t} has ${n} rows, the database ${m}`
      }
      return null
    } catch (err) {
      return describe(err)
    } finally {
      try {
        db.exec('DETACH DATABASE backup_check')
      } catch (err) {
        this.log('warn', 'sqlite-backup-detach-failed', { err })
      }
    }
  }

  /** Returns null on success, or the failure detail after a rollback. */
  private migrate(db: Db, migrations: Migration[], from: number, to: number): string | null {
    let current: Pick<Migration, 'version' | 'name'> | null = null
    try {
      db.exec('BEGIN IMMEDIATE')
      // An early schema reaches the baseline through the legacy upgrade, never through it.
      let at = from
      if (from > 0 && from < BASELINE_VERSION) {
        current = { version: BASELINE_VERSION, name: 'legacy-upgrade' }
        if (!LEGACY) throw new Error(`schema ${from} is from an early build, and this build has no upgrade for it`)
        LEGACY.upgradeToBaseline(db, from)
        at = BASELINE_VERSION
      }
      for (const m of migrations) {
        if (m.version <= at) continue
        current = m
        db.exec(m.sql)
      }
      db.pragma(`user_version = ${to}`)
      db.exec('COMMIT')
      return null
    } catch (err) {
      try {
        if (db.inTransaction) db.exec('ROLLBACK')
      } catch (rollbackErr) {
        this.log('error', 'sqlite-rollback-failed', { err: rollbackErr })
      }
      const where = current ? `Migration ${current.version} (${current.name})` : 'The migration'
      this.log('error', 'sqlite-migrate-failed', { from, to, migration: current?.version ?? null, err })
      return `${where} failed and was rolled back: ${describe(err)}`
    }
  }

  private fail(state: WorkerStatus['state'], base: Omit<WorkerStatus, 'state'>, detail?: string): WorkerStatus {
    this.close()
    this.status = { ...base, state, ...(detail ? { detail } : {}) }
    return this.status
  }

  // ---------- change feed ----------

  /** Coalesces committed writes per microtask into one `changed` event. */
  private touch(table: string, ids: string[]): void {
    this.pending.tables.add(table)
    for (const id of ids) this.pending.ids.add(id)
    if (table === 'documents' || table === 'note_panels') this.fts?.schedule()
    if (this.pending.queued) return
    this.pending.queued = true
    queueMicrotask(() => {
      const tables = [...this.pending.tables]
      const ids = [...this.pending.ids]
      this.pending.tables.clear()
      this.pending.ids.clear()
      this.pending.queued = false
      this.emit({ type: 'changed', tables, ids })
    })
  }

  private log(level: LogLevel, event: string, data?: Record<string, unknown>): void {
    this.emit({ type: 'log', level, event, ...(data ? { data: serializable(data) } : {}) })
  }
}

/** Errors do not survive structured clone with their fields; flatten them for the log. */
function serializable(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) {
    out[k] = v instanceof Error ? { name: v.name, message: v.message, code: sqliteCode(v) || undefined } : v
  }
  return out
}
