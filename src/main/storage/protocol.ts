// SPDX-License-Identifier: Apache-2.0
// The MessagePort RPC between main's StorageApi client (index.ts) and the
// notula-storage utility process (worker.ts):
//   main → worker  { id, method, params }
//   worker → main  { id, ok, result | error }, plus events { type: 'changed' | 'status' | 'log' | 'hello' }

import type { ErrorCode } from '@shared/errors'
import type { StorageState } from '@shared/types/storage'
import type { StorageApi } from './api'

/** Schema version this build migrates to (PRAGMA user_version); 8 is the baseline, 9 adds sources and imports, 10 dictation usage. */
export const SCHEMA_VERSION = 10

export const DB_FILE = 'notula.db'
export const KEY_FILE = 'notula.key'
/** The files that make up one database: moved, exported and backed up together. */
export const DB_SIDE_FILES = [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`] as const

/** StorageApi methods the worker serves directly. */
export type DataMethods = Omit<StorageApi, 'open' | 'status' | 'recover' | 'onChange' | 'close'>
export type DataMethod = keyof DataMethods

/** The worker side of a data method: synchronous, same arguments, unwrapped result. */
export type SyncMethods<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => Promise<infer R> ? (...args: A) => R : never
}

export interface OpenParams {
  dataDir: string
  /** 64 hex characters; the raw SQLCipher key. Never logged. */
  keyHex: string
  appVersion: string
  /** Dev only: append a migration that always fails. */
  devFailMigration: boolean
  /** Dev only: treat the database as written by a newer Notula. */
  devVersionAhead: boolean
  /**
   * Startup housekeeping (reset `transcribe`, finalize partial chunks). Only on the
   * first open that reaches `ready` in an app run: a Retry re-open must not end a
   * session that is still capturing.
   */
  housekeeping: boolean
}

/** What the worker knows about the state; main adds `dataPath`. */
export interface WorkerStatus {
  state: Exclude<StorageState, 'starting' | 'key-unavailable' | 'encryption-unavailable'> | 'closed'
  detail?: string
  backupPath?: string
  schemaVersion?: number
  expectedVersion: number
}

export interface DebugSearchResult {
  documents: { id: string; title: string | null }[]
  panels: { id: string; document_id: string }[]
}

/** Control methods that are not part of StorageApi. */
export interface ControlMethods {
  open(p: OpenParams): WorkerStatus
  close(): void
  /** `wal_checkpoint(TRUNCATE)`, so the .db file alone is complete (export). */
  checkpoint(): void
  /** Dev only: FTS lookup. */
  debugSearch(query: string): DebugSearchResult
}

export type WorkerMethods = SyncMethods<DataMethods> & ControlMethods
export type WorkerMethod = keyof WorkerMethods

export interface WorkerRequest {
  id: number
  method: WorkerMethod
  params: unknown[]
}

export type WorkerReply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: ErrorCode; message: string } }

export type WorkerEvent =
  | { type: 'hello' }
  | { type: 'changed'; tables: string[]; ids: string[] }
  | { type: 'status'; status: WorkerStatus }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; event: string; data?: Record<string, unknown> }

export type WorkerMessage = WorkerReply | WorkerEvent

export function isReply(m: WorkerMessage): m is WorkerReply {
  return typeof (m as { id?: unknown }).id === 'number'
}
