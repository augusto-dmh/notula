// SPDX-License-Identifier: Apache-2.0
// `meta`, `settings` (+ `settings_rejected`) and `secrets`.
// Settings rows that cannot be parsed or fail their validator are moved to
// `settings_rejected` when read, in one transaction, and the key falls back to its
// default. Nothing is discarded. Unknown keys (an older or newer
// Notula's) are left in place and ignored.

import { randomUUID } from 'node:crypto'
import { isSecretId, type SecretId, type SettingKey, type Settings } from '@shared/types/settings'
import { isSettingKey, isValidSetting } from '../settings/schema'
import type { StorageIdentity } from './api'
import { nowIso, toBuffer } from './rows'
import { inTransaction, invalid, type Db, type StoreCtx } from './store'

function assertSecretId(id: unknown): asserts id is SecretId {
  if (!isSecretId(id)) throw invalid('unknown secret id')
}

export function readMeta(db: Db, key: string): string | null {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined
  return row?.value ?? null
}

/**
 * Creates the implicit local workspace and owner on first open and records
 * the app and preference-document versions.
 */
export function ensureMeta(db: Db, appVersion: string, prefsVersion: number): StorageIdentity {
  return inTransaction(db, () => {
    const put = db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING`)
    put.run('workspace_id', randomUUID())
    put.run('owner_id', randomUUID())
    put.run('created_at', nowIso())
    put.run('prefs_version', String(prefsVersion))
    db.prepare(`INSERT INTO meta (key, value) VALUES ('last_app_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(
      appVersion
    )
    return { workspaceId: readMeta(db, 'workspace_id') as string, ownerId: readMeta(db, 'owner_id') as string }
  })
}

export function getSettingsRaw(s: StoreCtx): Partial<Settings> {
  const rows = s.db.prepare(`SELECT key, value FROM settings WHERE owner_id = ?`).all(s.identity.ownerId) as {
    key: string
    value: string
  }[]
  const out: Partial<Record<SettingKey, unknown>> = {}
  const rejected: { key: string; value: string; reason: string }[] = []
  for (const row of rows) {
    if (!isSettingKey(row.key)) continue
    let value: unknown
    try {
      value = JSON.parse(row.value)
    } catch {
      rejected.push({ ...row, reason: 'unparseable' })
      continue
    }
    if (!isValidSetting(row.key, value)) {
      rejected.push({ ...row, reason: 'invalid' })
      continue
    }
    out[row.key] = value
  }
  if (rejected.length) {
    const now = nowIso()
    inTransaction(s.db, () => {
      const copy = s.db.prepare(
        `INSERT INTO settings_rejected (id, owner_id, key, value, reason, moved_at) VALUES (?, ?, ?, ?, ?, ?)`
      )
      const drop = s.db.prepare(`DELETE FROM settings WHERE owner_id = ? AND key = ?`)
      for (const r of rejected) {
        copy.run(randomUUID(), s.identity.ownerId, r.key, r.value, r.reason, now)
        drop.run(s.identity.ownerId, r.key)
      }
    })
    s.touch('settings', ...rejected.map((r) => r.key))
    s.log('warn', 'settings-rejected', { keys: rejected.map((r) => r.key), reasons: rejected.map((r) => r.reason) })
  }
  return out as Partial<Settings>
}

export function setSettingRaw(s: StoreCtx, key: SettingKey, value: unknown): void {
  if (!isSettingKey(key)) throw invalid(`unknown setting ${String(key)}`)
  if (!isValidSetting(key, value)) throw invalid(`invalid value for ${key}`)
  inTransaction(s.db, () =>
    s.db
      .prepare(
        `INSERT INTO settings (owner_id, key, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (owner_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(s.identity.ownerId, key, JSON.stringify(value), nowIso())
  )
  s.touch('settings', key)
}

export function getSecretBlob(s: StoreCtx, id: SecretId): Uint8Array | null {
  assertSecretId(id)
  const row = s.db.prepare(`SELECT ciphertext FROM secrets WHERE id = ?`).get(id) as { ciphertext: Buffer } | undefined
  return row ? new Uint8Array(row.ciphertext) : null
}

/** Every stored secret id that is still a known id (the diagnostics scrub covers them all). */
export function listSecretIds(s: StoreCtx): SecretId[] {
  const rows = s.db.prepare(`SELECT id FROM secrets ORDER BY id`).all() as { id: string }[]
  return rows.map((r) => r.id).filter((id): id is SecretId => isSecretId(id))
}

export function setSecretBlob(s: StoreCtx, id: SecretId, blob: Uint8Array): void {
  assertSecretId(id)
  if (!(blob instanceof Uint8Array) || blob.byteLength === 0) throw invalid('secret ciphertext must be non-empty bytes')
  inTransaction(s.db, () =>
    s.db
      .prepare(
        `INSERT INTO secrets (id, ciphertext, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`
      )
      .run(id, toBuffer(blob), nowIso())
  )
  s.touch('secrets', id)
}

export function deleteSecretBlob(s: StoreCtx, id: SecretId): void {
  assertSecretId(id)
  const changes = inTransaction(s.db, () => s.db.prepare(`DELETE FROM secrets WHERE id = ?`).run(id).changes)
  if (changes) s.touch('secrets', id)
}
