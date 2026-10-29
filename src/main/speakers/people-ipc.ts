// SPDX-License-Identifier: Apache-2.0
// The `speaker-people:*` handlers and `speakers:forget-all`.
// Main writes the agreement message to the clipboard itself, and `agreement-text` is logged as
// an action, never with its content.
//
// Nothing biometric crosses here: the renderer gets names, ids, counts, dates and the agreement's
// display fields. The notice text and the evidence leave main only on `agreement-text` (View
// message) and in the file the user saves with `export-agreement`. Every voice change bumps the
// voice generation on both sides of its storage call and pushes `speaker-people:changed`.

import { writeFile } from 'node:fs/promises'
import { clipboard, dialog, ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes, PushChannel } from '@shared/ipc'
import { displayName, isResourceEmail } from '@shared/lib/people'
import { AGREEMENT_SENDER_REQUIRED, VOICE_AGREEMENT_VERSION, voiceAgreementMessage } from '@shared/lib/speaker-notices'
import { speakerTurns } from '@shared/lib/speakers'
import {
  SPEAKER_PROFILE_LIMITS,
  type SpeakerAgreementMethod,
  type SpeakerNoticeLanguage,
  type SpeakerRosterRow
} from '@shared/types/speakers'
import { speakerIdModelId } from '../asr/manifest'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { myEmails } from '../people'
import type { SpeakerAgreementRow } from '../storage/api'
import { deferUndoable } from './undo'
import { voiceGeneration, type VoiceGenReason } from './voice-gen'

const MAX_ID = 200
const MAX_QUERY = 200
const ROSTER_ATTENDEES = 50
const ROSTER_PEOPLE = 50
/** A picked turn is searched this far around the time when no turn holds it. */
const PICK_SLACK_MS = 5_000
const METHODS: readonly SpeakerAgreementMethod[] = ['email', 'spoken', 'written', 'other']

function bad(message: string): Error {
  return expected(notulaError('invalid-input', message))
}

function obj(req: unknown): Record<string, unknown> {
  return req && typeof req === 'object' ? (req as Record<string, unknown>) : {}
}

function idOf(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v || v.length > MAX_ID) throw bad(`${what} is required.`)
  return v
}

function confirmed(r: Record<string, unknown>): void {
  if (r['confirmed'] !== true) throw bad('This needs a confirmation.')
}

function languageOf(v: unknown): SpeakerNoticeLanguage {
  if (v !== 'en' && v !== 'pt') throw bad('language must be en or pt.')
  return v
}

/** The installed extractor's id: every stored vector of another id is stale. */
function modelId(): string {
  return speakerIdModelId()
}

/**
 * A voice-changing storage call with the generation bumped before and after it.
 * Storage runs in a worker, so the call is a real window: a job that read the generation before
 * the first bump, or between the two while the old rows were still there, is stale at its check.
 */
export async function withVoiceBump<T>(reason: VoiceGenReason, call: () => Promise<T>): Promise<T> {
  voiceGeneration().bump(reason)
  try {
    return await call()
  } finally {
    voiceGeneration().bump(reason)
  }
}

export function pushSpeakerPeopleChanged(ctx: MainContext, personId?: string): void {
  for (const wc of ctx.windows.targets()) wc.send('speaker-people:changed' satisfies PushChannel, personId ? { personId } : {})
}

/** The person, following a merge, or `not-found`. */
async function personOf(ctx: MainContext, personId: string): Promise<{ id: string; displayName: string; isSelf: boolean }> {
  const p = await ctx.storage.getSpeakerPerson(personId, { resolveMerged: true })
  if (!p) throw expected(notulaError('not-found', 'This person no longer exists.'))
  return p
}

async function userName(ctx: MainContext): Promise<string> {
  return (await ctx.settings.get('profile.name')).trim()
}

/** The agreement message's sender (`<user>`): refused while the profile has no name. */
async function senderName(ctx: MainContext): Promise<string> {
  const name = await userName(ctx)
  if (!name) throw bad(`${AGREEMENT_SENDER_REQUIRED}: Add your name first. The message is signed with it.`)
  return name
}

/**
 * The popover's and the card's roster: the linked event's attendees (minus the user and
 * resources), then the user, then people by recency. `query` filters each by name or email.
 */
async function roster(ctx: MainContext, query: string, noteId: string | null): Promise<SpeakerRosterRow[]> {
  const needle = query.toLowerCase()
  const hit = (name: string, email?: string | null): boolean =>
    !needle || name.toLowerCase().includes(needle) || (email ?? '').toLowerCase().includes(needle)
  const rows: SpeakerRosterRow[] = []
  const seen = new Set<string>()
  if (noteId) {
    const note = await ctx.storage.getNote(noteId)
    const mine = new Set([...(await myEmails(ctx)), await ctx.settings.get('profile.email')].map((e) => e.trim().toLowerCase()).filter(Boolean))
    const attendees = Array.isArray(note?.linked_event?.attendees) ? note.linked_event.attendees : []
    const emails = new Set<string>()
    for (const a of attendees) {
      const email = typeof a?.email === 'string' ? a.email.trim().toLowerCase() : ''
      if (!email || a.self || a.resource || isResourceEmail(email) || mine.has(email) || emails.has(email)) continue
      emails.add(email)
      if (emails.size > ROSTER_ATTENDEES) break
      const person = await ctx.storage.findSpeakerPersonByEmail(email)
      const name = person?.displayName ?? displayName({ name: a.displayName ?? null, email })
      if (!hit(name, email)) continue
      if (person) seen.add(person.id)
      rows.push({ ...(person ? { personId: person.id } : {}), name, email, isSelf: false, hasVoice: person?.hasVoice ?? false, attendee: true })
    }
  }
  const self = await ctx.storage.ensureSelfPerson(await userName(ctx))
  seen.add(self.id)
  if (hit(self.displayName) || hit('me')) rows.push({ personId: self.id, name: self.displayName, isSelf: true, hasVoice: self.hasVoice ?? false, attendee: false })
  for (const p of await ctx.storage.listSpeakerPeople({ ...(query ? { query } : {}), limit: ROSTER_PEOPLE })) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    rows.push({ personId: p.id, name: p.displayName, ...(p.email ? { email: p.email } : {}), isSelf: false, hasVoice: p.hasVoice ?? false, attendee: false })
  }
  return rows
}

/**
 * The spoken excerpt: the turn at that time in the note's transcript, with its speaker
 * label, at most 500 characters. Main reads it itself; no excerpt crosses IPC.
 */
async function spokenExcerpt(ctx: MainContext, noteId: string, atMs: number): Promise<string | null> {
  const chunks = await ctx.storage.getTranscript(noteId)
  const turns = speakerTurns(chunks, { wordLevel: false, live: false })
  let best: (typeof turns)[number] | null = null
  let bestGap = Infinity
  for (const t of turns) {
    const start = Date.parse(t.startTimestamp)
    const end = Date.parse(t.endTimestamp)
    const gap = atMs < start ? start - atMs : atMs > end ? atMs - end : 0
    if (gap < bestGap) {
      best = t
      bestGap = gap
    }
  }
  if (!best || bestGap > PICK_SLACK_MS) return null
  const text = `${best.label}: ${best.text.replace(/\s+/g, ' ').trim()}`
  const max = SPEAKER_PROFILE_LIMITS.spokenExcerptMaxChars
  // A cut excerpt says so.
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const METHOD_NAMES: Record<SpeakerAgreementMethod, string> = { email: 'Email', spoken: 'Spoken', written: 'Written', other: 'Other' }
const ENDED_NAMES: Record<NonNullable<SpeakerAgreementRow['revokedVia']>, string> = {
  forget: 'voice forgotten',
  forget_all: 'all voices forgotten',
  withdrawn: 'withdrawn',
  expired: 'expired'
}

/**
 * The text file of Export agreement record: every record of the person, newest first, so
 * an earlier record stays as proof after a withdrawal and a new agreement. `titles` maps a
 * spoken record's note id to its meeting title.
 */
function agreementFile(name: string, records: readonly SpeakerAgreementRow[], titles: ReadonlyMap<string, string>): string {
  const lines = ['Voice agreement record', '', `Person: ${name}`, `Records: ${records.length}`]
  records.forEach((a, i) => {
    const note = a.evidenceNoteId ? (titles.get(a.evidenceNoteId) ?? a.evidenceNoteId) : null
    lines.push(
      '',
      `--- Record ${i + 1} of ${records.length} ---`,
      `Agreed on: ${a.attestedAt}`,
      `How: ${METHOD_NAMES[a.method]}`,
      `Message: ${a.noticeVersion} (${a.noticeLanguage === 'pt' ? 'Português' : 'English'})`,
      a.revokedAt ? `Ended on: ${a.revokedAt} (${a.revokedVia ? ENDED_NAMES[a.revokedVia] : 'replaced by a newer record'})` : 'Status: active',
      ...(note ? [`Spoken in: ${note}${a.evidenceAtMs !== null ? ` at ${new Date(a.evidenceAtMs).toISOString()}` : ''}`] : []),
      '',
      'The message as shown:',
      a.noticeText,
      '',
      'The reply:',
      a.evidenceText ?? '(none)'
    )
  })
  lines.push('')
  return lines.join(process.platform === 'win32' ? '\r\n' : '\n')
}

/** A file name from a person's name: no path characters, never empty. */
function fileNamePart(name: string): string {
  // eslint-disable-next-line no-control-regex
  const n = name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60).replace(/[. ]+$/, '')
  return n || 'person'
}

export function registerSpeakerPeople(ctx: MainContext): void {
  const changed = (personId?: string): void => pushSpeakerPeopleChanged(ctx, personId)

  ipcMain.handle(
    'speaker-people:list' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'speaker-people:list'>): Promise<InvokeRes<'speaker-people:list'>> => {
      const r = obj(req)
      const query = r['query'] === undefined || r['query'] === null ? '' : r['query']
      if (typeof query !== 'string' || query.length > MAX_QUERY) throw bad('query is invalid.')
      const noteId = r['noteId'] === undefined || r['noteId'] === null ? null : idOf(r['noteId'], 'noteId')
      return roster(ctx, query.trim(), noteId)
    }
  )

  ipcMain.handle(
    'speaker-people:get' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'speaker-people:get'>): Promise<InvokeRes<'speaker-people:get'>> => {
      const view = await ctx.storage.speakerPersonView({ personId: idOf(obj(req)['personId'], 'personId'), modelId: modelId() })
      if (!view) throw expected(notulaError('not-found', 'This person no longer exists.'))
      return view
    }
  )

  ipcMain.handle(
    'speaker-people:matches' satisfies InvokeChannel,
    (_e, req: InvokeReq<'speaker-people:matches'>): Promise<InvokeRes<'speaker-people:matches'>> =>
      ctx.storage.listSpeakerMatches(idOf(obj(req)['personId'], 'personId'))
  )

  ipcMain.handle(
    'speaker-people:samples' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'speaker-people:samples'>): Promise<InvokeRes<'speaker-people:samples'>> => {
      const p = await personOf(ctx, idOf(obj(req)['personId'], 'personId'))
      return ctx.storage.listSpeakerSamples(p.id)
    }
  )

  // Remove sample: the delete, the centroid and the generation bump wait for the Undo window.
  ipcMain.handle(
    'speaker-people:remove-sample' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'speaker-people:remove-sample'>): Promise<InvokeRes<'speaker-people:remove-sample'>> => {
      const sampleId = idOf(obj(req)['sampleId'], 'sampleId')
      const undoToken = deferUndoable({
        apply: async () => {
          const r = await withVoiceBump('remove-sample', () => ctx.storage.removeSpeakerExemplar(sampleId))
          if (r) changed(r.personId)
        },
        // Nothing was written yet: the sample stays until the window closes.
        revert: () => Promise.resolve()
      })
      return { undoToken }
    }
  )

  ipcMain.handle(
    'speaker-people:set-auto' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'speaker-people:set-auto'>): Promise<InvokeRes<'speaker-people:set-auto'>> => {
      const r = obj(req)
      if (typeof r['enabled'] !== 'boolean') throw bad('enabled must be a boolean.')
      const p = await personOf(ctx, idOf(r['personId'], 'personId'))
      if (r['enabled']) await ctx.storage.updateSpeakerPerson(p.id, { autoRecognize: true })
      else await withVoiceBump('auto-recognize-off', () => ctx.storage.updateSpeakerPerson(p.id, { autoRecognize: false }))
      changed(p.id)
      return { ok: true }
    }
  )

  ipcMain.handle(
    'speaker-people:forget-voice' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'speaker-people:forget-voice'>): Promise<InvokeRes<'speaker-people:forget-voice'>> => {
      const r = obj(req)
      confirmed(r)
      if (r['reason'] !== 'forget' && r['reason'] !== 'withdrawn') throw bad('reason must be forget or withdrawn.')
      const p = await personOf(ctx, idOf(r['personId'], 'personId'))
      const via = r['reason']
      const d = await withVoiceBump('forget', () => ctx.storage.forgetSpeakerVoice({ personId: p.id, via }))
      log('info', 'speaker-people:voice-forgotten', { reason: r['reason'], exemplars: d.exemplars, pending: d.pending })
      changed(p.id)
      return { ok: true }
    }
  )

  ipcMain.handle(
    'speaker-people:merge-preview' satisfies InvokeChannel,
    (_e, req: InvokeReq<'speaker-people:merge-preview'>): Promise<InvokeRes<'speaker-people:merge-preview'>> => {
      const r = obj(req)
      return ctx.storage.previewSpeakerMerge({ fromId: idOf(r['fromId'], 'fromId'), intoId: idOf(r['intoId'], 'intoId') })
    }
  )

  ipcMain.handle(
    'speaker-people:merge' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'speaker-people:merge'>): Promise<InvokeRes<'speaker-people:merge'>> => {
      const r = obj(req)
      confirmed(r)
      const fromId = idOf(r['fromId'], 'fromId')
      const intoId = idOf(r['intoId'], 'intoId')
      const m = await withVoiceBump('merge', () => ctx.storage.mergeSpeakerPeople({ fromId, intoId }))
      log('info', 'speaker-people:merged', { samplesRemoved: m.samplesRemoved, agreementsMoved: m.agreementsMoved, meetingsMoved: m.meetingsMoved })
      changed(fromId)
      changed(intoId)
      return { ok: true }
    }
  )

  ipcMain.handle(
    'speaker-people:link-email' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'speaker-people:link-email'>): Promise<InvokeRes<'speaker-people:link-email'>> => {
      const r = obj(req)
      const email = r['email']
      if (typeof email !== 'string' || !email.trim() || email.length > 320) throw bad('email is invalid.')
      const p = await personOf(ctx, idOf(r['personId'], 'personId'))
      const out = await ctx.storage.linkSpeakerPersonEmail(p.id, email)
      if ('ok' in out) changed(p.id)
      return out
    }
  )

  ipcMain.handle(
    'speaker-people:delete' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'speaker-people:delete'>): Promise<InvokeRes<'speaker-people:delete'>> => {
      const r = obj(req)
      confirmed(r)
      const personId = idOf(r['personId'], 'personId')
      await ctx.storage.deleteSpeakerPerson(personId)
      changed(personId)
      return { ok: true }
    }
  )

  // ---------- agreement records ----------

  ipcMain.handle(
    'speaker-people:copy-agreement-message' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'speaker-people:copy-agreement-message'>): Promise<InvokeRes<'speaker-people:copy-agreement-message'>> => {
      const r = obj(req)
      const language = languageOf(r['language'])
      const p = await personOf(ctx, idOf(r['personId'], 'personId'))
      if (p.isSelf) throw bad("The user's own voice needs no agreement.")
      // Main writes the clipboard: the text never goes to the renderer.
      clipboard.writeText(voiceAgreementMessage(language, { name: p.displayName, user: await senderName(ctx) }))
      log('info', 'speaker-people:agreement-message-copied', { language, noticeVersion: VOICE_AGREEMENT_VERSION })
      return { ok: true, noticeVersion: VOICE_AGREEMENT_VERSION }
    }
  )

  ipcMain.handle(
    'speaker-people:agreement-text' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'speaker-people:agreement-text'>): Promise<InvokeRes<'speaker-people:agreement-text'>> => {
      const p = await personOf(ctx, idOf(obj(req)['personId'], 'personId'))
      const a = await ctx.storage.getSpeakerAgreement(p.id)
      if (!a) throw expected(notulaError('not-found', 'There is no agreement record for this person.'))
      // View message: logged as an action, never with its content.
      log('info', 'speaker-people:agreement-text-viewed', { hasEvidence: a.evidenceText !== null })
      return { noticeText: a.noticeText, ...(a.evidenceText ? { evidenceText: a.evidenceText } : {}) }
    }
  )

  ipcMain.handle(
    'speaker-people:record-agreement' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'speaker-people:record-agreement'>): Promise<InvokeRes<'speaker-people:record-agreement'>> => {
      const r = obj(req)
      const method = r['method'] as SpeakerAgreementMethod
      if (!METHODS.includes(method)) throw bad('method must be email, spoken, written or other.')
      const language = languageOf(r['language'])
      // The text recorded is the one the sheet showed: this build's message only.
      if (r['noticeVersion'] !== VOICE_AGREEMENT_VERSION) throw bad('The agreement message changed. Copy it again.')
      const p = await personOf(ctx, idOf(r['personId'], 'personId'))
      if (p.isSelf) throw bad("The user's own voice needs no agreement.")
      const user = await senderName(ctx)
      // The proof follows the method: a picked turn for spoken, a pasted reply for the others; the other field is ignored.
      const spoken = method === 'spoken'
      let evidenceText: string | null = null
      if (!spoken && r['evidenceText'] !== undefined && r['evidenceText'] !== null) {
        if (typeof r['evidenceText'] !== 'string' || r['evidenceText'].length > SPEAKER_PROFILE_LIMITS.evidenceTextMaxChars) {
          throw bad('The reply is too long.')
        }
        evidenceText = r['evidenceText'].trim() || null
      }
      let evidenceNoteId: string | null = null
      let evidenceAtMs: number | null = null
      if (spoken && r['evidenceNoteId'] !== undefined && r['evidenceNoteId'] !== null) {
        evidenceNoteId = idOf(r['evidenceNoteId'], 'evidenceNoteId')
        const at = Number(r['evidenceAtMs'])
        if (!Number.isFinite(at) || at < 0) throw bad('evidenceAtMs must be a time.')
        evidenceAtMs = Math.round(at)
        // A spoken agreement keeps the transcript excerpt main reads, not anything the renderer sent.
        evidenceText = await spokenExcerpt(ctx, evidenceNoteId, evidenceAtMs)
      }
      await ctx.storage.recordSpeakerAgreement({
        personId: p.id,
        method,
        noticeVersion: VOICE_AGREEMENT_VERSION,
        noticeLanguage: language,
        noticeText: voiceAgreementMessage(language, { name: p.displayName, user }),
        evidenceText,
        evidenceNoteId,
        evidenceAtMs
      })
      const pendingMeetings = new Set((await ctx.storage.listSpeakerPending({ personId: p.id })).map((x) => x.noteId)).size
      log('info', 'speaker-people:agreement-recorded', { method, language, hasEvidence: evidenceText !== null, pendingMeetings })
      changed(p.id)
      return { ok: true, pendingMeetings }
    }
  )

  ipcMain.handle(
    'speaker-people:export-agreement' satisfies InvokeChannel,
    async (e, req: InvokeReq<'speaker-people:export-agreement'>): Promise<InvokeRes<'speaker-people:export-agreement'>> => {
      const p = await personOf(ctx, idOf(obj(req)['personId'], 'personId'))
      const records = await ctx.storage.listSpeakerAgreements(p.id)
      if (!records.length) throw expected(notulaError('not-found', 'There is no agreement record for this person.'))
      const titles = new Map<string, string>()
      for (const id of new Set(records.map((a) => a.evidenceNoteId).filter((x): x is string => !!x))) {
        const title = (await ctx.storage.getNote(id).catch(() => null))?.title?.trim()
        if (title) titles.set(id, title)
      }
      const owner = ctx.windows.main()
      const options = { defaultPath: `Voice agreement - ${fileNamePart(p.displayName)}.txt`, title: 'Export agreement record', filters: [{ name: 'Text', extensions: ['txt'] }] }
      const picked = owner && owner.webContents.id === e.sender.id ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
      if (picked.canceled || !picked.filePath) return { cancelled: true }
      // The one place the record is written in the clear: the file the user chose.
      await writeFile(picked.filePath, agreementFile(p.displayName, records, titles), 'utf8')
      log('info', 'speaker-people:agreement-exported', { records: records.length })
      return { ok: true }
    }
  )

  ipcMain.handle(
    'speaker-people:delete-agreement' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'speaker-people:delete-agreement'>): Promise<InvokeRes<'speaker-people:delete-agreement'>> => {
      const r = obj(req)
      confirmed(r)
      const p = await personOf(ctx, idOf(r['personId'], 'personId'))
      await ctx.storage.deleteSpeakerAgreement(p.id)
      log('info', 'speaker-people:agreement-removed')
      changed(p.id)
      return { ok: true }
    }
  )

  // ---------- Forget all ----------

  ipcMain.handle(
    'speakers:forget-all' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'speakers:forget-all'>): Promise<InvokeRes<'speakers:forget-all'>> => {
      const r = obj(req)
      confirmed(r)
      if (r['keepSelf'] !== undefined && r['keepSelf'] !== true) throw bad('keepSelf must be true when set.')
      const keepSelf = r['keepSelf'] === true
      const d = await withVoiceBump('forget-all', () => ctx.storage.forgetAllSpeakerVoices({ keepSelf }))
      log('info', 'speakers:forget-all', { keepSelf, exemplars: d.exemplars, clusterVectors: d.clusterVectors, agreementsStamped: d.agreementsStamped })
      changed()
      return { ok: true }
    }
  )
}
