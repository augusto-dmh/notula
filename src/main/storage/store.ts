// SPDX-License-Identifier: Apache-2.0
// Shared pieces of the storage worker's repositories.

import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers'
import type { ErrorCode } from '@shared/errors'
import type { StorageIdentity } from './api'
import type { WorkerEvent } from './protocol'

export type Db = BetterSqlite3.Database

type LogEvent = Extract<WorkerEvent, { type: 'log' }>

export interface StoreCtx {
  db: Db
  identity: StorageIdentity
  /** `<userData>/tmp`: per-note temp audio, removed after a purge (`file_deletions`). */
  tmpDir: string
  /**
   * `<userData>`, the base of the `rel:<root>/<path>` file roots
   * (`tmp`, `audio`, `attachments`, `dictation-audio`) and of the attachment blobs.
   */
  userDataDir: string
  /** Records a write for the change feed (coalesced per microtask). */
  touch(table: string, ...ids: string[]): void
  log(level: LogEvent['level'], event: string, data?: Record<string, unknown>): void
}

/** An error the worker replies with as `<code>: <message>`. */
export class StoreError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string
  ) {
    super(message)
  }
}

export function notFound(what: string, id: string): StoreError {
  return new StoreError('not-found', `${what} ${id} not found`)
}

export function invalid(message: string): StoreError {
  return new StoreError('invalid-input', message)
}

/** Runs `fn` in one transaction (BEGIN IMMEDIATE), so one RPC call is one commit. */
export function inTransaction<T>(db: Db, fn: () => T): T {
  return db.transaction(fn).immediate()
}
