// SPDX-License-Identifier: Apache-2.0
// The local data export. It writes the user's notes in plaintext, so main creates one
// export folder and the storage worker writes only inside it.

export interface DataExportInclude {
  notes: boolean
  transcripts: boolean
  index: boolean
  encryptedDb: boolean
  decryptedDb: boolean
}

/** `export:start`. Both confirmations are re-checked in main. */
export interface DataExportRequest {
  /** A folder `export:choose-folder` returned. */
  folder: string
  include: DataExportInclude
  includeTrash: boolean
  confirmedPlaintext: boolean
  confirmedDecryptedDb: boolean
  /**
   * `markdown`: Export notes as Markdown (content sources): one `.md` per note in the folder
   * tree, stamped bodies, transcripts beside them. Absent = `standard`, the export as before.
   */
  format?: DataExportFormat
}

export type DataExportFormat = 'standard' | 'markdown'

export type DataExportPhase = 'notes' | 'transcripts' | 'index' | 'database'

export interface DataExportProgress {
  exportId: string
  phase: DataExportPhase
  done: number
  total: number
}

export interface DataExportDone {
  exportId: string
  path: string
  cancelled: boolean
  counts: { notes: number; transcripts: number; trashed: number }
  errors: { noteId: string; message: string }[]
}

export const DATA_EXPORT = {
  batchNotes: 20,
  baseNameMax: 120,
  /** 2: section markers and timed transcripts (src/main/sources/export-md.ts). */
  exportVersion: 2,
  indexColumns: [
    'id',
    'title',
    'meeting_date',
    'created_at',
    'updated_at',
    'attendees',
    'folders',
    'has_summary',
    'has_transcript',
    'trashed',
    'created_via',
    'notes_file',
    'transcript_file'
  ]
} as const
