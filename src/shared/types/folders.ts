// SPDX-License-Identifier: Apache-2.0
// Folders and lists. Stored
// records use the `folders` / `folder_rules` column names (snake_case); requests are
// camelCase. A folder delete never touches notes.

import type { IsoTime } from './common'
import type { TemplateIcon } from './templates'

/** The template seeds of "Or start from a template". */
export type FolderPresetId =
  | 'interviews'
  | 'standups'
  | 'projects'
  | 'sales_pipeline'
  | 'team_syncs'
  | 'coaching'
  | 'demos'
  /** The Customer calls folder; never offered in the preset picker. */
  | 'client_meetings'

export interface Folder {
  id: string
  workspace_id: string
  owner_id: string
  /** null = top level. */
  parent_id: string | null
  title: string
  description: string | null
  /** The templates.ts shape; the default is `{ type: 'icon', value: 'FolderIcon', color }`. */
  icon: TemplateIcon | null
  preset: FolderPresetId | null
  is_favourite: boolean
  /** Always `private` for now; kept so a future multi-user build can share folders. */
  visibility: 'private' | 'workspace'
  sort_order: number
  created_at: IsoTime
  updated_at: IsoTime
}

/** `folders:create`. Rejects `invalid-input` for a third level. */
export interface FolderCreate {
  id?: string
  title: string
  description?: string | null
  icon?: TemplateIcon | null
  parentId?: string | null
  preset?: FolderPresetId | null
}

/** `folders:update`. `is_favourite` cascades to descendants; a `parent_id` change is validated. */
export type FolderPatch = Partial<Pick<Folder, 'title' | 'description' | 'icon' | 'is_favourite' | 'parent_id'>>

/** How a note entered a folder (`folder_notes.source`). */
export type FolderNoteSource =
  | 'manual'
  | 'palette'
  | 'dragged'
  | 'add_notes'
  | 'suggestion'
  | 'series_rule'

export type FolderRuleTarget = { type: 'single'; event_id: string } | { type: 'all'; excluded_event_ids: string[] }

/** An auto-add rule for a recurring series. */
export interface FolderRule {
  id: string
  folder_id: string
  recurring_event_id: string
  target: FolderRuleTarget
  created_at: IsoTime
}

/** `folders:set-rule`: replaces the rule for the same series in that folder. */
export interface FolderRuleInput {
  folderId: string
  recurringEventId: string
  target: FolderRuleTarget
}

/** `folders:list`. */
export interface FoldersState {
  folders: Folder[]
  /** Folder id → note ids. */
  membership: Record<string, string[]>
  rules: FolderRule[]
}

/** `folders:suggest` (the suggestion bar). */
export type FolderSuggestion =
  | { type: 'recurring_event'; folderId: string; recurringEventId: string }
  | { type: 'ai_match'; folderId: string }
  | { type: 'create_folder'; title: string; recurringEventId: string }

/** The "My notes" section id (`/list/my-notes`). */
export const MY_NOTES_SECTION_ID = 'my-notes'

export const FOLDER_LIMITS = {
  topFolders: 5,
  topThreshold: 10,
  frecencyPicks: 2,
  frecencyMinScore: 300,
  newFolderMs: 86_400_000,
  activityHalfLifeDays: 14,
  activityCutoffDays: 45,
  usesKept: 10,
  useDedupMs: 5_000,
  settingsAutosaveMs: 500,
  suggestionSettleMs: 500,
  newFolderMinNotes: 3,
  aiSummaryChars: 2_000
} as const

/** Drag data of note rows: a JSON `string[]` of note ids. Note rows set it; folder targets read it. */
export const NOTE_DRAG_MIME = 'application/x-notula-note-ids'
