// SPDX-License-Identifier: Apache-2.0
// The scope picker of a course note's Generate notes (`sources:lesson-notes-scope`): *Watched part*
// or *Whole video*, the footer's facts and the budget cut.
//
// - The automatic pick is the watched-scope rule (enhance/transcript.ts): the whole video when
//   watched ≥ 85 % or there are no spans, else the watched part ± 60 s.
// - A pick is kept per note in memory, until Notula restarts; the prompt inputs (plan.ts) read it,
//   so Generate notes and lesson notes use the scope the picker shows.
// - `ranges` are the watched spans' positions, merged and without the margin: the transcript
//   panel dims the lines outside them.
// Logs: states only.

import { ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeRes } from '@shared/ipc'
import type { MainContext } from '../context'
import { SCOPE_WHOLE_PERCENT, watchedMsOf } from '../enhance/transcript'
import { expected } from '../ipc-expected'
import { lessonNotesPreflight } from './lesson-notes'

export type ScopeChoice = 'watched' | 'whole'

/** Note id → the user's pick. Memory only. */
const choices = new Map<string, ScopeChoice>()
const MAX_CHOICES = 500

/** The note's pick in the scope picker, or null for the automatic one. */
export function scopeChoice(noteId: string): ScopeChoice | null {
  return choices.get(noteId) ?? null
}

function setChoice(noteId: string, choice: ScopeChoice): void {
  choices.delete(noteId)
  choices.set(noteId, choice)
  // The oldest picks go first; a note picked this long ago falls back to the automatic pick.
  while (choices.size > MAX_CHOICES) choices.delete(choices.keys().next().value as string)
}

/** The spans' positions merged, with no margin. */
function mergedRanges(spans: readonly { pos_start_ms: number; pos_end_ms: number }[]): [number, number][] {
  const sorted = spans
    .map((s) => [Math.min(s.pos_start_ms, s.pos_end_ms), Math.max(s.pos_start_ms, s.pos_end_ms)] as [number, number])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
    .sort((x, y) => x[0] - y[0])
  const out: [number, number][] = []
  for (const [a, b] of sorted) {
    const last = out[out.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

function parse(req: unknown): { noteId: string; choice: ScopeChoice | null } {
  const r = req as { noteId?: unknown; choice?: unknown } | null
  if (typeof r?.noteId !== 'string' || !r.noteId || r.noteId.length > 200) throw expected(notulaError('invalid-input', 'noteId is required.'))
  if (r.choice !== undefined && r.choice !== 'watched' && r.choice !== 'whole') throw expected(notulaError('invalid-input', 'choice must be watched or whole.'))
  return { noteId: r.noteId, choice: (r.choice as ScopeChoice | undefined) ?? null }
}

export function registerLessonScope(ctx: MainContext): void {
  ipcMain.handle('sources:lesson-notes-scope' satisfies InvokeChannel, async (_e, req: unknown): Promise<InvokeRes<'sources:lesson-notes-scope'>> => {
    const { noteId, choice } = parse(req)
    const source = await ctx.storage.getNoteSource(noteId)
    const series = source?.series_id ? await ctx.storage.getSeries(source.series_id).catch(() => null) : null
    // Course notes only: the prompts of other notes don't use a scope.
    if (!source || !series?.registered_at) return null
    const spans = await ctx.storage.listSourceSpans(noteId)
    const watchedMs = watchedMsOf(spans)
    const total = !source.live && source.duration_ms !== null && source.duration_ms > 0 ? source.duration_ms : null
    const percent = total ? (watchedMs / total) * 100 : null
    const defaultChoice: ScopeChoice = spans.length === 0 || (percent !== null && percent >= SCOPE_WHOLE_PERCENT) ? 'whole' : 'watched'
    if (choice) {
      if (choice === defaultChoice) choices.delete(noteId)
      else setChoice(noteId, choice)
    }
    const pre = await lessonNotesPreflight(ctx, noteId)
    if (!pre) return null
    return {
      startMs: pre.scope.startMs,
      endMs: pre.scope.endMs,
      totalMs: pre.scope.totalMs,
      noteCount: pre.scope.noteCount,
      cutAtMs: pre.cut?.cutAtMs ?? null,
      choice: scopeChoice(noteId) ?? defaultChoice,
      defaultChoice,
      watchedMs,
      ranges: mergedRanges(spans),
      lastMs: spans.reduce<{ wall: number; ms: number | null }>((best, s) => (s.wall_end > best.wall ? { wall: s.wall_end, ms: s.pos_end_ms } : best), { wall: -Infinity, ms: null }).ms
    }
  })
}
