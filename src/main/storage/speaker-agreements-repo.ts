// SPDX-License-Identifier: Apache-2.0
// Speaker profiles, the agreement records: the consent
// record behind a person's voice, called an agreement in code. Worker-safe: no Electron imports.
//
// One active record per person. A revoked record stays as the user's proof until Remove record.
// A newer record (a merge, or a second attestation) leaves the older one revoked with no `via`,
// kept as history. Their text is never logged.

import { randomUUID } from 'node:crypto'
import type { IsoTime } from '@shared/types/common'
import {
  SPEAKER_PROFILE_LIMITS,
  type SpeakerAgreementMethod,
  type SpeakerAgreementRevokedVia,
  type SpeakerNoticeLanguage
} from '@shared/types/speakers'
import type { NewSpeakerAgreement, SpeakerAgreementRow } from './api'
import { nowIso } from './rows'
import { invalid, notFound, StoreError, type StoreCtx } from './store'
import { checkpointVoice, livePerson, secureWrite } from './speaker-voice-repo'

type Row = Record<string, unknown>

const METHODS: readonly SpeakerAgreementMethod[] = ['email', 'spoken', 'written', 'other']
const LANGUAGES: readonly SpeakerNoticeLanguage[] = ['en', 'pt']
const VIAS: readonly SpeakerAgreementRevokedVia[] = ['forget', 'forget_all', 'withdrawn', 'expired']
const MAX_NOTICE = 20_000

function toAgreement(r: Row): SpeakerAgreementRow {
  return {
    id: String(r['id']),
    personId: String(r['person_id']),
    attestedAt: String(r['attested_at']),
    method: METHODS.includes(r['method'] as SpeakerAgreementMethod) ? (r['method'] as SpeakerAgreementMethod) : 'other',
    noticeVersion: String(r['notice_version']),
    noticeLanguage: r['notice_language'] === 'pt' ? 'pt' : 'en',
    noticeText: String(r['notice_text'] ?? ''),
    evidenceText: typeof r['evidence_text'] === 'string' ? r['evidence_text'] : null,
    evidenceNoteId: typeof r['evidence_note_id'] === 'string' ? r['evidence_note_id'] : null,
    evidenceAtMs: typeof r['evidence_at_ms'] === 'number' ? r['evidence_at_ms'] : null,
    revokedAt: typeof r['revoked_at'] === 'string' ? r['revoked_at'] : null,
    revokedVia: VIAS.includes(r['revoked_via'] as SpeakerAgreementRevokedVia) ? (r['revoked_via'] as SpeakerAgreementRevokedVia) : null
  }
}

/**
 * Stamps the active records of these people (or every person) as revoked, inside the caller's
 * transaction. Returns how many were stamped.
 */
export function stampActiveAgreements(s: StoreCtx, personIds: string[] | 'all', via: SpeakerAgreementRevokedVia, at: IsoTime): number {
  if (personIds === 'all') {
    return s.db
      .prepare(`UPDATE speaker_agreements SET revoked_at = ?, revoked_via = ? WHERE owner_id = ? AND revoked_at IS NULL`)
      .run(at, via, s.identity.ownerId).changes
  }
  if (!personIds.length) return 0
  return s.db
    .prepare(
      `UPDATE speaker_agreements SET revoked_at = ?, revoked_via = ?
       WHERE revoked_at IS NULL AND person_id IN (SELECT value FROM json_each(?))`
    )
    .run(at, via, JSON.stringify(personIds)).changes
}

/** Keeps the most recent active record of a person and leaves the others as history (a merge). */
export function settleActiveAgreements(s: StoreCtx, personId: string, at: IsoTime): void {
  s.db
    .prepare(
      `UPDATE speaker_agreements SET revoked_at = @at, revoked_via = NULL
       WHERE person_id = @p AND revoked_at IS NULL AND id <> (
         SELECT id FROM speaker_agreements WHERE person_id = @p AND revoked_at IS NULL ORDER BY attested_at DESC, rid DESC LIMIT 1)`
    )
    .run({ p: personId, at })
}

/**
 * The latest withdrawal among these people's records when it came after their most recent active
 * record (or no active record is left): that withdrawal governs the voice after a merge.
 */
export function withdrawalAfterActive(s: StoreCtx, personIds: string[]): IsoTime | null {
  const r = s.db
    .prepare(
      `SELECT (SELECT max(revoked_at) FROM speaker_agreements WHERE person_id IN (SELECT value FROM json_each(@ids)) AND revoked_via = 'withdrawn') AS w,
              (SELECT max(attested_at) FROM speaker_agreements WHERE person_id IN (SELECT value FROM json_each(@ids)) AND revoked_at IS NULL) AS a`
    )
    .get({ ids: JSON.stringify(personIds) }) as { w: string | null; a: string | null }
  return r.w && (!r.a || r.w > r.a) ? r.w : null
}

function text(v: unknown, what: string, max: number): string | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') throw invalid(`${what} must be text`)
  const t = v.trim()
  if (t.length > max) throw invalid(`${what} is too long`)
  return t || null
}

/** Never for self. A record already active for the person is kept as history. */
export function recordSpeakerAgreement(s: StoreCtx, a: NewSpeakerAgreement): SpeakerAgreementRow {
  if (!a || typeof a !== 'object') throw invalid('agreement is required')
  if (!METHODS.includes(a.method)) throw invalid('method must be email, spoken, written or other')
  if (!LANGUAGES.includes(a.noticeLanguage)) throw invalid('language must be en or pt')
  if (typeof a.noticeVersion !== 'string' || !a.noticeVersion || a.noticeVersion.length > 100) throw invalid('noticeVersion is required')
  const noticeText = text(a.noticeText, 'noticeText', MAX_NOTICE)
  if (!noticeText) throw invalid('noticeText is required')
  const evidenceText = text(a.evidenceText, 'evidenceText', SPEAKER_PROFILE_LIMITS.evidenceTextMaxChars)
  const evidenceNoteId = typeof a.evidenceNoteId === 'string' && a.evidenceNoteId ? a.evidenceNoteId.slice(0, 200) : null
  const atMs = a.evidenceAtMs === null || a.evidenceAtMs === undefined ? null : Number(a.evidenceAtMs)
  if (atMs !== null && (!Number.isFinite(atMs) || atMs < 0)) throw invalid('evidenceAtMs must be a time')
  const person = livePerson(s, typeof a.personId === 'string' ? a.personId : '')
  if (!person) throw notFound('person', String(a.personId))
  if (person.isSelf) throw invalid("the user's own voice needs no agreement")
  const now = nowIso()
  const rowId = randomUUID()
  secureWrite(s, () => {
    s.db
      .prepare(`UPDATE speaker_agreements SET revoked_at = ?, revoked_via = NULL WHERE person_id = ? AND revoked_at IS NULL`)
      .run(now, person.id)
    s.db
      .prepare(
        `INSERT INTO speaker_agreements (id, workspace_id, owner_id, person_id, attested_at, method, notice_version, notice_language,
           notice_text, evidence_text, evidence_note_id, evidence_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        rowId,
        s.identity.workspaceId,
        s.identity.ownerId,
        person.id,
        now,
        a.method,
        a.noticeVersion,
        a.noticeLanguage,
        noticeText,
        evidenceText,
        evidenceNoteId,
        atMs === null ? null : Math.round(atMs)
      )
  })
  s.touch('speaker_agreements', person.id)
  s.log('info', 'speakers:agreement-recorded', { method: a.method, language: a.noticeLanguage, hasEvidence: evidenceText !== null })
  return getSpeakerAgreement(s, person.id)!
}

/** The active record, else the latest revoked one (the last recorded). */
export function getSpeakerAgreement(s: StoreCtx, personId: string): SpeakerAgreementRow | null {
  if (typeof personId !== 'string' || !personId) throw invalid('personId is required')
  const r = s.db
    .prepare(
      `SELECT * FROM speaker_agreements WHERE person_id = ? AND owner_id = ?
       ORDER BY revoked_at IS NOT NULL, rid DESC LIMIT 1`
    )
    .get(personId, s.identity.ownerId) as Row | undefined
  return r ? toAgreement(r) : null
}

/** Every record of the person, newest first. */
export function listSpeakerAgreements(s: StoreCtx, personId: string): SpeakerAgreementRow[] {
  if (typeof personId !== 'string' || !personId) throw invalid('personId is required')
  const rows = s.db
    .prepare(`SELECT * FROM speaker_agreements WHERE person_id = ? AND owner_id = ? ORDER BY attested_at DESC, rid DESC`)
    .all(personId, s.identity.ownerId) as Row[]
  return rows.map(toAgreement)
}

/** Remove record: revoked records only; every record of the person goes. */
export function deleteSpeakerAgreement(s: StoreCtx, personId: string): void {
  const current = getSpeakerAgreement(s, personId)
  if (!current) throw notFound('agreement of person', personId)
  if (!current.revokedAt) throw new StoreError('invalid-input', "An active agreement record can't be removed. Forget the voice first.")
  const n = secureWrite(s, () => s.db.prepare(`DELETE FROM speaker_agreements WHERE person_id = ? AND owner_id = ?`).run(personId, s.identity.ownerId).changes)
  checkpointVoice(s)
  s.touch('speaker_agreements', personId)
  s.log('info', 'speakers:agreement-removed', { rows: n })
}
