// SPDX-License-Identifier: Apache-2.0
// The AI meeting title. The renderer's TitleField asks once
// per mount when eligible, and main asks again once a summary generation ends; main
// gates, calls the `note-title` prompt without streaming, validates and clamps the reply,
// re-reads the note and saves only if the title is still empty. Errors are logged, never
// retried, never shown.
//
// The title reads the note's newest summary, not the transcript. While a summary may
// still come (one is generating, or automatic notes may still start after the stop) the
// request is skipped as `no-summary`. When none is coming, the start of the transcript
// stands in for it.

import { app } from 'electron'
import { SUGGESTED_ACTIONS_SLUG, type TitleResult } from '@shared/types/enhance'
import type { Panel } from '@shared/types/panels'
import type { MainContext } from '../context'
import { log } from '../log'
import { toEnhanceError } from './errors'
import { egressBlocked, LOCAL_ONLY_REASON } from '../privacy'
import { completeText, unavailableError } from './generation'
import { buildPromptInputs } from './inputs'
import { latestSummary, panelMarkdown } from './note-context'
import { meetingTitle } from './prompts'
import { currentProvider } from '../llm/registry'
import { MAX_TOKENS } from '../llm/types'

/** Strictly more than this many characters of speaker-labelled transcript. */
const MIN_TRANSCRIPT_CHARS = 200
/** The summary the title reads, start kept. */
const MAX_SUMMARY_CHARS = 8_000
/** Without a summary coming, the start of the transcript instead. */
const MAX_FALLBACK_TRANSCRIPT_CHARS = 6_000
/** Automatic notes never run on less transcript than this (auto.ts's minimum). */
const AUTO_SUMMARY_MIN_CHARS = 2_500
/** After a stop, how long automatic notes may take to start before the transcript stands in. */
const SUMMARY_START_WAIT_MS = 120_000
const MAX_TITLE_CODE_POINTS = 100
const WORD_CUT_AFTER = 50
const TRAILING = /[ ,;:\-–—]+$/u

/** Counted in code points; a word cut only past position 50. */
export function clampTitle(title: string): { title: string; clamped: boolean } {
  const points = Array.from(title)
  if (points.length <= MAX_TITLE_CODE_POINTS) return { title, clamped: false }
  const head = points.slice(0, MAX_TITLE_CODE_POINTS)
  const plain = head.join('')
  const lastSpace = head.lastIndexOf(' ')
  const cut = (lastSpace > WORD_CUT_AFTER ? head.slice(0, lastSpace).join('') : plain).replace(TRAILING, '')
  return { title: cut || plain, clamped: true }
}

const inFlight = new Set<string>()
/** One timer per note: the check once automatic notes would have started. */
const rechecks = new Map<string, ReturnType<typeof setTimeout>>()

function recheckAt(ctx: MainContext, noteId: string, at: number): void {
  if (rechecks.has(noteId)) return
  const timer = setTimeout(
    () => {
      rechecks.delete(noteId)
      void generateTitle(ctx, noteId)
    },
    Math.max(1_000, at - Date.now() + 1_000)
  )
  timer.unref?.()
  rechecks.set(noteId, timer)
}

/** At most `max` characters from the start, ended at a line break when one is near. */
function headOf(text: string, max: number, marker: string): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const nl = cut.lastIndexOf('\n')
  return `${nl > max / 2 ? cut.slice(0, nl) : cut}\n${marker}`
}

export async function generateTitle(ctx: MainContext, noteId: string): Promise<TitleResult> {
  if (inFlight.has(noteId)) return { status: 'skipped', reason: 'in-progress' }
  inFlight.add(noteId)
  try {
    return await run(ctx, noteId)
  } catch (err) {
    const e = toEnhanceError(err)
    log('warn', 'title-autofill-failed', { noteId, code: e.code, message: e.message })
    return { status: 'error', reason: e.code }
  } finally {
    inFlight.delete(noteId)
  }
}

function skip(noteId: string, reason: string): TitleResult {
  log('info', 'title-autofill-skipped', { noteId, reason })
  return { status: 'skipped', reason }
}

async function run(ctx: MainContext, noteId: string): Promise<TitleResult> {
  const note = await ctx.storage.getNote(noteId)
  if (!note) return { status: 'error', reason: 'note-not-found' }
  if (note.is_shared) return skip(noteId, 'not-owner')
  if (note.title?.trim()) return skip(noteId, 'already-titled')
  if (ctx.capture.currentNoteId() === noteId) return skip(noteId, 'transcribing')
  // A source note is titled from its source, never by the model.
  if (await ctx.storage.getNoteSource(noteId).catch(() => null)) return skip(noteId, 'source-note')

  const [chunks, settings, session, panels] = await Promise.all([
    ctx.storage.getTranscript(noteId),
    ctx.settings.getAll(),
    ctx.storage.latestSession(noteId).catch(() => null),
    ctx.storage.listPanels(noteId)
  ])
  // No editor markdown: `notes` comes from the stored note.
  const { vars, transcript } = buildPromptInputs({
    note,
    chunks,
    settings,
    language: session?.language ?? settings['asr.language'],
    locale: app.getLocale()
  })
  if (transcript.text.length <= MIN_TRANSCRIPT_CHARS) return skip(noteId, 'transcript-too-short')

  // Local-only mode with a cloud provider makes no call; the note keeps its title.
  if (await egressBlocked(ctx, { kind: 'llm' })) {
    log('info', 'title-autofill-skipped', { noteId, reason: LOCAL_ONLY_REASON })
    return { status: 'skipped', reason: 'no-model' }
  }
  const provider = await currentProvider(ctx.settings, ctx.secrets)
  const availability = await provider.available()
  if (!availability.ok) {
    // A missing model means no title and no error UI: a title is a nicety, not a failure.
    log('info', 'title-autofill-skipped', { noteId, reason: 'no-model', detail: unavailableError(availability.reason, provider).code })
    return { status: 'skipped', reason: 'no-model' }
  }

  const summary = panelMarkdown(latestSummary(panels))
  const from: 'summary' | 'transcript' = summary ? 'summary' : 'transcript'
  if (summary) {
    vars['latest_summary'] = headOf(summary, MAX_SUMMARY_CHARS, '[… the rest of the summary was cut]')
    vars['transcript'] = ''
  } else {
    const waitUntil = summaryExpectedUntil(panels, session?.ended_at ?? null, transcript.text.length)
    if (waitUntil !== null) {
      // A finished generation asks again (index.ts); a summary that never starts, the timer.
      if (Number.isFinite(waitUntil)) recheckAt(ctx, noteId, waitUntil)
      return skip(noteId, 'no-summary')
    }
    vars['latest_summary'] = ''
    vars['transcript'] = headOf(transcript.text, MAX_FALLBACK_TRANSCRIPT_CHARS, '[… the rest of the transcript was cut]')
  }

  const { system, user } = meetingTitle.render(vars)
  const reply = (await completeText(provider, { purpose: 'title', system, user, maxTokens: MAX_TOKENS.title })).trim()
  if (!reply) {
    log('info', 'title-autofill-empty', { noteId })
    return { status: 'rejected', reason: 'empty-result' }
  }
  if (/[\r\n]/.test(reply)) {
    log('info', 'title-autofill-refused', { noteId, reason: 'contains-newline' })
    return { status: 'rejected', reason: 'contains-newline' }
  }
  const { title, clamped } = clampTitle(reply)
  if (clamped) log('info', 'title-autofill-trimmed', { noteId, from: Array.from(reply).length, to: Array.from(title).length })

  // The user may have typed a title meanwhile: theirs wins.
  const fresh = await ctx.storage.getNote(noteId)
  if (!fresh) return { status: 'error', reason: 'note-not-found' }
  if (fresh.title?.trim()) return skip(noteId, 'already-titled')
  await ctx.storage.updateNote(noteId, { title })
  log('info', 'title-autofill-saved', { noteId, provider: provider.id, model: provider.model, from })
  return { status: 'saved', title }
}

/**
 * While a summary may still come: Infinity when one is generating (its end asks again), the
 * time automatic notes would have started by after a recent stop, or null when none is
 * coming (a generation that ended without one, too little transcript, or a stop long ago).
 */
function summaryExpectedUntil(panels: Panel[], endedAt: string | null, transcriptChars: number): number | null {
  const summaries = panels.filter((p) => !p.deleted_at && p.template_key !== SUGGESTED_ACTIONS_SLUG)
  const generating = summaries.some(
    (p) => p.enhance_started_at && !(p.enhance_failed_at && p.enhance_failed_at >= p.enhance_started_at) && !panelMarkdown(p)
  )
  if (generating) return Infinity
  if (summaries.length > 0 || transcriptChars < AUTO_SUMMARY_MIN_CHARS || !endedAt) return null
  const until = Date.parse(endedAt) + SUMMARY_START_WAIT_MS
  return Number.isFinite(until) && until > Date.now() ? until : null
}
