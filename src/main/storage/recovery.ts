// SPDX-License-Identifier: Apache-2.0
// File operations behind the recovery actions. Notula never wipes user data, so nothing
// here deletes anything:
// "start fresh" moves the database files aside, and "export a copy" copies them.
//
// notula.key is wrapped by Electron safeStorage. On Windows that wrapping uses a
// master key kept, DPAPI-protected, in Chromium's `<userData>/Local State`, so a
// set of database files opens only together with that file, on this computer and
// under the same user account. Every export and recovered set therefore gets
// a copy of `Local State` and a README.txt that says so and how to restore.

import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { DB_SIDE_FILES, KEY_FILE } from './protocol'

/** db + wal + shm + key: the four files of one encrypted database. */
const RECOVERY_FILES = [...DB_SIDE_FILES, KEY_FILE] as const
/** Chromium's Local State, in userData (not in data/). */
export const LOCAL_STATE_FILE = 'Local State'
/** Migration backups, encrypted with the key they sit next to. */
const BACKUPS_DIR = 'backups'
/**
 * The encrypted attachment blobs, in userData. Their master key lives
 * inside the database, so the folder travels with the database files, as it is.
 */
const ATTACHMENTS_DIR = 'attachments'
/** Antivirus and indexers hold files briefly on Windows; a rename is retried. */
const RENAME_ATTEMPTS = 5
const RENAME_RETRY_MS = 200

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/** A short, non-secret id of the wrapped key file, to tell which set a key belongs to. */
function keyFingerprint(keyPath: string): string | null {
  if (!existsSync(keyPath)) return null
  return createHash('sha256').update(readFileSync(keyPath)).digest('hex').slice(0, 16)
}

function copyLocalState(userDataPath: string, dir: string): boolean {
  const from = join(userDataPath, LOCAL_STATE_FILE)
  if (!existsSync(from)) return false
  copyFileSync(from, join(dir, LOCAL_STATE_FILE))
  return true
}

function writeReadme(dir: string, how: string, files: string[], fingerprint: string | null): void {
  const lines = [
    'Notula data',
    '',
    `${how} on ${new Date().toISOString()}.`,
    `Files: ${files.join(', ') || 'none'}.`,
    ...(fingerprint ? [`Key file fingerprint: ${fingerprint}.`] : []),
    '',
    'These files are encrypted. notula.key holds the database key, and that key is itself protected by',
    "this computer's secure storage: on Windows through the \"Local State\" file (copied here), which",
    'Windows protects for the signed-in user; on macOS through the Keychain. So this copy opens only on',
    'this computer, signed in as the same user.',
    '',
    'To open it in Notula: quit Notula, then copy notula.db, notula.db-wal, notula.db-shm (when present)',
    'and notula.key into the "data" folder inside Notula\'s data folder, replacing what is there. On',
    'Windows, if Notula\'s data folder was reset or reinstalled since, also copy "Local State" into',
    'Notula\'s data folder (the folder that contains "data"), replacing that file.',
    '',
    'The "attachments" folder (when present) holds note images and chat or folder files, each one',
    'encrypted with its own key, which only this database can unlock. Copy it into Notula\'s data folder',
    '(next to "data") together with the database files.',
    ''
  ]
  writeFileSync(join(dir, 'README.txt'), lines.join('\r\n'))
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const transient = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
      if (!transient || attempt >= RENAME_ATTEMPTS) throw err
      await new Promise((r) => setTimeout(r, RENAME_RETRY_MS))
    }
  }
}

/**
 * Moves the four files and the migration backups made with their key to
 * `<userData>/recovered/<ts>/`, and copies `Local State` next to them. All or
 * nothing: when one move fails, the ones already done are moved back and the
 * error is thrown, so a .db is never split from its -wal. Returns that
 * folder and what moved.
 */
export async function moveAside(userDataPath: string, dataDir: string): Promise<{ dir: string; moved: string[] }> {
  const dir = join(userDataPath, 'recovered', stamp())
  mkdirSync(dir, { recursive: true })
  const fingerprint = keyFingerprint(join(dataDir, KEY_FILE))
  const moved: string[] = []
  // The attachments folder sits in userData; it goes aside with the database that holds its key.
  const source = (f: string): string => (f === ATTACHMENTS_DIR ? join(userDataPath, f) : join(dataDir, f))
  try {
    for (const f of [...RECOVERY_FILES, BACKUPS_DIR, ATTACHMENTS_DIR]) {
      const from = source(f)
      if (!existsSync(from)) continue
      await renameWithRetry(from, join(dir, f))
      moved.push(f)
    }
  } catch (err) {
    const stuck: string[] = []
    for (const f of [...moved].reverse()) {
      try {
        await renameWithRetry(join(dir, f), source(f))
      } catch {
        stuck.push(f)
      }
    }
    const why = err instanceof Error ? err.message : String(err)
    throw new Error(
      stuck.length
        ? `Moving the files aside failed (${why}), and ${stuck.join(', ')} could not be moved back from ${dir}.`
        : `Moving the files aside failed, so nothing was moved: ${why}`
    )
  }
  const files = copyLocalState(userDataPath, dir) ? [...moved, LOCAL_STATE_FILE] : moved
  writeReadme(dir, 'Moved aside by "Start fresh"', files, fingerprint)
  return { dir, moved }
}

/**
 * Copies the four files and `Local State` into a new folder under `destRoot`, with
 * a README. Returns that folder and what was copied.
 */
export function exportCopy(userDataPath: string, dataDir: string, destRoot: string): { dir: string; copied: string[] } {
  const dir = join(destRoot, `Notula data ${stamp()}`)
  mkdirSync(dir, { recursive: true })
  const copied: string[] = []
  for (const f of RECOVERY_FILES) {
    const from = join(dataDir, f)
    if (!existsSync(from)) continue
    copyFileSync(from, join(dir, f))
    copied.push(f)
  }
  if (copyLocalState(userDataPath, dir)) copied.push(LOCAL_STATE_FILE)
  // The encrypted blobs, as they are (never decrypted here).
  const blobs = join(userDataPath, ATTACHMENTS_DIR)
  if (existsSync(blobs)) {
    cpSync(blobs, join(dir, ATTACHMENTS_DIR), {
      recursive: true,
      errorOnExist: true,
      filter: (src) => !src.endsWith('.partial')
    })
    copied.push(ATTACHMENTS_DIR)
  }
  writeReadme(dir, 'Exported', copied, keyFingerprint(join(dataDir, KEY_FILE)))
  return { dir, copied }
}
