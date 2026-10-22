// SPDX-License-Identifier: Apache-2.0
// Follow-up email drafts: `followup_drafts`,
// one live draft per note (the `"to"` column is quoted). A draft with a new id for
// a note that already has one replaces it (regenerating), and counts as created now.

import type { IsoTime } from '@shared/types/common'
import type { FollowUpConfidence, FollowUpDraft, FollowUpOutcome, FollowUpStatus } from '@shared/types/follow-up'
import type { FollowUpDraftUpsert } from './api'
import { nowIso, parseJson } from './rows'
import { inTransaction, invalid, notFound, type StoreCtx } from './store'

type Row = Record<string, unknown>

const STATUSES: readonly FollowUpStatus[] = ['generating', 'completed', 'error']
const OUTCOMES: readonly FollowUpOutcome[] = ['opened', 'copied', 'discarded', 'handed_off']
const CONFIDENCES: readonly FollowUpConfidence[] = ['low', 'medium', 'high']
const MAX_ADDRESSES = 100
const MAX_ADDRESS = 320
const MAX_SUBJECT = 1_000
const MAX_BODY = 200_000
const MAX_TEXT = 4_000

const SELECT = `SELECT f.*, d.title AS note_title FROM followup_drafts f JOIN documents d ON d.id = f.document_id`

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

function list(v: unknown): string[] {
  const raw = parseJson<unknown>(v, [])
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
}

function toDraft(r: Row): FollowUpDraft {
  const confidence = r['follow_up_need']
  const feedback = r['feedback_direction']
  return {
    id: r['id'] as string,
    document_id: r['document_id'] as string,
    note_title: str(r['note_title']),
    status: r['status'] as FollowUpStatus,
    outcome: OUTCOMES.includes(r['outcome'] as FollowUpOutcome) ? (r['outcome'] as FollowUpOutcome) : null,
    to: list(r['to']),
    cc: list(r['cc']),
    bcc: list(r['bcc']),
    subject: (r['subject'] as string) ?? '',
    body: (r['body'] as string) ?? '',
    previous_body: str(r['previous_body']),
    follow_up_need: CONFIDENCES.includes(confidence as FollowUpConfidence) ? (confidence as FollowUpConfidence) : null,
    error_message: str(r['error_message']),
    feedback_direction: feedback === 'positive' || feedback === 'negative' ? feedback : null,
    feedback_text: str(r['feedback_text']),
    created_at: r['created_at'] as string,
    updated_at: r['updated_at'] as string
  }
}

export function getFollowUpDraft(s: StoreCtx, q: { noteId: string } | { id: string }): FollowUpDraft | null {
  if (typeof q !== 'object' || q === null) throw invalid('query must be an object')
  const byNote = 'noteId' in q
  const key = byNote ? q.noteId : (q as { id: string }).id
  if (typeof key !== 'string' || !key) throw invalid('an id is required')
  const row = s.db.prepare(`${SELECT} WHERE ${byNote ? 'f.document_id' : 'f.id'} = ?`).get(key) as Row | undefined
  return row ? toDraft(row) : null
}

function addresses(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.length > MAX_ADDRESSES || v.some((x) => typeof x !== 'string' || x.length > MAX_ADDRESS)) {
    throw invalid(`${what} is invalid`)
  }
  return v as string[]
}

function textOrNull(v: unknown, what: string, max: number): string | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string' || v.length > max) throw invalid(`${what} is invalid`)
  return v
}

export function upsertFollowUpDraft(s: StoreCtx, d: FollowUpDraftUpsert): FollowUpDraft {
  if (typeof d !== 'object' || d === null) throw invalid('draft must be an object')
  if (typeof d.id !== 'string' || !d.id || d.id.length > 64) throw invalid('id is invalid')
  if (typeof d.document_id !== 'string' || !d.document_id) throw invalid('document_id is invalid')
  if (!STATUSES.includes(d.status)) throw invalid('status is invalid')
  if (d.outcome !== null && !OUTCOMES.includes(d.outcome)) throw invalid('outcome is invalid')
  if (d.follow_up_need !== null && !CONFIDENCES.includes(d.follow_up_need)) {
    throw invalid('follow_up_need is invalid')
  }
  if (d.feedback_direction !== null && d.feedback_direction !== 'positive' && d.feedback_direction !== 'negative') {
    throw invalid('feedback_direction is invalid')
  }
  if (typeof d.subject !== 'string' || d.subject.length > MAX_SUBJECT) throw invalid('subject is invalid')
  if (typeof d.body !== 'string' || d.body.length > MAX_BODY) throw invalid('body is invalid')
  const params = {
    id: d.id,
    documentId: d.document_id,
    workspace: s.identity.workspaceId,
    owner: s.identity.ownerId,
    status: d.status,
    outcome: d.outcome,
    to: JSON.stringify(addresses(d.to, 'to')),
    cc: JSON.stringify(addresses(d.cc, 'cc')),
    bcc: JSON.stringify(addresses(d.bcc, 'bcc')),
    subject: d.subject,
    body: d.body,
    previousBody: textOrNull(d.previous_body, 'previous_body', MAX_BODY),
    confidence: d.follow_up_need,
    errorMessage: textOrNull(d.error_message, 'error_message', MAX_TEXT),
    feedbackDirection: d.feedback_direction,
    feedbackText: textOrNull(d.feedback_text, 'feedback_text', MAX_TEXT),
    now: nowIso()
  }
  inTransaction(s.db, () => {
    if (!s.db.prepare(`SELECT 1 FROM documents WHERE id = ?`).get(d.document_id)) throw notFound('note', d.document_id)
    const other = s.db.prepare(`SELECT document_id FROM followup_drafts WHERE id = ?`).get(d.id) as
      | { document_id: string }
      | undefined
    if (other && other.document_id !== d.document_id) throw invalid('that draft belongs to another note')
    const existing = s.db.prepare(`SELECT id FROM followup_drafts WHERE document_id = ?`).get(d.document_id) as
      | { id: string }
      | undefined
    if (!existing) {
      s.db
        .prepare(
          `INSERT INTO followup_drafts (id, workspace_id, owner_id, document_id, status, outcome, "to", cc, bcc, subject,
             body, previous_body, follow_up_need, error_message, feedback_direction, feedback_text,
             created_at, updated_at)
           VALUES (@id, @workspace, @owner, @documentId, @status, @outcome, @to, @cc, @bcc, @subject, @body,
             @previousBody, @confidence, @errorMessage, @feedbackDirection, @feedbackText, @now, @now)`
        )
        .run(params)
    } else {
      // The same draft keeps its creation time; a new draft for the note replaces the old one.
      s.db
        .prepare(
          `UPDATE followup_drafts SET id = @id, status = @status, outcome = @outcome, "to" = @to, cc = @cc, bcc = @bcc,
             subject = @subject, body = @body, previous_body = @previousBody, follow_up_need = @confidence,
             error_message = @errorMessage, feedback_direction = @feedbackDirection, feedback_text = @feedbackText,
             created_at = CASE WHEN id = @id THEN created_at ELSE @now END, updated_at = @now
           WHERE document_id = @documentId`
        )
        .run(params)
    }
  })
  s.touch('followup_drafts', d.id, d.document_id)
  return getFollowUpDraft(s, { id: d.id }) as FollowUpDraft
}

/** Drafts created after `createdAfter`, of notes not in Trash, newest first. */
export function listFollowUpDrafts(s: StoreCtx, q: { createdAfter: IsoTime }): FollowUpDraft[] {
  if (typeof q !== 'object' || q === null || typeof q.createdAfter !== 'string' || Number.isNaN(Date.parse(q.createdAfter))) {
    throw invalid('createdAfter is not a valid time')
  }
  return (
    s.db
      .prepare(
        `${SELECT} WHERE f.created_at > ? AND d.deleted_at IS NULL AND f.owner_id = ? AND f.workspace_id = ?
         ORDER BY f.created_at DESC, f.rid DESC LIMIT 500`
      )
      .all(q.createdAfter, s.identity.ownerId, s.identity.workspaceId) as Row[]
  ).map(toDraft)
}
