// SPDX-License-Identifier: Apache-2.0
// When a History lookup copies the browser's History file again, and the snapshot lookups of the
// same file share. Pure: the file work and the clock come in through `SnapshotIo`, so
// scripts/dev/history-copy-check.ts can drive it with fake stats.

/** A fresh copy waits at least this long after the last one, so a busy file isn't copied every second. */
export const HISTORY_COPY_MIN_GAP_MS = 5_000
/** The most copies one lookup makes; past it, its rows come from the copy there is. */
export const HISTORY_COPY_MAX = 3

export interface FileStat {
  size: number
  mtimeMs: number
}

/** The History file's and its journal/WAL's size and mtime; a missing file reads `-`, so its appearing is a change. */
export function historySignatureOf(stats: readonly (FileStat | null)[]): string {
  return stats.map((s) => (s ? `${s.size}:${s.mtimeMs}` : '-')).join('|')
}

export interface CopyState {
  hasSnapshot: boolean
  /** The signature now. */
  signature: string
  /** The signature read before the last copy. */
  copiedSignature: string | null
  lastCopyAt: number
  /** The copies this lookup made. */
  copies: number
  /** When this lookup started; absent, the snapshot counts as taken after it. */
  startedAt?: number
  now: number
}

export function copyDecision(s: CopyState): 'copy' | 'reuse' {
  if (!s.hasSnapshot) return 'copy'
  if (s.signature === s.copiedSignature) return 'reuse'
  if (s.copies >= HISTORY_COPY_MAX) return 'reuse'
  // A snapshot older than the lookup (another lookup's copy) may miss what was written before
  // it started, so it copies at once, gap or not.
  if (s.startedAt !== undefined && s.lastCopyAt < s.startedAt) return 'copy'
  // A change too soon after a copy isn't lost: the next call compares the signatures again.
  return s.now - s.lastCopyAt < HISTORY_COPY_MIN_GAP_MS ? 'reuse' : 'copy'
}

export interface SnapshotIo {
  /** The source file's and each extra's stat, null when missing; the same order every call. */
  stat: () => Promise<(FileStat | null)[]>
  /** Copies the source to a new snapshot and returns its base path; removes its own partial files on a failure. */
  copy: () => Promise<string>
  remove: (base: string) => Promise<void>
  now: () => number
}

export interface Shared {
  base: string | null
  copiedSignature: string | null
  lastCopyAt: number
  users: number
  /** Reads, copies and the last dispose run one at a time, so no read meets a snapshot being replaced. */
  queue: Promise<unknown>
}

export interface SnapshotUse {
  /** Copies first when the policy says so, then runs `query` on the snapshot. */
  read: <T>(query: (base: string) => Promise<T>) => Promise<T>
  /** Copies this use caused, and the bytes they copied. */
  copies: () => number
  bytes: () => number
  dispose: () => Promise<void>
}

/**
 * One lookup's use of the snapshot of `key` in `registry`, shared with the other lookups of it that
 * are running. Each lookup counts its own copies against the cap, so one that joins late still
 * gets a copy taken after it started when the file has changed.
 */
export function useSnapshot(registry: Map<string, Shared>, key: string, io: SnapshotIo): SnapshotUse {
  let s = registry.get(key)
  if (!s) registry.set(key, (s = { base: null, copiedSignature: null, lastCopyAt: 0, users: 0, queue: Promise.resolve() }))
  const shared = s
  shared.users++
  const startedAt = io.now()
  let copies = 0
  let bytes = 0
  let disposed = false
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = shared.queue.then(fn)
    shared.queue = run.catch(() => undefined)
    return run
  }
  return {
    copies: () => copies,
    bytes: () => bytes,
    read: (query) =>
      serial(async () => {
        const stats = await io.stat()
        const signature = historySignatureOf(stats)
        const now = io.now()
        let base = shared.base
        if (base === null || copyDecision({ hasSnapshot: true, signature, copiedSignature: shared.copiedSignature, lastCopyAt: shared.lastCopyAt, copies, startedAt, now }) === 'copy') {
          if (base !== null) await io.remove(base)
          shared.base = null
          shared.base = base = await io.copy()
          shared.copiedSignature = signature
          shared.lastCopyAt = now
          copies++
          bytes += stats.reduce((n, st) => n + (st?.size ?? 0), 0)
        }
        return query(base)
      }),
    dispose: () =>
      serial(async () => {
        if (disposed) return
        disposed = true
        if (--shared.users > 0) return
        if (registry.get(key) === shared) registry.delete(key)
        if (shared.base !== null) await io.remove(shared.base)
        shared.base = null
      })
  }
}
