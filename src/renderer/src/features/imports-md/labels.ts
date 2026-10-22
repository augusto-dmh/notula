// SPDX-License-Identifier: Apache-2.0
// Interface text for Import notes (style/COPY.md): format, status and origin labels, and the
// small count helpers the dialogs share.

import type {
  ImportBatchState,
  ImportDateOrigin,
  ImportFormat,
  ImportPreset,
  ImportRowStatus,
  ImportTitleOrigin
} from '@shared/types/imports-markdown'

export const PRESET_LABEL: Record<ImportPreset, string> = {
  auto: 'Auto',
  plain: 'Markdown',
  obsidian: 'Obsidian',
  'notula-export': 'Notula export',
  'study-vault': 'Study notes'
}

export const FORMAT_LABEL: Record<ImportFormat, string> = {
  plain: 'Markdown',
  obsidian: 'Obsidian',
  'notula-export': 'Notula export',
  'study-lesson': 'Study lesson',
  'transcript-copy': 'Transcript'
}

export const STATUS_LABEL: Record<ImportRowStatus, string> = {
  new: 'New',
  'already-imported': 'Already imported',
  changed: 'Changed since last import',
  duplicate: 'Duplicate',
  'already-in-notula': 'Already in Notula',
  'in-trash': 'In Trash',
  skipped: 'Skipped',
  unreadable: 'Can’t read'
}

export const TITLE_ORIGIN: Record<ImportTitleOrigin, string> = {
  'front-matter': 'From properties',
  heading: 'From heading',
  'header-line': 'From header line',
  'summary-heading': 'From summary',
  'file-name': 'From file name',
  folder: 'From folder name'
}

export const DATE_ORIGIN: Record<ImportDateOrigin, string> = {
  export: 'From export',
  'front-matter': 'From properties',
  'date-line': 'From Date: line',
  'summary-date': 'From summary',
  'file-name': 'From file name',
  'file-time': 'From the file’s date'
}

/** Phase labels of a batch. */
export function phaseLabel(state: ImportBatchState, planned: number): string {
  switch (state) {
    case 'queued':
      return 'Waiting'
    case 'running':
      return planned === 0 ? 'Finishing' : 'Importing'
    case 'complete':
      return 'Done'
    case 'cancelled':
      return 'Cancelled'
    case 'failed':
      return 'Failed'
    case 'undone':
      return 'Undone'
  }
}

export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
}

export function shortDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** The last segment of a path, for history rows. */
export function folderName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

export function isMissingHandler(err: unknown): boolean {
  return /No handler registered/i.test(String(err))
}
