// SPDX-License-Identifier: Apache-2.0
// The AI meeting title. The renderer's TitleField asks once
// per mount when eligible; main gates, calls the `note-title` prompt
// without streaming, validates and clamps the reply, re-reads the note and saves only
// if the title is still empty. Errors are logged, never retried, never shown.

import { app } from 'electron'
import type { TitleResult } from '@shared/types/enhance'
import type { MainContext } from '../context'
import { log } from '../log'
import { toEnhanceError } from './errors'
import { egressBlocked, LOCAL_ONLY_REASON } from '../privacy'
import { completeText, unavailableError } from './generation'
import { buildPromptInputs } from './inputs'
import { meetingTitle } from './prompts'
import { currentProvider } from '../llm/registry'
import { MAX_TOKENS } from '../llm/types'

/** Strictly more than this many characters of speaker-labelled transcript. */
const MIN_TRANSCRIPT_CHARS = 200
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

  const [chunks, settings, session] = await Promise.all([
    ctx.storage.getTranscript(noteId),
    ctx.settings.getAll(),
    ctx.storage.latestSession(noteId).catch(() => null)
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
  log('info', 'title-autofill-saved', { noteId, provider: provider.id, model: provider.model })
  return { status: 'saved', title }
}
