// SPDX-License-Identifier: Apache-2.0
// `ctx.enhance.noteChatInputs`: everything a note chat needs
// from the summary prompt builder, so chat and summaries describe a meeting the same
// way. The prompt variables (as text), plus `selection_text` when given; the speaker
// turns; and the latest summary, whose markdown also fills `latest_summary`
// (else the chat's target markdown; "No summary" when both are empty).

import { app } from 'electron'
import { notulaError } from '@shared/errors'
import { SUGGESTED_ACTIONS_SLUG } from '@shared/types/enhance'
import type { Panel } from '@shared/types/panels'
import type { MainContext, NoteChatInputs } from '../context'
import { sourcePromptInputs } from '../sources/plan'
import { transcriptionControl } from '../transcription'
import { buildPromptInputs } from './inputs'

const NO_SUMMARY = 'No summary'

/** The most recently viewed live summary panel. */
export function latestSummaryPanel(panels: Panel[]): Panel | null {
  const recency = (p: Panel): string => p.last_opened_at ?? p.created_at
  const live = panels.filter((p) => !p.deleted_at && p.template_key !== SUGGESTED_ACTIONS_SLUG)
  live.sort((a, b) => recency(b).localeCompare(recency(a)) || b.created_at.localeCompare(a.created_at))
  return live[0] ?? null
}

export async function noteChatInputs(
  ctx: MainContext,
  noteId: string,
  opts: { targetMarkdown?: string; selectionMarkdown?: string | null }
): Promise<NoteChatInputs> {
  const note = await ctx.storage.getNote(noteId)
  if (!note) throw notulaError('not-found', 'That note does not exist.')
  const live = ctx.capture.isCapturing() && ctx.capture.currentNoteId() === noteId
  const [chunks, settings, session, panels] = await Promise.all([
    transcriptionControl(ctx).getTranscript(noteId),
    ctx.settings.getAll(),
    ctx.storage.latestSession(noteId).catch(() => null),
    ctx.storage.listPanels(noteId)
  ])
  const latest = latestSummaryPanel(panels)
  const latestMarkdown = (latest?.content_markdown ?? latest?.generated_content ?? '').trimEnd()
  const summary = latestMarkdown.trim() ? latestMarkdown : (opts.targetMarkdown ?? '').trim()
  // A source note's chat reads the same transcript as its summary (content sources).
  const sourced = await sourcePromptInputs(ctx, noteId, chunks)
  const { vars, transcript } = buildPromptInputs({
    note,
    chunks: sourced.chunks,
    source: sourced.source,
    settings,
    language: session?.language ?? settings['asr.language'],
    locale: app.getLocale(),
    live,
    overrides: { latest_summary: summary || NO_SUMMARY }
  })
  const text: Record<string, string> = {}
  for (const [k, v] of Object.entries(vars)) text[k] = String(v)
  const selection = opts.selectionMarkdown?.trim()
  if (selection) text['selection_text'] = selection
  return {
    note,
    vars: text,
    turns: transcript.turns,
    latestSummaryMarkdown: latestMarkdown,
    latestSummaryPanelId: latest?.id ?? null,
    latestSummaryTemplateSlug: latest?.template_key ?? null
  }
}
