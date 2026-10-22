// SPDX-License-Identifier: Apache-2.0
// Panels (the `note_panels` table): AI-enhanced notes attached to a note.

import type { IsoTime } from './common'
import type { EnhanceErrorCode } from './enhance'

/** A line without `matches` is AI-generated. */
export interface GeneratedLine {
  text: string
  matches?: string[]
}

export interface Panel {
  id: string
  document_id: string
  workspace_id: string
  owner_id: string
  created_at: IsoTime
  updated_at: IsoTime
  content_edited_at: IsoTime | null
  deleted_at: IsoTime | null
  title: string
  template_key: string | null
  /** ProseMirror JSON projection written by the renderer, or null. */
  content: unknown
  /** The current markdown. */
  content_markdown: string | null
  /** The generated markdown; never edited. */
  generated_content: string | null
  last_opened_at: IsoTime | null
  enhance_started_at: IsoTime | null
  enhance_failed_at: IsoTime | null
  enhance_error: EnhanceErrorCode | null
  ai_line_map: GeneratedLine[] | null
  speakers_attributed: boolean
  crdt_version: number
}

/** Renderer-writable panel fields. Generation fields are main-only. */
export type PanelPatch = Partial<
  Pick<Panel, 'title' | 'content' | 'content_markdown' | 'last_opened_at' | 'deleted_at'>
>
