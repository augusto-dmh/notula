// SPDX-License-Identifier: Apache-2.0
// Attachments and the encrypted blob store:
// `attachments`, `blob_keys` and the NTA1 files (crypto/blobs.ts).
//
// - Every file is sealed (AES-256-GCM, NTA1) with its own random content key before it
//   touches the disk. The content key is stored wrapped with the attachments master key
//   (`attachments.wrapped_key`); the master key is 32 random bytes in `blob_keys`, created
//   on first use inside the SQLCipher database, and never leaves this worker.
// - Writes: seal → `<id>.bin.partial` (exclusive create, fsync) → the row (and, for a note
//   image, the note's `attachments` record) in one transaction → rename to `<id>.bin`
//   after the commit. Plaintext is never written: no temp files, no thumbnails.
// - Reads: unwrap → open (tag check) → SHA-256 of the plaintext against the row. Any
//   failure is `null` plus a log line with the id only; the row is kept.
// - Deletes: the row (its key with it, so the file is unreadable from then on: crypto-
//   shredding), the note's record, then the file through `file_deletions` (the
//   migration-4 trigger queues `rel:attachments/<xx>/<id>.bin`).

import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import {
  ATTACHMENT_LIMITS,
  type AttachmentInfo,
  type AttachmentKind,
  type AttachmentParentType,
  type AttachmentStatus
} from '@shared/types/attachments'
import { ATTACHMENT_URL_PREFIX, type NoteAttachment, type ScreenShareContext } from '@shared/types/notes'
import { BlobIntegrityError, KEY_BYTES, openAttachment, randomKey, sealAttachment, unwrapKey, wrapKey } from '../crypto/blobs'
import type { AttachmentPatch, NewAttachment } from './api'
import { nowIso, parseJson, toBuffer } from './rows'
import { inTransaction, invalid, notFound, type StoreCtx } from './store'
import { processFileDeletions } from './trash-repo'

const MASTER_PURPOSE = 'attachments'
const ROOT = 'attachments'
const PARTIAL = '.partial'
const PARENT_TYPES: readonly AttachmentParentType[] = ['note', 'chat_thread', 'folder']
const KINDS: readonly AttachmentKind[] = ['image', 'file']
const STATUSES: readonly AttachmentStatus[] = ['processing', 'ready', 'failed']
/** Ids name files: path-safe, and the first two characters name the shard folder. */
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/
/** Above every caller's own limit (30 MB files, ≤ 2,560 px JPEG snapshots); a guard only. */
const MAX_BYTES = 64 * 1024 * 1024
const MAX_TEXT = 5_000_000
const MAX_NAME = 500

type Row = Record<string, unknown>

const COLUMNS = `id, parent_type, parent_id, kind, file_name, mime_type, byte_size, width, height, page_count,
  status, error, token_estimate, content_summary IS NOT NULL AS has_summary, screen_capture_info, created_at`

function intOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'bigint' ? Number(v) : null
}

function toInfo(r: Row): AttachmentInfo {
  return {
    id: r['id'] as string,
    parent_type: r['parent_type'] as AttachmentParentType,
    parent_id: r['parent_id'] as string,
    kind: r['kind'] as AttachmentKind,
    file_name: r['file_name'] as string,
    mime_type: r['mime_type'] as string,
    byte_size: Number(r['byte_size'] ?? 0),
    width: intOrNull(r['width']),
    height: intOrNull(r['height']),
    page_count: intOrNull(r['page_count']),
    status: r['status'] as AttachmentStatus,
    error: typeof r['error'] === 'string' ? r['error'] : null,
    token_estimate: intOrNull(r['token_estimate']),
    has_summary: r['has_summary'] === 1,
    screen_capture_info: parseJson<ScreenShareContext | null>(r['screen_capture_info'], null),
    created_at: r['created_at'] as string
  }
}

function getInfo(s: StoreCtx, id: string): AttachmentInfo | null {
  const row = s.db.prepare(`SELECT ${COLUMNS} FROM attachments WHERE id = ? AND deleted_at IS NULL`).get(id) as Row | undefined
  return row ? toInfo(row) : null
}

// ---------- paths ----------

function shardDir(s: StoreCtx, id: string): string {
  return join(s.userDataDir, ROOT, id.slice(0, 2))
}

function blobPath(s: StoreCtx, id: string): string {
  return join(shardDir(s, id), `${id}.bin`)
}

// ---------- the master key (worker-internal) ----------

/** The attachments master key, created on first use. Never returned over the protocol. */
function masterKey(s: StoreCtx): Buffer {
  const read = (): Buffer | null => {
    const row = s.db.prepare(`SELECT key FROM blob_keys WHERE purpose = ?`).get(MASTER_PURPOSE) as { key: Uint8Array } | undefined
    return row ? toBuffer(row.key) : null
  }
  let key = read()
  if (!key) {
    s.db
      .prepare(`INSERT INTO blob_keys (purpose, key, created_at) VALUES (?, ?, ?) ON CONFLICT (purpose) DO NOTHING`)
      .run(MASTER_PURPOSE, randomKey(), nowIso())
    key = read()
    s.log('info', 'attachments-master-key-created')
  }
  if (!key || key.length !== KEY_BYTES) throw new BlobIntegrityError('the attachments master key is damaged')
  return key
}

// ---------- validation ----------

function text(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw invalid(`${what} is invalid`)
  return v
}

function dimension(v: unknown, what: string): number | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1_000_000) throw invalid(`${what} is invalid`)
  return v
}

function screenShareContext(v: unknown): ScreenShareContext | null {
  if (v === undefined || v === null) return null
  const c = v as Partial<ScreenShareContext>
  if (
    typeof v !== 'object' ||
    typeof c.captured_at !== 'string' ||
    Number.isNaN(Date.parse(c.captured_at)) ||
    typeof c.description !== 'string' ||
    c.description.length > 20_000 ||
    typeof c.model !== 'string' ||
    !c.model ||
    c.model.length > 200
  ) {
    throw invalid('screen_capture_info is invalid')
  }
  return { captured_at: c.captured_at, description: c.description, model: c.model }
}

function noteRecord(info: AttachmentInfo): NoteAttachment {
  return {
    id: info.id,
    type: 'image',
    url: `${ATTACHMENT_URL_PREFIX}${info.id}`,
    width: info.width ?? 0,
    height: info.height ?? 0,
    mime_type: info.mime_type,
    byte_size: info.byte_size,
    ...(info.screen_capture_info ? { screen_capture_info: info.screen_capture_info } : {})
  }
}

/** The note's `attachments` list, rewritten by `edit`, inside the caller's transaction. */
function editNoteRecords(s: StoreCtx, noteId: string, edit: (list: NoteAttachment[]) => NoteAttachment[]): void {
  const row = s.db.prepare(`SELECT attachments FROM documents WHERE id = ?`).get(noteId) as { attachments: string } | undefined
  if (!row) return
  const raw = parseJson<unknown>(row.attachments, [])
  const list = (Array.isArray(raw) ? raw : []).filter(
    (x): x is NoteAttachment => typeof x === 'object' && x !== null && typeof (x as NoteAttachment).id === 'string'
  )
  s.db
    .prepare(`UPDATE documents SET attachments = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(edit(list)), nowIso(), noteId)
}

/** Writes the sealed bytes to a new `.partial` file and flushes it to disk. */
function writePartial(path: string, sealed: Buffer): void {
  if (existsSync(path)) rmSync(path, { force: true })
  const fd = openSync(path, 'wx')
  try {
    let off = 0
    while (off < sealed.length) off += writeSync(fd, sealed, off, sealed.length - off)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

// ---------- API ----------

/**
 * Encrypts with a fresh key, writes `<id>.bin.partial`, inserts the row and, for a note
 * image, appends its record to `documents.attachments` (one transaction), then renames.
 * A counted note image beyond the 10th rejects `invalid-input: Maximum of 10 attachments reached`.
 */
export function createAttachment(s: StoreCtx, a: NewAttachment): AttachmentInfo {
  if (typeof a !== 'object' || a === null) throw invalid('attachment must be an object')
  const id = a.id === undefined ? randomUUID() : a.id
  if (typeof id !== 'string' || !ID.test(id)) throw invalid('id is invalid')
  if (!PARENT_TYPES.includes(a.parent_type)) throw invalid('parent_type is invalid')
  const parentId = text(a.parent_id, 'parent_id', 200)
  if (!KINDS.includes(a.kind)) throw invalid('kind is invalid')
  if (!STATUSES.includes(a.status)) throw invalid('status is invalid')
  const fileName = text(a.file_name, 'file_name', MAX_NAME)
  const mimeType = text(a.mime_type, 'mime_type', 200).toLowerCase()
  const width = dimension(a.width, 'width')
  const height = dimension(a.height, 'height')
  const pageCount = dimension(a.page_count, 'page_count')
  const ssc = screenShareContext(a.screen_capture_info)
  if (!(a.bytes instanceof Uint8Array) || a.bytes.byteLength === 0) throw invalid('bytes are required')
  if (a.bytes.byteLength > MAX_BYTES) throw invalid('the file is too large')
  const noteImage = a.parent_type === 'note'
  if (noteImage && a.kind !== 'image') throw invalid('a note takes images only')

  const plain = toBuffer(a.bytes)
  const sha256 = createHash('sha256').update(plain).digest('hex')
  const contentKey = randomKey()
  const sealed = sealAttachment(plain, contentKey)
  const dir = shardDir(s, id)
  mkdirSync(dir, { recursive: true })
  const final = blobPath(s, id)
  const partial = final + PARTIAL
  writePartial(partial, sealed)

  let info: AttachmentInfo
  try {
    info = inTransaction(s.db, () => {
      if (s.db.prepare(`SELECT 1 FROM attachments WHERE id = ?`).get(id)) throw invalid('an attachment with this id exists')
      if (noteImage) {
        const note = s.db.prepare(`SELECT deleted_at FROM documents WHERE id = ?`).get(parentId) as
          | { deleted_at: string | null }
          | undefined
        if (!note) throw notFound('note', parentId)
        if (note.deleted_at !== null) throw invalid('the note is in Trash')
        if (a.counted) {
          const { n } = s.db
            .prepare(
              `SELECT count(*) AS n FROM attachments
               WHERE parent_type = 'note' AND parent_id = ? AND kind = 'image' AND counted = 1 AND deleted_at IS NULL`
            )
            .get(parentId) as { n: number }
          if (n >= ATTACHMENT_LIMITS.noteImages) throw invalid('Maximum of 10 attachments reached')
        }
      }
      const wrapped = wrapKey(contentKey, masterKey(s))
      s.db
        .prepare(
          `INSERT INTO attachments (id, workspace_id, owner_id, parent_type, parent_id, kind, file_name, mime_type,
             byte_size, width, height, page_count, sha256, wrapped_key, counted, status, screen_capture_info, created_at)
           VALUES (@id, @workspace, @owner, @parentType, @parentId, @kind, @fileName, @mimeType,
             @byteSize, @width, @height, @pageCount, @sha256, @wrapped, @counted, @status, @ssc, @now)`
        )
        .run({
          id,
          workspace: s.identity.workspaceId,
          owner: s.identity.ownerId,
          parentType: a.parent_type,
          parentId,
          kind: a.kind,
          fileName,
          mimeType,
          byteSize: plain.byteLength,
          width,
          height,
          pageCount,
          sha256,
          wrapped,
          counted: a.counted ? 1 : 0,
          status: a.status,
          ssc: ssc ? JSON.stringify(ssc) : null,
          now: nowIso()
        })
      const created = getInfo(s, id) as AttachmentInfo
      if (noteImage) editNoteRecords(s, parentId, (list) => [...list.filter((x) => x.id !== id), noteRecord(created)])
      return created
    })
  } catch (err) {
    rmSync(partial, { force: true })
    throw err
  }
  try {
    renameSync(partial, final)
  } catch (err) {
    // The row must not outlive a file it can never read: remove it again (queues the file).
    s.log('error', 'attachment-rename-failed', { id, err })
    try {
      deleteRows(s, id)
    } catch (cleanupErr) {
      s.log('error', 'attachment-rename-cleanup-failed', { id, err: cleanupErr })
    }
    rmSync(partial, { force: true })
    throw err
  }
  s.touch('attachments', id, parentId)
  if (noteImage) s.touch('documents', parentId)
  s.log('info', 'attachment-stored', { id, parentType: a.parent_type, kind: a.kind, bytes: plain.byteLength })
  return info
}

/** Decrypts and verifies `sha256`; null (and a log line with the id only) when unavailable. */
export function readAttachment(s: StoreCtx, id: string): { mimeType: string; bytes: Uint8Array } | null {
  if (typeof id !== 'string' || !ID.test(id)) throw invalid('id is invalid')
  const row = s.db
    .prepare(`SELECT mime_type, sha256, wrapped_key FROM attachments WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as { mime_type: string; sha256: string; wrapped_key: Uint8Array } | undefined
  if (!row) {
    s.log('warn', 'attachment-unavailable', { id, reason: 'no-row' })
    return null
  }
  const path = blobPath(s, id)
  if (!existsSync(path)) {
    s.log('error', 'attachment-unavailable', { id, reason: 'file-missing' })
    return null
  }
  try {
    const contentKey = unwrapKey(toBuffer(row.wrapped_key), masterKey(s))
    const plain = openAttachment(readFileSync(path), contentKey)
    const sha = createHash('sha256').update(plain).digest('hex')
    if (sha !== row.sha256) {
      s.log('error', 'attachment-unavailable', { id, reason: 'hash-mismatch' })
      return null
    }
    return { mimeType: row.mime_type, bytes: plain }
  } catch (err) {
    const reason = err instanceof BlobIntegrityError ? 'integrity' : 'read-failed'
    s.log('error', 'attachment-unavailable', { id, reason, message: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/** A `screen_capture_info` patch also updates the note's record; `parent_id` re-parents. */
export function updateAttachment(s: StoreCtx, id: string, patch: AttachmentPatch): AttachmentInfo {
  if (typeof patch !== 'object' || patch === null) throw invalid('patch must be an object')
  const sets: string[] = []
  const params: Record<string, unknown> = { id }
  const set = (column: string, value: unknown): void => {
    sets.push(`${column} = @${column}`)
    params[column] = value
  }
  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status)) throw invalid('status is invalid')
    set('status', patch.status)
  }
  if (patch.error !== undefined) {
    if (patch.error !== null && (typeof patch.error !== 'string' || patch.error.length > 2_000)) throw invalid('error is invalid')
    set('error', patch.error)
  }
  if (patch.content_markdown !== undefined) {
    if (patch.content_markdown !== null && (typeof patch.content_markdown !== 'string' || patch.content_markdown.length > MAX_TEXT)) {
      throw invalid('content_markdown is invalid')
    }
    set('content_markdown', patch.content_markdown)
  }
  if (patch.content_summary !== undefined) {
    if (patch.content_summary !== null && (typeof patch.content_summary !== 'string' || patch.content_summary.length > 50_000)) {
      throw invalid('content_summary is invalid')
    }
    set('content_summary', patch.content_summary)
  }
  if (patch.token_estimate !== undefined) set('token_estimate', dimension(patch.token_estimate, 'token_estimate'))
  if (patch.page_count !== undefined) set('page_count', dimension(patch.page_count, 'page_count'))
  let ssc: ScreenShareContext | null | undefined
  if (patch.screen_capture_info !== undefined) {
    ssc = screenShareContext(patch.screen_capture_info)
    set('screen_capture_info', ssc ? JSON.stringify(ssc) : null)
  }
  let newParent: string | undefined
  if (patch.parent_id !== undefined) newParent = text(patch.parent_id, 'parent_id', 200)

  const result = inTransaction(s.db, () => {
    const before = getInfo(s, id)
    if (!before) throw notFound('attachment', id)
    if (newParent !== undefined && newParent !== before.parent_id) {
      if (before.parent_type === 'note') throw invalid('a note image cannot be moved')
      set('parent_id', newParent)
    }
    if (sets.length) s.db.prepare(`UPDATE attachments SET ${sets.join(', ')} WHERE id = @id`).run(params)
    const after = getInfo(s, id) as AttachmentInfo
    if (ssc !== undefined && after.parent_type === 'note' && after.kind === 'image') {
      editNoteRecords(s, after.parent_id, (list) => list.map((x) => (x.id === id ? noteRecord(after) : x)))
    }
    return { before, after }
  })
  s.touch('attachments', id, result.before.parent_id, result.after.parent_id)
  if (ssc !== undefined && result.after.parent_type === 'note') s.touch('documents', result.after.parent_id)
  return result.after
}

export function listAttachments(
  s: StoreCtx,
  q: { parentType: AttachmentParentType; parentId: string } | { ids: string[] }
): AttachmentInfo[] {
  if (typeof q !== 'object' || q === null) throw invalid('query must be an object')
  if ('ids' in q) {
    if (!Array.isArray(q.ids) || q.ids.length > 1_000 || q.ids.some((i) => typeof i !== 'string')) throw invalid('ids are invalid')
    if (q.ids.length === 0) return []
    return (
      s.db
        .prepare(
          `SELECT ${COLUMNS} FROM attachments
           WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?)) ORDER BY created_at, rid`
        )
        .all(JSON.stringify(q.ids)) as Row[]
    ).map(toInfo)
  }
  if (!PARENT_TYPES.includes(q.parentType)) throw invalid('parentType is invalid')
  const parentId = text(q.parentId, 'parentId', 200)
  return (
    s.db
      .prepare(
        `SELECT ${COLUMNS} FROM attachments
         WHERE deleted_at IS NULL AND parent_type = ? AND parent_id = ? ORDER BY created_at, rid`
      )
      .all(q.parentType, parentId) as Row[]
  ).map(toInfo)
}

export function attachmentContent(
  s: StoreCtx,
  id: string
): { file_name: string; mime_type: string; content_markdown: string | null; content_summary: string | null } | null {
  const row = s.db
    .prepare(
      `SELECT file_name, mime_type, content_markdown, content_summary FROM attachments WHERE id = ? AND deleted_at IS NULL`
    )
    .get(id) as Row | undefined
  if (!row) return null
  return {
    file_name: row['file_name'] as string,
    mime_type: row['mime_type'] as string,
    content_markdown: typeof row['content_markdown'] === 'string' ? row['content_markdown'] : null,
    content_summary: typeof row['content_summary'] === 'string' ? row['content_summary'] : null
  }
}

/** The row and the note's record, inside one transaction; the trigger queues the file. */
function deleteRows(s: StoreCtx, id: string): AttachmentInfo | null {
  return inTransaction(s.db, () => {
    const info = getInfo(s, id)
    if (!info) return null
    if (info.parent_type === 'note') editNoteRecords(s, info.parent_id, (list) => list.filter((x) => x.id !== id))
    s.db.prepare(`DELETE FROM attachments WHERE id = ?`).run(id)
    return info
  })
}

/** The row, the note's record and the file, in one operation. A missing row is not an error. */
export function deleteAttachment(s: StoreCtx, id: string): void {
  if (typeof id !== 'string' || !ID.test(id)) throw invalid('id is invalid')
  const info = deleteRows(s, id)
  if (!info) return
  s.touch('attachments', id, info.parent_id)
  if (info.parent_type === 'note') s.touch('documents', info.parent_id)
  s.log('info', 'attachment-deleted', { id, parentType: info.parent_type })
  processFileDeletions(s)
}

// ---------- startup housekeeping (worker-internal) ----------

/**
 * `.partial` files are left only by a crash mid-write. One whose row committed is
 * completed (the rename after commit never ran); any other is removed. Run at open,
 * before anything can write.
 */
export function sweepPartials(s: StoreCtx): void {
  const root = join(s.userDataDir, ROOT)
  if (!existsSync(root)) return
  let completed = 0
  let removed = 0
  for (const shard of readdirSync(root, { withFileTypes: true })) {
    if (!shard.isDirectory()) continue
    for (const f of readdirSync(join(root, shard.name))) {
      if (!f.endsWith(`.bin${PARTIAL}`)) continue
      const id = f.slice(0, -`.bin${PARTIAL}`.length)
      const partial = join(root, shard.name, f)
      try {
        const hasRow = ID.test(id) && !!s.db.prepare(`SELECT 1 FROM attachments WHERE id = ?`).get(id)
        if (hasRow && !existsSync(blobPath(s, id))) {
          renameSync(partial, blobPath(s, id))
          completed++
        } else {
          rmSync(partial, { force: true })
          removed++
        }
      } catch (err) {
        s.log('warn', 'attachment-partial-sweep-failed', { file: f, err })
      }
    }
  }
  if (completed || removed) s.log('info', 'attachment-partials-swept', { completed, removed })
}
