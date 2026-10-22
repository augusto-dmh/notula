// SPDX-License-Identifier: Apache-2.0
// Importing Markdown notes and vaults. Main reads the chosen folder
// read-only, holds the preview in memory, and writes one note per item in one storage
// transaction. Paths come in only as handles main handed out; bytes never cross IPC.
//
// Stored batch and item rows (`import_batches`, `import_items`, migration 9) use the SQL column
// names; preview shapes are camelCase.

import type { IsoTime } from './common'
import type { CanonicalKey } from './sources'

/** The user's choice for the whole import. */
export type ImportPreset = 'auto' | 'plain' | 'obsidian' | 'notula-export' | 'study-vault'
/** How one item is read. */
export type ImportFormat = 'plain' | 'obsidian' | 'notula-export' | 'study-lesson' | 'transcript-copy'
export type ImportFolderMode = 'mirror' | 'single' | 'none'

export interface ImportOptions {
  folderMode: ImportFolderMode
  /** Notula export only. */
  trash: 'skip' | 'import-into-trash'
  /** Shown only with `sources.enabled`. */
  findSourcesAfter: boolean
  /** Study vault: also import other Markdown files as plain notes. */
  includeOtherFiles: boolean
}

/** A preview row's status, first match wins. */
export type ImportRowStatus =
  | 'new'
  | 'already-imported'
  | 'changed'
  | 'duplicate'
  | 'already-in-notula'
  | 'in-trash'
  | 'skipped'
  | 'unreadable'

export type ImportTitleOrigin = 'front-matter' | 'heading' | 'header-line' | 'summary-heading' | 'file-name' | 'folder'
export type ImportDateOrigin = 'export' | 'front-matter' | 'date-line' | 'summary-date' | 'file-name' | 'file-time'

export type CandidateRole = 'source' | 'series' | 'reference' | 'plain'

/** A URL found in an item, at most 200 per item. */
export interface CandidateLink {
  url: string
  role: CandidateRole
  /** `Video`, `Lesson`, a front-matter key, or null for a body link. */
  label: string | null
  canonicalKey: CanonicalKey | null
  /** A `t=` start offset, kept as a hint. */
  startMs: number | null
}

export interface ImportPreviewRow {
  itemId: string
  /** Relative to the import root; a multi-file item shows its folder. */
  relPath: string
  format: ImportFormat
  title: string
  titleOrigin: ImportTitleOrigin
  createdAt: IsoTime
  dateOrigin: ImportDateOrigin
  /** e.g. `["Course", "Module"]`; empty = no folder. */
  folderPath: string[]
  folderExists: boolean
  contents: {
    noteText: boolean
    summaries: number
    transcript: { lines: number; timed: boolean } | null
    sources: number
    references: number
  }
  status: ImportRowStatus
  /** The reason for `skipped` and `unreadable`, or the other path for `duplicate`. */
  detail: string | null
  warnings: string[]
  ticked: boolean
  /** Rows the status rules forbid ticking. */
  tickable: boolean
}

/** `notes-import:get-preview`; held in main for 30 minutes or until the next scan. */
export interface ImportPreview {
  previewId: string
  preset: ImportPreset
  options: ImportOptions
  rows: ImportPreviewRow[]
  summary: {
    notes: number
    summaries: number
    transcripts: number
    newFolders: number
    existingFolders: number
    skipped: number
    alreadyInNotula: number
  }
  expiresAt: IsoTime
  /**
   * Course outlines (`CURRICULUM.md`) a study-vault scan found, for the done screen's "Import
   * catalog for <course>": `handle` goes to `sources:import-catalog` as
   * `{kind: 'file', handle}` (`catalogFileHandle`).
   */
  catalogs?: { course: string; relPath: string; handle: string }[]
}

export type ImportScanState = 'idle' | 'scanning' | 'previewed' | 'cancelled' | 'failed'

export interface ImportScanProgress {
  previewId: string
  state: ImportScanState
  read: number
  total: number
  reason: string | null
}

export type ImportBatchState = 'queued' | 'running' | 'complete' | 'cancelled' | 'failed' | 'undone'
export type ImportItemState = 'planned' | 'done' | 'skipped' | 'failed' | 'undone'

export interface ImportCounts {
  planned: number
  done: number
  skipped: number
  failed: number
}

/** `import_batches`. */
export interface ImportBatch {
  id: string
  workspace_id: string
  owner_id: string
  root_path: string
  preset: ImportPreset
  options: ImportOptions
  state: ImportBatchState
  counts: ImportCounts
  created_folder_ids: string[]
  error: string | null
  created_at: IsoTime
  updated_at: IsoTime
  finished_at: IsoTime | null
  undone_at: IsoTime | null
}

/** `import_items`. */
export interface ImportItem {
  id: string
  batch_id: string
  workspace_id: string
  owner_id: string
  source_key: string
  rel_path: string
  format: ImportFormat
  content_hash: string
  size_bytes: number
  note_id: string | null
  export_note_id: string | null
  state: ImportItemState
  reason: string | null
  candidates: CandidateLink[]
  /** Original title, dates found, unmapped properties, tags, wikilink targets, calendar block, lesson hints. */
  meta: Record<string, unknown>
  imported_title: string | null
  created_at: IsoTime
  updated_at: IsoTime
}

/** `notes-import:progress`, after each item. */
export interface ImportProgress {
  batchId: string
  state: ImportBatchState
  counts: ImportCounts & { total: number }
  /**
   * On the push that ends a run: the notes it made, its skipped and failed files with their
   * reasons (at most 500), and the notes with a transcript and no summary.
   */
  report?: {
    noteIds: string[]
    needSummary: string[]
    issues: { relPath: string; state: 'skipped' | 'failed'; reason: string }[]
  }
}

/** `notes-import:undo-preview`. */
export interface ImportUndoPreview {
  batchId: string
  notes: { noteId: string; title: string | null; changedSinceImport: boolean }[]
  /** Created folders that would be empty afterwards. */
  foldersToDelete: number
}

/** `notes-import:get-candidates`, for Find sources. */
export interface ImportCandidates {
  noteId: string
  candidates: CandidateLink[]
  /** Series name hints, lesson number hints (title pattern, folder number). */
  hints: { series: string | null; lessonFromTitle: number | null; lessonFromFolder: number | null }
  /** The last anchor of a timed transcript: a lower bound for a hit's duration. */
  lastAnchorMs: number | null
}

/**
 * An imported transcript's `transcription_sessions` row. A session with model `untimed` hides
 * its chunk times in the transcript view and in the summary's transcript input.
 */
export const IMPORT_SESSION = {
  provider: 'import',
  timed: 'timed',
  untimed: 'untimed',
  endReason: 'import_complete'
} as const

export const IMPORT_LIMITS = {
  entries: 20_000,
  itemsPerBatch: 5_000,
  fileBytes: 4 * 1024 * 1024,
  scanBytes: 1024 * 1024 * 1024,
  depth: 16,
  frontMatterBytes: 64 * 1024,
  titleCodePoints: 300,
  chunksPerNote: 20_000,
  candidatesPerItem: 200,
  previewTtlMs: 30 * 60 * 1_000
} as const
