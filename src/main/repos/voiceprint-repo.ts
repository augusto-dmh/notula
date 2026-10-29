// SPDX-License-Identifier: Apache-2.0
// Voiceprint (main only; the vectors never cross IPC): the storage-worker side of its StorageApi
// group. Worker-safe: no Electron imports.
//
// Biometric data: it lives only in this SQLCipher table,
// is never logged (counts only), and Forget deletes it with `secure_delete` on, then checkpoints
// the WAL so no old page image outlives the delete.

import { SPEAKER_PROFILE_LIMITS } from '@shared/types/speakers'
import type { VoiceprintRow } from '../storage/api'
import { getSettingsRaw } from '../storage/kv-repo'
import { nowIso, parseJson } from '../storage/rows'
import { ensureSelfPerson } from '../storage/speaker-people-repo'
import { checkpointVoice, checkVector, insertExemplar, secureWrite } from '../storage/speaker-voice-repo'
import { inTransaction, invalid, type StoreCtx } from '../storage/store'

type Row = Record<string, unknown>
type Centroid = VoiceprintRow['centroids'][number]

const MAX_CENTROIDS = 4
const MAX_DIMS = 1024

function validCentroid(c: unknown): c is Centroid {
  if (!c || typeof c !== 'object') return false
  const x = c as Centroid
  return (
    Array.isArray(x.vector) &&
    x.vector.length > 0 &&
    x.vector.length <= MAX_DIMS &&
    x.vector.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    typeof x.totalSpeechMs === 'number' &&
    Number.isFinite(x.totalSpeechMs) &&
    x.totalSpeechMs >= 0 &&
    typeof x.updatedAt === 'string'
  )
}

function toVoiceprint(r: Row): VoiceprintRow {
  const centroids = parseJson<unknown[]>(r['centroids'], []).filter(validCentroid)
  return {
    id: String(r['id']),
    model_id: String(r['model_id']),
    centroids,
    total_speech_ms: Number(r['total_speech_ms'] ?? 0),
    updated_at: String(r['updated_at'])
  }
}

export function getVoiceprint(s: StoreCtx, modelId: string): VoiceprintRow | null {
  if (typeof modelId !== 'string' || !modelId) return null
  const r = s.db
    .prepare(`SELECT * FROM voiceprints WHERE owner_id = ? AND workspace_id = ? AND model_id = ?`)
    .get(s.identity.ownerId, s.identity.workspaceId, modelId) as Row | undefined
  return r ? toVoiceprint(r) : null
}

export function saveVoiceprint(s: StoreCtx, v: VoiceprintRow): void {
  if (!v || typeof v.id !== 'string' || !v.id || typeof v.model_id !== 'string' || !v.model_id) throw invalid('id and model_id are required')
  if (!Array.isArray(v.centroids) || v.centroids.length === 0 || v.centroids.length > MAX_CENTROIDS || !v.centroids.every(validCentroid)) {
    throw invalid('invalid centroids')
  }
  const total = Math.max(0, Math.round(Number(v.total_speech_ms) || 0))
  const now = nowIso()
  inTransaction(s.db, () => {
    s.db
      .prepare(
        `INSERT INTO voiceprints (id, workspace_id, owner_id, model_id, centroids, total_speech_ms, created_at, updated_at)
         VALUES (@id, @ws, @owner, @model, @centroids, @total, @now, @updated)
         ON CONFLICT (owner_id, model_id) DO UPDATE SET centroids = excluded.centroids,
           total_speech_ms = excluded.total_speech_ms, updated_at = excluded.updated_at`
      )
      .run({
        id: v.id,
        ws: s.identity.workspaceId,
        owner: s.identity.ownerId,
        model: v.model_id,
        centroids: JSON.stringify(v.centroids),
        total,
        now,
        updated: typeof v.updated_at === 'string' && v.updated_at ? v.updated_at : now
      })
  })
  s.touch('voiceprints')
  s.log('info', 'voiceprint:saved', { centroids: v.centroids.length, totalSpeechMs: total })
}

export function deleteVoiceprints(s: StoreCtx): number {
  const before = s.db.pragma('secure_delete', { simple: true }) as number
  s.db.pragma('secure_delete = ON')
  let n = 0
  try {
    n = inTransaction(s.db, () => s.db.prepare(`DELETE FROM voiceprints WHERE owner_id = ?`).run(s.identity.ownerId).changes)
  } finally {
    s.db.pragma(`secure_delete = ${before ? 'ON' : 'OFF'}`)
  }
  try {
    s.db.pragma('wal_checkpoint(TRUNCATE)')
  } catch (err) {
    s.log('warn', 'voiceprint:checkpoint-failed', { err })
  }
  s.touch('voiceprints')
  s.log('info', 'voiceprint:deleted', { rows: n })
  return n
}

/** The model id the Labs self voiceprint was stored under (the ResNet-34 file). */
const LEGACY_MODEL_ID = 'wespeaker-en-voxceleb-resnet34'

/**
 * Speaker profiles, at first start on schema 12 (then a no-op: the table ends empty). With
 * `aliasModelId` (the shipped extractor is the ResNet-34 file itself), each legacy centroid
 * becomes a self mic exemplar `via legacy` under that SHA. Otherwise they can't be compared with
 * the new model. Either way every legacy row is secure-deleted.
 */
export function convertLegacyVoiceprints(s: StoreCtx, q: { aliasModelId: string | null }): { converted: number; deleted: number } {
  const rows = s.db.prepare(`SELECT * FROM voiceprints WHERE owner_id = ?`).all(s.identity.ownerId) as Row[]
  if (!rows.length) return { converted: 0, deleted: 0 }
  const alias = typeof q?.aliasModelId === 'string' && q.aliasModelId ? q.aliasModelId : null
  const legacy = alias ? rows.filter((r) => r['model_id'] === LEGACY_MODEL_ID).flatMap((r) => toVoiceprint(r).centroids) : []
  const self = legacy.length ? ensureSelfPerson(s, String(getSettingsRaw(s)['profile.name'] ?? '')) : null
  let converted = 0
  const deleted = secureWrite(s, () => {
    for (const c of legacy) {
      let vector: Float32Array
      try {
        vector = checkVector(c.vector)
      } catch {
        continue
      }
      insertExemplar(s, {
        personId: self!.id,
        modelId: alias!,
        channel: 'mic',
        vector,
        cleanMs: Math.round(c.totalSpeechMs),
        // The profile's speech, as a confirmation's clean speech; never below a tenth.
        weight: Math.min(1, Math.max(0.1, c.totalSpeechMs / SPEAKER_PROFILE_LIMITS.exemplarWeightFullMs)),
        sourceNoteId: null,
        sourcePassId: null,
        sourceLabel: null,
        spanStartMs: null,
        spanEndMs: null,
        via: 'legacy'
      })
      converted++
    }
    return s.db.prepare(`DELETE FROM voiceprints WHERE owner_id = ?`).run(s.identity.ownerId).changes
  })
  checkpointVoice(s)
  s.touch('voiceprints')
  if (converted) s.touch('speaker_exemplars', self!.id)
  s.log('info', 'speakers:legacy-converted', { converted, deleted })
  return { converted, deleted }
}
