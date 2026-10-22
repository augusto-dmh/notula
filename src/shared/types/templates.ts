// SPDX-License-Identifier: Apache-2.0
// Note templates. Stored rows use the
// `note_templates` column names; built-ins are shared constants, never rows.

import type { IsoTime } from './common'

export type TemplateIcon =
  | { type: 'icon'; value: string; color: string }
  | { type: 'emoji'; value: string; hexcode: string }

export interface TemplateSection {
  id: string
  heading: string
  section_hint: string
}

export interface NoteTemplate {
  id: string
  /** null for a built-in. */
  workspace_id: string | null
  /** null for a built-in. */
  owner_id: string | null
  title: string
  description: string
  sections: TemplateSection[]
  category: string | null
  icon: TemplateIcon | null
  /** Set when merged into list results; never stored. */
  is_builtin: boolean
  /** Always null (no sharing server). */
  shared_with: null
  copied_from: string | null
  created_at: IsoTime
  /** null for a fresh copy. */
  updated_at: IsoTime | null
  deleted_at: IsoTime | null
}

export interface NoteTemplateCreate {
  id?: string
  title: string
  description: string
  sections: TemplateSection[]
  category: string | null
  icon: TemplateIcon | null
  copied_from: string | null
}

export type NoteTemplatePatch = Partial<Pick<NoteTemplate, 'title' | 'description' | 'sections' | 'icon'>>

/** The built-in catalog's fixed ids. The content lives in src/main/templates/catalog.ts. */
export const BUILTIN_TEMPLATE_IDS = {
  'one-on-one': '662713c8-88b0-4dda-9cc3-e8d5f6ea8fc9',
  'team-meeting': '836f8f26-ec90-43d8-a39a-efc7d6aa1c75',
  'stand-up': 'ea48f6bb-1293-46fd-8ebb-e7d41a6ca249',
  'project-kick-off': 'f4ad441d-f78f-47a6-9cda-f78b9dda2aff',
  'sales-meeting': 'c7468804-7f36-49ca-8cea-bcf92ad20dc4',
  'customer-check-in': '167a4649-0178-4ef6-8aa0-d0ae7c4d7bdc',
  'user-interview': '8fff9850-a725-4a1a-9f24-8043638453ef',
  'candidate-interview': 'aeb2a8e0-3576-40fd-8f5b-039919f03400',
  brainstorm: '0266492a-a136-41df-8792-1d2f822b7e43',
  /** A video or course lesson (content sources): `LESSON_TEMPLATE_ID`. */
  lesson: '9b8f4427-7f53-4488-bd79-0c3689d18cd3'
} as const

/** `templates.usage`: the newest uses kept per template. */
export const TEMPLATE_USAGE_MAX = 10
/** Two uses of one template within this window record once. */
export const TEMPLATE_USAGE_DEDUP_MS = 5_000
/** Quick picks in the template chip's menu. */
export const TEMPLATE_QUICK_PICKS = 5
