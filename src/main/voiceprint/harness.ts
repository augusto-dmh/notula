// SPDX-License-Identifier: Apache-2.0
// Dev only (unpackaged builds, `NOTULA_DEV_V_HARNESS=1`): scripted checks of the voice and transcript
// features in the real app, like the egress harness. It seeds scratch notes, drives the retention purge, the section
// delete, transcript reports and the self voice's sample through their real paths (renderer IPC where one
// exists), and writes `<userData>/v-harness.json`. Voice clips come from `NOTULA_DEV_V_WAV_DIR`
// (16 kHz mono WAV files made by a test script; nothing is played). Never in a package.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { TranscriptChunk } from '@shared/types/transcript'
import type { VoiceprintSampleResult } from '@shared/types/voiceprint'
import { getLocalModels } from '../asr/instance'
import { randomKey } from '../crypto/blobs'
import type { MainContext } from '../context'
import { log } from '../log'
import type { VoiceprintClassification } from './math'

export interface VHarnessHooks {
  purge?(trigger: 'startup' | 'daily'): Promise<void>
  notice?(): Promise<void>
  sample?(pcm: Buffer, durationMs: number): Promise<VoiceprintSampleResult>
  classify?(chunks: TranscriptChunk[], apps: string[]): VoiceprintClassification
}

export const vHarness: VHarnessHooks = {}

export function vHarnessOn(): boolean {
  return !app.isPackaged && process.env.NOTULA_DEV_V_HARNESS === '1'
}

let started = false

/** Called by the voice features' register functions; runs once, after every hook is in place. */
export function startVHarness(ctx: MainContext): void {
  if (!vHarnessOn() || started) return
  started = true
  setTimeout(() => void run(ctx), 4_000)
}

type Check = { name: string; ok: boolean; detail?: unknown }

function wav(dir: string, name: string): Buffer {
  const b = readFileSync(join(dir, name))
  // The data chunk of a canonical RIFF file made by System.Speech.
  const at = b.indexOf('data')
  return Buffer.from(b.subarray(at + 8))
}

const iso = (t: number): string => new Date(t).toISOString()

async function run(ctx: MainContext): Promise<void> {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail?: unknown): void => {
    checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) })
  }
  const out = join(ctx.userDataPath, 'v-harness.json')
  const ipc = async <T>(code: string): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
    const wc = ctx.windows.main()?.webContents
    if (!wc) return { ok: false, error: 'no main window' }
    return wc.executeJavaScript(`(async () => { try { return { ok: true, value: await ${code} } } catch (e) { return { ok: false, error: String(e && e.message || e) } } })()`) as Promise<
      { ok: true; value: T } | { ok: false; error: string }
    >
  }
  try {
    for (let i = 0; i < 60; i++) {
      const st = await ctx.storage.status().catch(() => null)
      const ready = st?.state === 'ready' && (await ipc<boolean>('Promise.resolve(!!window.notula)').catch(() => null))?.ok
      if (ready) break
      await new Promise((r) => setTimeout(r, 500))
    }
    const now = Date.now()
    const day = 86_400_000

    // ---------- seed ----------
    async function seed(title: string, endsAgoMs: number, phrase: string): Promise<{ id: string; chunkIds: string[]; recId: string }> {
      const note = await ctx.storage.createNote({ origin: 'new_note_button', title, created_via: 'Windows' })
      const sessionId = randomUUID()
      const t0 = now - endsAgoMs - 120_000
      await ctx.storage.createSession({ id: sessionId, document_id: note.id, provider: 'local', model: 'harness', language: 'en', started_at: iso(t0) })
      const ident = await ctx.storage.identity()
      const chunks: TranscriptChunk[] = Array.from({ length: 6 }, (_, i) => ({
        id: randomUUID(),
        document_id: note.id,
        workspace_id: ident.workspaceId,
        owner_id: ident.ownerId,
        transcription_session_id: sessionId,
        source: i % 2 ? 'system' : 'microphone',
        start_timestamp: iso(t0 + i * 20_000),
        end_timestamp: iso(t0 + i * 20_000 + 19_000),
        text: `${phrase} line ${i}`,
        is_final: true,
        detected_speaker_name: null,
        detectedSpeaker: null
      }))
      await ctx.storage.upsertChunks(chunks)
      await ctx.storage.replaceSpeakerNameSuggestions(note.id, [
        {
          identityKey: 'r1',
          label: 'Speaker A',
          name: 'Alex',
          evidenceTypes: [],
          channel: 'system',
          labelStream: 'reconciled',
          transcriptExcerpts: [phrase],
          position: 0,
          band: 'suggest',
          candidates: [{ name: 'Alex', source: 'conversation' }],
          passId: null,
          pending: false
        }
      ])
      await ctx.storage.createTranscriptReport({
        note_id: note.id,
        category: 'misheard_words',
        comments: 'harness',
        start_timestamp: null,
        end_timestamp: null,
        excerpt_text: phrase,
        excerpt: [],
        asr_provider: 'local',
        asr_model: 'harness',
        asr_language: 'en',
        asr_local: true
      })
      const recId = randomUUID()
      await ctx.storage.createRecording({ id: recId, note_id: note.id, session_id: sessionId, source: 'microphone', started_at: iso(t0), file_key: randomKey() })
      const dir = join(ctx.userDataPath, 'audio', note.id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${recId}.naud`), Buffer.alloc(4096, 7))
      await ctx.storage.updateRecording(recId, { ended_at: iso(t0 + 120_000), duration_ms: 120_000, bytes: 4096, state: 'complete' })
      return { id: note.id, chunkIds: chunks.map((c) => c.id), recId }
    }
    const oldNote = await seed('V harness old', 40 * day, 'zebracornflower')
    const newNote = await seed('V harness recent', 2 * day, 'quokkabanister')
    const capNote = await seed('V harness capturing', 40 * day, 'narwhalteapot')

    // ---------- retention: arming ----------
    await ctx.settings.set('retention.transcriptHours', null)
    const preview = await ipc<{ notes: number; recordings: number; effectiveAt: string }>('window.notula.retention.preview({ hours: 720 })')
    check('preview 1 month counts the two old notes', preview.ok && preview.value.notes === 2 && preview.value.recordings === 2, preview)
    const unconfirmed = await ipc('window.notula.retention.set({ hours: 720 })')
    check('more-deleting set without confirmed is refused', !unconfirmed.ok && /invalid-input/.test(unconfirmed.error), unconfirmed)
    const armed = await ipc<{ hours: number | null; pendingHours: number | null; effectiveAt: string | null }>(
      'window.notula.retention.set({ hours: 720, confirmed: true })'
    )
    const atMs = armed.ok && armed.value.effectiveAt ? Date.parse(armed.value.effectiveAt) : 0
    check(
      'confirming arms 7 days out and keeps the period off',
      armed.ok && armed.value.hours === null && armed.value.pendingHours === 720 && Math.abs(atMs - (Date.now() + 7 * day)) < 120_000,
      armed
    )
    await vHarness.purge?.('daily')
    check('nothing is deleted during the cooldown', (await ctx.storage.getTranscript(oldNote.id)).length === 6)

    // The notice about 24 h before.
    await ctx.settings.set('retention.effectiveAt', iso(Date.now() + 12 * 3_600_000))
    await vHarness.notice?.()
    const cards = ctx.notify.visible()
    check(
      'the 24 h notice card shows with Review',
      (await ctx.settings.get('retention.noticeShownFor')) !== null,
      cards.map((c) => ({ title: c.title, body: c.body, actions: c.infoActions }))
    )

    // Shorten 1 year → 1 week re-arms while the old period applies; lengthen and Off apply at once.
    await ctx.settings.set('retention.transcriptHours', 8760)
    const shorter = await ipc<{ hours: number | null; pendingHours: number | null }>('window.notula.retention.set({ hours: 168, confirmed: true })')
    check('shortening re-arms a cooldown and keeps 1 year', shorter.ok && shorter.value.hours === 8760 && shorter.value.pendingHours === 168, shorter)
    const longer = await ipc<{ hours: number | null; pendingHours: number | null }>('window.notula.retention.set({ hours: 8760 })')
    check('lengthening applies at once and clears the pending change', longer.ok && longer.value.hours === 8760 && longer.value.pendingHours === null, longer)
    const off = await ipc<{ hours: number | null; pendingHours: number | null }>('window.notula.retention.set({ hours: null })')
    check('Off applies at once', off.ok && off.value.hours === null && off.value.pendingHours === null, off)

    // ---------- retention: the purge ----------
    const cap = ctx.capture as { currentNoteId(): string | null; isCapturing(): boolean }
    const realCurrent = cap.currentNoteId.bind(cap)
    const realCapturing = cap.isCapturing.bind(cap)
    cap.currentNoteId = () => capNote.id
    cap.isCapturing = () => true
    await ctx.settings.set('retention.pendingHours', 720)
    await ctx.settings.set('retention.effectiveAt', iso(Date.now() - 1_000))
    await vHarness.purge?.('daily')
    const promoted = await ctx.settings.get('retention.transcriptHours')
    check('a due pending period is promoted at its effective time', promoted === 720, promoted)
    const oldDoc = await ctx.storage.getNote(oldNote.id)
    const recs = await ctx.storage.listRecordings({ noteId: oldNote.id })
    await new Promise((r) => setTimeout(r, 300))
    check('purged: transcript sections gone, note kept with transcript_purged_at', (await ctx.storage.getTranscript(oldNote.id)).length === 0 && !!oldDoc?.transcript_purged_at, oldDoc?.transcript_purged_at)
    check('purged: recordings rows and files gone', recs.length === 0 && !existsSync(join(ctx.userDataPath, 'audio', oldNote.id, `${oldNote.recId}.naud`)))
    check(
      'purged: speaker suggestions and reports gone',
      (await ctx.storage.listSpeakerNameSuggestions(oldNote.id)).length === 0 && (await ctx.storage.listTranscriptReports({ noteId: oldNote.id })).length === 0
    )
    check('recent note untouched', (await ctx.storage.getTranscript(newNote.id)).length === 6 && (await ctx.storage.listRecordings({ noteId: newNote.id })).length === 1)
    check('the note being captured is skipped', (await ctx.storage.getTranscript(capNote.id)).length === 6)
    const runs = await ctx.storage.listRetentionRuns(5)
    check('the run is logged with counts and note ids', runs[0]?.notes === 1 && runs[0]?.note_ids.includes(oldNote.id) && runs[0]?.recordings === 1, runs[0])
    const getT = await ipc<unknown[]>(`window.notula.transcript.get({ noteId: ${JSON.stringify(oldNote.id)} })`)
    check('transcript:get returns [] after a purge', getT.ok && getT.value.length === 0, getT)

    // ---------- section delete ----------
    const many = Array.from({ length: 501 }, () => randomUUID())
    const tooMany = await ipc(`window.notula.transcript.deleteSections({ noteId: ${JSON.stringify(newNote.id)}, chunkIds: ${JSON.stringify(many)}, confirmed: true })`)
    check('501 sections are refused', !tooMany.ok && /up to 500/.test(tooMany.error), tooMany)
    const busy = await ipc(`window.notula.transcript.deleteSections({ noteId: ${JSON.stringify(capNote.id)}, chunkIds: ${JSON.stringify(capNote.chunkIds.slice(0, 1))}, confirmed: true })`)
    check('refused while that note is captured', !busy.ok && /busy: Stop the transcript first/.test(busy.error), busy)
    cap.currentNoteId = realCurrent
    cap.isCapturing = realCapturing
    const three = await ipc<{ deleted: number }>(
      `window.notula.transcript.deleteSections({ noteId: ${JSON.stringify(newNote.id)}, chunkIds: ${JSON.stringify(newNote.chunkIds.slice(0, 3))}, confirmed: true })`
    )
    check('deleting 3 sections removes exactly 3', three.ok && three.value.deleted === 3 && (await ctx.storage.getTranscript(newNote.id)).length === 3, three)

    // ---------- transcript reports ----------
    await ctx.settings.set('transcriptReport.enabled', true)
    const rest = (await ctx.storage.getTranscript(newNote.id)).map((c) => c.id)
    const made = await ipc<{ id: string }>(
      `window.notula.transcriptReport.create({ noteId: ${JSON.stringify(newNote.id)}, category: 'speaker_errors', comments: '  wrong person  ', chunkIds: ${JSON.stringify(rest.slice(0, 2))} })`
    )
    const listed = await ipc<{ id: string; excerpt_text: string; start_timestamp: string | null; end_timestamp: string | null; comments: string; asr_provider: string }[]>(
      `window.notula.transcriptReport.list({ noteId: ${JSON.stringify(newNote.id)} })`
    )
    const mine = listed.ok ? listed.value.find((r) => made.ok && r.id === made.value.id) : undefined
    check(
      'a selection report stores the excerpt, its range and the ASR context',
      !!mine && mine.excerpt_text.includes('quokkabanister line 3') && !!mine.start_timestamp && !!mine.end_timestamp && mine.comments === 'wrong person' && mine.asr_provider === 'local',
      mine
    )
    const exported = await ipc<{ path?: string }>(`window.notula.transcriptReport.export({ noteId: ${JSON.stringify(newNote.id)}, confirmedPlaintext: true })`)
    check('Export reports writes a JSON file (dev dialog folder)', exported.ok && !!exported.value.path && existsSync(exported.value.path), exported)
    const noConfirm = await ipc(`window.notula.transcriptReport.export({ noteId: ${JSON.stringify(newNote.id)} })`)
    check('export without the plain-text confirmation is refused', !noConfirm.ok, noConfirm)
    await ctx.storage.trashNote(newNote.id)
    await ctx.storage.deleteNotePermanently(newNote.id)
    check('a permanent note delete removes its reports', (await ctx.storage.listTranscriptReports({ noteId: newNote.id })).length === 0)

    // ---------- the meeting notice (clipboard path; no meeting app runs here) ----------
    await ctx.settings.set('consent.enabled', true)
    const meet = { appId: 'com.google.Chrome.app.kjgfgldnnfoeklkmfkjfagphfepbbdan', name: 'Google Meet' }
    ctx.bus.emit('meetings:mic-apps', { apps: [meet], previous: [] })
    const posted = await ipc<{ status: string | null; channel: string | null }>(`window.notula.consent.postNow({ noteId: ${JSON.stringify(capNote.id)} })`)
    check('Meet: the notice is copied (clipboard path)', posted.ok && posted.value.status === 'copied' && posted.value.channel === 'meet', posted)
    check('the Notice copied card shows', ctx.notify.visible().some((c) => c.title === 'Notice copied'), ctx.notify.visible().map((c) => c.title))
    const marked = await ipc<{ status: string | null }>(`window.notula.consent.markPosted({ noteId: ${JSON.stringify(capNote.id)} })`)
    check('Mark as posted records confirmed', marked.ok && marked.value.status === 'confirmed', marked)
    const row = await ctx.storage.getConsentPost(capNote.id)
    check('the consent record holds no message text', !!row && !JSON.stringify(row).includes('Heads up'), row)
    ctx.bus.emit('meetings:mic-apps', { apps: [meet, { appId: 'us.zoom.xos', name: 'Zoom' }], previous: [meet] })
    const two = await ipc<{ status: string | null; reason: string | null }>(`window.notula.consent.postNow({ noteId: ${JSON.stringify(oldNote.id)} })`)
    check('two meeting apps: copied with several-meeting-windows', two.ok && two.value.status === 'copied' && two.value.reason === 'several-meeting-windows', two)
    ctx.bus.emit('meetings:mic-apps', { apps: [], previous: [] })

    // ---------- the self voice ----------
    const wavDir = process.env.NOTULA_DEV_V_WAV_DIR ?? ''
    const retired = await ipc<boolean>('Promise.resolve(window.notula.voiceprint.getStatus === undefined && window.notula.voiceprint.forget === undefined)')
    check('the retired voiceprint channels are gone from the bridge', retired.ok && retired.value, retired)
    check('the retired temp folder is gone', !existsSync(join(ctx.userDataPath, 'voiceprint-tmp')))
    await ctx.settings.set('speakers.selfVoice', false)
    const models = getLocalModels(ctx)
    for (const id of ['diarization-en', 'speaker-id'] as const) if (!models.isReady(id)) void models.download(id).catch(() => undefined)
    for (let i = 0; i < 240 && !(models.isReady('diarization-en') && models.isReady('speaker-id')); i++) await new Promise((r) => setTimeout(r, 500))
    check('speaker models ready', models.isReady('diarization-en') && models.isReady('speaker-id'))
    if (wavDir && vHarness.sample && vHarness.classify) {
      const sample = wav(wavDir, 'zira_sample.wav').subarray(0, 30 * 32_000)
      const enrolled = await vHarness.sample(Buffer.from(sample), 30_000)
      check('a 30 s clear sample enrols', enrolled.enrolled, enrolled)
      check('recording a sample turns Recognize my voice on', (await ctx.settings.get('speakers.selfVoice')) === true)
      const noise = Buffer.alloc(30 * 32_000)
      for (let i = 0; i < noise.length; i += 2) noise.writeInt16LE(Math.round((Math.random() * 2 - 1) * 9000), i)
      const noisy = await vHarness.sample(noise, 30_000)
      check('a noisy sample is refused', !noisy.enrolled && noisy.reason !== null, noisy)
      const st1 = await ipc<{ self: { present: boolean; sampleCount: number } }>('window.notula.speakers.getStatus()')
      check('the status carries no vector and counts the sample', st1.ok && !JSON.stringify(st1.value).includes('vector') && st1.value.self.sampleCount === 1, st1)
      const ident = await ctx.storage.identity()
      const chunks: TranscriptChunk[] = Array.from({ length: 4 }, (_, i) => ({
        id: randomUUID(),
        document_id: 'harness',
        workspace_id: ident.workspaceId,
        owner_id: ident.ownerId,
        transcription_session_id: 'harness',
        source: 'microphone',
        start_timestamp: iso(now + i * 20_000),
        end_timestamp: iso(now + i * 20_000 + 19_000),
        text: `in person ${i}`,
        is_final: true,
        detected_speaker_name: null,
        detectedSpeaker: null
      }))
      check('classification of a mic-only 60 s+ meeting is in_person', vHarness.classify(chunks, []) === 'in_person')
      check('a Zoom call classifies online', vHarness.classify(chunks, ['us.zoom.xos']) === 'online')
    } else {
      check('voice clips available', false, 'NOTULA_DEV_V_WAV_DIR not set')
    }
    const roster = await ipc<{ personId?: string; isSelf: boolean }[]>('window.notula.speakerPeople.list({})')
    const me = roster.ok ? roster.value.find((r) => r.isSelf)?.personId : undefined
    const forgot = me ? await ipc<{ ok: boolean }>(`window.notula.speakerPeople.forgetVoice({ personId: ${JSON.stringify(me)}, reason: 'forget', confirmed: true })`) : null
    const st2 = await ipc<{ self: { present: boolean } }>('window.notula.speakers.getStatus()')
    check('Forget my voice: no self sample left', !!forgot?.ok && st2.ok && !st2.value.self.present, st2)
  } catch (err) {
    check('harness ran to the end', false, err instanceof Error ? err.stack : String(err))
  }
  const failed = checks.filter((c) => !c.ok).length
  writeFileSync(out, JSON.stringify({ passed: checks.length - failed, failed, checks }, null, 2))
  log('info', 'v-harness:done', { passed: checks.length - failed, failed })
}
