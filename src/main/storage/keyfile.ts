// SPDX-License-Identifier: Apache-2.0
// The database key: 32 random bytes, base64, wrapped by Electron safeStorage
// (DPAPI on Windows, the Keychain on macOS) in `<userData>/data/notula.key`.
//
// Notula never replaces a key that cannot be read and never creates a key next to an
// existing database: that is `key-unavailable`, and the user decides, because a new key
// would make the existing notes unreadable for good.

import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { DB_SIDE_FILES, KEY_FILE } from './protocol'

const KEY_BYTES = 32

export type KeyResult =
  | { ok: true; keyHex: string; created: boolean }
  | { ok: false; state: 'encryption-unavailable' | 'key-unavailable'; detail: string }

function hasDatabase(dataDir: string): boolean {
  return DB_SIDE_FILES.some((f) => {
    const p = join(dataDir, f)
    return existsSync(p) && statSync(p).size > 0
  })
}

/** Linux without a keyring falls back to a fixed password; that is not protection. */
export function encryptionAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false
  return true
}

/**
 * Writes `data` to `path` durably: a synced temp file renamed into place, then the
 * directory synced where the platform allows it. Without the syncs, a power loss
 * after the first launch could leave an empty key next to a database.
 */
function writeDurably(path: string, data: Buffer): void {
  const tmp = `${path}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
  // Windows cannot open a directory for syncing; NTFS journals the rename itself.
  if (process.platform === 'win32') return
  try {
    const dir = openSync(join(path, '..'), 'r')
    try {
      fsyncSync(dir)
    } finally {
      closeSync(dir)
    }
  } catch {
    // Best effort.
  }
}

export function loadOrCreateKey(dataDir: string): KeyResult {
  if (!encryptionAvailable()) {
    return {
      ok: false,
      state: 'encryption-unavailable',
      detail: 'The operating system’s secure storage is not available, and Notula never stores notes unencrypted.'
    }
  }
  const keyPath = join(dataDir, KEY_FILE)
  if (existsSync(keyPath)) {
    let raw: Buffer
    try {
      raw = Buffer.from(safeStorage.decryptString(readFileSync(keyPath)), 'base64')
    } catch {
      return {
        ok: false,
        state: 'key-unavailable',
        detail: 'The database key could not be unlocked with this computer’s secure storage.'
      }
    }
    if (raw.length !== KEY_BYTES) {
      return { ok: false, state: 'key-unavailable', detail: 'The database key file is damaged.' }
    }
    return { ok: true, keyHex: raw.toString('hex'), created: false }
  }
  if (hasDatabase(dataDir)) {
    return {
      ok: false,
      state: 'key-unavailable',
      detail: 'The database key file is missing, so the existing notes database cannot be opened.'
    }
  }
  try {
    mkdirSync(dataDir, { recursive: true })
    const key = randomBytes(KEY_BYTES)
    writeDurably(keyPath, safeStorage.encryptString(key.toString('base64')))
    return { ok: true, keyHex: key.toString('hex'), created: true }
  } catch (err) {
    return {
      ok: false,
      state: 'key-unavailable',
      detail: `A new database key could not be saved: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}
