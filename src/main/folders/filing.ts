// SPDX-License-Identifier: Apache-2.0
// Filing: the suggestion bar's answer
// (recurring match → AI → new folder), the auto-add rules after a calendar note's
// summary generates, and the opt-in AI folder suggestion through the user's own LLM
// provider (purpose `folder-suggest`). There are no attendee-domain rules.

import { FOLDER_LIMITS, type Folder, type FolderSuggestion, type FoldersState } from '@shared/types/folders'
import type { Note } from '@shared/types/notes'
import type { MainContext } from '../context'
import { currentProvider } from '../llm/registry'
import { MAX_TOKENS } from '../llm/types'
import { log } from '../log'
import { eventSummary, recurringEventId, type SeriesIndex } from './series'

const AI_TIMEOUT_MS = 60_000

/** The summary (else "Meeting Series") without a leading cadence word. */
export function newFolderTitle(summary: string | null): string {
  const base = summary?.trim() || 'Meeting series'
  let title = base.replace(/^(bi-weekly|weekly|daily|monthly)\b[\s:–—-]*/i, '').trim() || base
  if (/meeting/i.test(title) && title.length < 15 && !/\bseries$/i.test(title)) title += ' Series'
  return title
}

function inAnyFolder(state: FoldersState, noteId: string): boolean {
  return Object.values(state.membership).some((ids) => ids.includes(noteId))
}

/**
 * Each other calendar note in a folder scores 5 for the same series, else
 * 3 for the same summary; +1 when the folder is a favourite, +2 when the note is the
 * user's own. The highest-scoring folder wins; the first one on ties.
 */
async function recurringMatch(
  state: FoldersState,
  series: SeriesIndex,
  note: Note,
  seriesId: string
): Promise<Folder | null> {
  const index = await series.get()
  const summary = eventSummary(note.linked_event)
  let best: { folder: Folder; score: number } | null = null
  for (const folder of state.folders) {
    for (const candidateId of state.membership[folder.id] ?? []) {
      if (candidateId === note.id) continue
      // The index holds only the user's own, non-deleted calendar notes.
      const c = index.get(candidateId)
      if (!c) continue
      let score = c.recurringEventId === seriesId ? 5 : summary && c.summary === summary ? 3 : 0
      if (score === 0) continue
      if (folder.is_favourite) score += 1
      score += 2
      if (!best || score > best.score) best = { folder, score }
    }
  }
  return best?.folder ?? null
}

export class Filing {
  /** The AI's answer per note (main memory; the suggestion IPC reads it). */
  private readonly aiAnswers = new Map<string, string>()
  /** Once per note per run. */
  private readonly aiTried = new Set<string>()

  constructor(
    private readonly ctx: MainContext,
    private readonly series: SeriesIndex,
    private readonly pushChanged: (folderIds: string[]) => void
  ) {}

  /**
   * The folder suggestion: only the owner's note, only while it is in no folder, only
   * once a summary exists or is generating, and never for a dismissed series.
   */
  async suggest(noteId: string): Promise<FolderSuggestion | null> {
    const { storage, settings } = this.ctx
    const note = await storage.getNote(noteId)
    if (!note || note.is_shared) return null
    const state = await storage.listFolders()
    if (inAnyFolder(state, note.id)) return null
    if ((await storage.listPanels(note.id)).length === 0) return null
    const seriesId = recurringEventId(note.linked_event)
    if (seriesId && (await settings.get('folders.ignoredSeries')).includes(seriesId)) return null

    if (seriesId) {
      const match = await recurringMatch(state, this.series, note, seriesId)
      if (match) return { type: 'recurring_event', folderId: match.id, recurringEventId: seriesId }
    }
    const ai = this.aiAnswers.get(note.id)
    if (ai && state.folders.some((f) => f.id === ai) && (await settings.get('folders.aiSuggestions'))) {
      return { type: 'ai_match', folderId: ai }
    }
    if (seriesId && !state.rules.some((r) => r.recurring_event_id === seriesId)) {
      const index = await this.series.get()
      let owned = 0
      for (const n of index.values()) if (n.recurringEventId === seriesId) owned++
      if (owned >= FOLDER_LIMITS.newFolderMinNotes) {
        return { type: 'create_folder', title: newFolderTitle(eventSummary(note.linked_event)), recurringEventId: seriesId }
      }
    }
    return null
  }

  /** Bus `enhance:completed`: the auto-add rules, then (opt-in) the AI suggestion. */
  async onGenerated(e: { noteId: string; panelId: string; ok: boolean }): Promise<void> {
    if (!e.ok) return
    try {
      const added = await this.applyRules(e.noteId)
      if (added === 0) await this.suggestWithAi(e.noteId, e.panelId)
    } catch (err) {
      log('warn', 'folders:filing-failed', { noteId: e.noteId, err })
    }
  }

  /**
   * After a calendar note's summary generates successfully, every rule
   * for its series adds it (source `series_rule`), unless the event is skipped.
   */
  private async applyRules(noteId: string): Promise<number> {
    const note = await this.ctx.storage.getNote(noteId)
    const seriesId = recurringEventId(note?.linked_event)
    if (!note || !seriesId) return 0
    const { rules } = await this.ctx.storage.listFolders()
    let added = 0
    for (const rule of rules) {
      if (rule.recurring_event_id !== seriesId) continue
      const applies =
        rule.target.type === 'all'
          ? !note.event_id || !rule.target.excluded_event_ids.includes(note.event_id)
          : rule.target.event_id === note.event_id
      if (!applies) continue
      try {
        const n = await this.ctx.storage.addNotesToFolder(rule.folder_id, [note.id], 'series_rule')
        added += n
        if (n) log('info', 'folders:auto-added', { noteId: note.id, folderId: rule.folder_id })
      } catch (err) {
        log('warn', 'folders:auto-add-failed', { noteId: note.id, folderId: rule.folder_id, err })
      }
    }
    return added
  }

  /**
   * The AI folder suggestion: off by default; once per note; only for a note in no folder with
   * no recurring match; never without a configured provider. Sends the title, the first
   * 2,000 characters of the summary and the folder titles and descriptions; keeps only an
   * existing folder id.
   */
  private async suggestWithAi(noteId: string, panelId: string): Promise<void> {
    const { storage, settings, secrets } = this.ctx
    if (!(await settings.get('folders.aiSuggestions'))) return
    if (this.aiTried.has(noteId)) return
    const note = await storage.getNote(noteId)
    if (!note || note.is_shared) return
    const state = await storage.listFolders()
    if (state.folders.length === 0 || inAnyFolder(state, note.id)) return
    const seriesId = recurringEventId(note.linked_event)
    if (seriesId && (await recurringMatch(state, this.series, note, seriesId))) return
    const provider = await currentProvider(settings, secrets)
    const availability = await provider.available()
    if (!availability.ok) {
      log('info', 'folders:ai-suggestion-skipped', { noteId, reason: availability.reason })
      return
    }
    this.aiTried.add(noteId)
    const panel = await storage.getPanel(panelId)
    const summary = (panel?.content_markdown ?? '').slice(0, FOLDER_LIMITS.aiSummaryChars)
    const started = Date.now()
    let answer: string
    try {
      answer = await provider.complete(
        {
          purpose: 'folder-suggest',
          system: SYSTEM_PROMPT,
          user: userPrompt(note.title, summary, state.folders),
          maxTokens: MAX_TOKENS['folder-suggest']
        },
        AbortSignal.timeout(AI_TIMEOUT_MS)
      )
    } catch (err) {
      log('warn', 'folders:ai-suggestion-failed', { noteId, provider: provider.id, err })
      return
    }
    const folderId = parseAnswer(answer, state.folders)
    log('info', 'folders:ai-suggestion', { noteId, provider: provider.id, ms: Date.now() - started, matched: folderId !== null })
    if (!folderId) return
    this.aiAnswers.set(noteId, folderId)
    this.pushChanged([folderId])
  }
}

const SYSTEM_PROMPT = [
  'You file meeting notes into folders.',
  "Read the note's title and summary, then pick the one folder from the list where it clearly belongs.",
  'Reply with that folder\'s id exactly as listed, and nothing else.',
  'If no folder clearly fits, reply with the single word: other'
].join(' ')

function userPrompt(title: string | null, summary: string, folders: Folder[]): string {
  const list = folders
    .map((f) => {
      const lines = [`- id: ${f.id}`, `  title: ${f.title.trim() || 'Untitled folder'}`]
      if (f.description?.trim()) lines.push(`  description: ${f.description.trim().replace(/\s+/g, ' ')}`)
      return lines.join('\n')
    })
    .join('\n')
  return [
    `<note_title>${title?.trim() || 'Untitled'}</note_title>`,
    `<note_summary>\n${summary.trim() || '(no summary)'}\n</note_summary>`,
    `<folders>\n${list}\n</folders>`,
    'Which folder id fits this note? Reply with the id only, or other.'
  ].join('\n\n')
}

/** An existing folder id, or null for `other` and anything else. */
export function parseAnswer(answer: string, folders: Folder[]): string | null {
  const ids = new Set(folders.map((f) => f.id))
  const cleaned = answer.trim().replace(/^[\s"'`*]+|[\s"'`*.]+$/g, '')
  if (ids.has(cleaned)) return cleaned
  if (ids.has(cleaned.toLowerCase())) return cleaned.toLowerCase()
  // Tolerate a short wrapper ("Folder: <id>") as long as exactly one listed id appears.
  const found = new Set((answer.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []).map((m) => m.toLowerCase()))
  const listed = [...found].filter((m) => ids.has(m))
  return listed.length === 1 && found.size === 1 ? (listed[0] as string) : null
}
