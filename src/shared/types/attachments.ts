// SPDX-License-Identifier: Apache-2.0
// Note images and chat or folder files. Files are
// encrypted at rest in the storage worker; the renderer sends paths
// (from `files.pathForFile`) or pasted image bytes, never anything else.

import type { IsoTime } from './common'
import type { NoteAttachment, ScreenShareContext } from './notes'

export type AttachmentParentType = 'note' | 'chat_thread' | 'folder'
export type AttachmentKind = 'image' | 'file'
export type AttachmentStatus = 'processing' | 'ready' | 'failed'

/** A dropped or picked file (a path), or a pasted image's bytes. */
export type AttachmentInput = { path: string } | { name: string; mimeType: string; bytes: Uint8Array }

/** An `attachments` row as the renderer sees it (no key, no hash). */
export interface AttachmentInfo {
  id: string
  parent_type: AttachmentParentType
  parent_id: string
  kind: AttachmentKind
  file_name: string
  mime_type: string
  byte_size: number
  width: number | null
  height: number | null
  page_count: number | null
  status: AttachmentStatus
  error: string | null
  token_estimate: number | null
  has_summary: boolean
  screen_capture_info: ScreenShareContext | null
  created_at: IsoTime
}

/** A refused file, with the copy to show, e.g. `Maximum of 10 attachments reached`. */
export interface AttachmentRejection {
  name: string
  message: string
}

export interface AddImagesResult {
  attachments: NoteAttachment[]
  rejected: AttachmentRejection[]
}

export interface AddFilesResult {
  accepted: AttachmentInfo[]
  rejected: AttachmentRejection[]
}

/** `attachments:read`: `unavailable` for a missing, unreadable or tampered file. */
export type AttachmentBytes = { status: 'ok'; mimeType: string; bytes: Uint8Array } | { status: 'unavailable' }

export const ATTACHMENT_LIMITS = {
  noteImages: 10,
  noteImageMaxSide: 2_000,
  chatImageMaxSide: 1_568,
  filesPerSelection: 200,
  fileMaxBytes: 31_457_280,
  chatTotalBytes: 31_457_280,
  pdfMaxPages: 100,
  chatTotalPdfPages: 100,
  sheetMaxRows: 1_000,
  convertTimeoutMs: 60_000,
  digestTimeoutMs: 60_000
} as const

export const NOTE_IMAGE_TYPES = ['image/png', 'image/jpeg'] as const

/** The accepted file types. `text/*` is matched by prefix. */
export const ATTACHMENT_FILE_TYPES: readonly string[] = [
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/pdf',
  'application/json',
  'image/png',
  'image/jpeg',
  'text/*',
  'text/markdown'
]

/** Invite links never offered as attached links. */
export const ATTACHED_LINK_SKIP_HOSTS = ['aka.ms', 'g.co', 'support.google.com', 'support.microsoft.com', 'tel.meet'] as const
