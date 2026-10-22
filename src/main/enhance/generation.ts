// SPDX-License-Identifier: Apache-2.0
// The generation lifecycle:
// - create a panel (or reset the target panel), mark it generating, push `panel_id`;
// - when the note is not being transcribed, wait for its final speaker
//   labels; a new panel is removed again if capture resumed during that wait;
// - build the prompt inputs, render the prompt, stream from the selected provider;
// - push `completion` deltas coalesced to about every 50 ms, `ai_line_map` as lines
//   complete, then on success store the trimmed text as both `content_markdown` and
//   `generated_content` and push `ai_line_map`, `ydoc` and `done`;
// - on failure store `enhance_failed_at` + the code and push `error` and `done`;
// - either way, once the outcome is stored, bus `enhance:completed`.
// The request times out after 185 s without a token. One generation per panel;
// generation is detached from any view and keeps going when the note is left.
//
// The panel's Yjs room is not seeded here: main has no editor schema, so the `ydoc`
// event carries `ydocState: null` and the renderer builds the room from the markdown.

import { app } from 'electron'
import { notulaError, type ErrorCode } from '@shared/errors'
import { positionLink } from '@shared/lib/position'
import { linkTimeCitations } from '@shared/lib/source-transcript'
import {
  DEFAULT_TEMPLATE_SLUG,
  type ActiveGeneration,
  type EnhanceErrorCode,
  type EnhanceEvent,
  type GenerateRequest,
  type RewriteRequest
} from '@shared/types/enhance'
import type { Note } from '@shared/types/notes'
import type { Panel } from '@shared/types/panels'
import type { MainContext } from '../context'
import { log } from '../log'
import { enhanceError, EnhanceError, toEnhanceError } from './errors'
import { buildPromptInputs, withTranscriptText } from './inputs'
import { generatedLines, noteLineIndex } from './lines'
import { panelState } from './panel-state'
import { summaryPrompt, summaryRewrite } from './prompts'
import { currentProvider } from '../llm/registry'
import {
  LlmImagesUnsupportedError,
  MAX_TOKENS,
  type LlmProvider,
  type LlmRequest,
  type LlmStopReason,
  type LlmUnavailableReason
} from '../llm/types'
import { egressBlocked, LOCAL_ONLY_REASON } from '../privacy'
import { imagesNote, snapshotBlock, summaryImages } from './summary-extras'
import { pushEnhanceEvent } from './push'
import { panelTitleFor, resolveTemplate, type Template } from './templates'
import { awaitFinalSpeakerLabels } from './speaker-wait'
import { noteTemplate } from '../templates'
import { transcriptionControl } from '../transcription'
import { sourcePromptInputs } from '../sources/plan'

/** No token for this long fails the panel with `timeout`. */
export const IDLE_TIMEOUT_MS = 185_000
const COALESCE_MS = 50
const REWRITE_PANEL_TITLE = 'Summary Rewrite'
const MAX_NOTES_CHARS = 1_000_000
const MAX_OVERRIDE_CHARS = 200_000
const MAX_INSTRUCTIONS_CHARS = 10_000

interface Active {
  noteId: string
  panelId: string
  text: string
  startedAt: string
  abort: AbortController
}

interface Job {
  note: Note
  panel: Panel
  templateSlug: string | null
  notesMarkdown?: string
  overrides?: Record<string, string>
  /** Set for a rewrite: the template's structure without its sections. */
  template?: Template
  auto: boolean
  /** A panel this job created (not a retry into an existing one). */
  isNew: boolean
  /** `ctx.enhance.autoGenerate`: replaces the transcript input (the demo's script). */
  transcriptText?: string
}

function str(v: unknown, name: string, max: number, required: true): string
function str(v: unknown, name: string, max: number, required?: false): string | undefined
function str(v: unknown, name: string, max: number, required = false): string | undefined {
  if (v === undefined || v === null) {
    if (required) throw notulaError('invalid-input', `${name} is required.`)
    return undefined
  }
  if (typeof v !== 'string' || (required && !v.trim()) || v.length > max) throw notulaError('invalid-input', `${name} is invalid.`)
  return v
}

function overrides(v: unknown): Record<string, string> | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'object' || Array.isArray(v)) throw notulaError('invalid-input', 'overrideVariables is invalid.')
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[a-z_][a-z0-9_]*$/.test(k) || typeof val !== 'string' || val.length > MAX_OVERRIDE_CHARS) {
      throw notulaError('invalid-input', `overrideVariables.${k} is invalid.`)
    }
    out[k] = val
  }
  return out
}

/** EnhanceErrorCode → the IPC ErrorCode a handler rejects with. */
export function ipcCode(code: EnhanceErrorCode): ErrorCode {
  switch (code) {
    case 'missing-key':
    case 'no-model':
      return code
    case 'note-not-found':
      return 'not-found'
    case 'unknown-template':
    case 'blank-template':
      return 'invalid-input'
    default:
      return 'provider-error'
  }
}

export function unavailableError(reason: LlmUnavailableReason, provider: LlmProvider): EnhanceError {
  if (reason === 'no-key') return enhanceError('missing-key', `No API key is set for ${provider.id === 'anthropic' ? 'Anthropic' : 'the AI provider'}.`)
  if (reason === 'no-model') return enhanceError('no-model', 'No AI model is set up.')
  return enhanceError('provider-error', 'The AI provider cannot be reached.')
}

/**
 * Runs one request with the idle timeout: every streamed event (text or activity)
 * restarts the 185 s clock; going quiet aborts with `timeout`.
 */
export async function streamText(
  provider: LlmProvider,
  req: LlmRequest,
  abort: AbortController,
  onText: (delta: string) => void
): Promise<{ text: string; stop: LlmStopReason }> {
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const kick = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timedOut = true
      abort.abort()
    }, IDLE_TIMEOUT_MS)
  }
  kick()
  let text = ''
  let stop: LlmStopReason = 'end'
  try {
    for await (const ev of provider.stream(req, abort.signal, kick)) {
      kick()
      if (ev.type === 'text') {
        text += ev.delta
        onText(ev.delta)
      } else {
        stop = ev.reason
      }
    }
  } catch (err) {
    if (timedOut) throw enhanceError('timeout', 'The AI provider stopped responding.')
    throw err
  } finally {
    if (timer) clearTimeout(timer)
  }
  return { text, stop }
}

/** A non-streaming call under the same 185 s limit. */
export async function completeText(provider: LlmProvider, req: LlmRequest): Promise<string> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), IDLE_TIMEOUT_MS)
  try {
    return await provider.complete(req, abort.signal)
  } catch (err) {
    if (abort.signal.aborted) throw enhanceError('timeout', 'The AI provider stopped responding.')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export class Generator {
  private readonly active = new Map<string, Active>()

  constructor(private readonly ctx: MainContext) {}

  getActive(noteId: string): ActiveGeneration[] {
    return [...this.active.values()]
      .filter((a) => a.noteId === noteId)
      .map((a) => ({ panelId: a.panelId, text: a.text, startedAt: a.startedAt }))
  }

  isGenerating(panelId: string): boolean {
    return this.active.has(panelId)
  }

  /**
   * `enhance:generate`: resolves at acceptance with the panel id. `internal` comes only
   * from main (`ctx.enhance.autoGenerate`), never from a renderer request.
   */
  async generate(raw: unknown, internal: { transcriptText?: string } = {}): Promise<{ panelId: string }> {
    const r = (raw ?? {}) as Partial<Record<keyof GenerateRequest, unknown>>
    const noteId = str(r.noteId, 'noteId', 200, true)
    const templateSlug = str(r.templateSlug, 'templateSlug', 200)
    const panelId = str(r.panelId, 'panelId', 200)
    const notesMarkdown = str(r.notesMarkdown, 'notesMarkdown', MAX_NOTES_CHARS)
    const auto = r.auto === true
    const vars = overrides(r.overrideVariables)

    const note = await this.ctx.storage.getNote(noteId)
    if (!note) throw notulaError('not-found', 'That note does not exist.')

    if (panelId) {
      const existing = await this.ctx.storage.getPanel(panelId)
      if (!existing || existing.document_id !== noteId || existing.deleted_at) throw notulaError('not-found', 'That panel does not exist.')
      return this.retry(note, existing, { notesMarkdown, overrides: vars, auto })
    }

    // The chosen template, else the note's temporary
    // template, else the default. A temporary template that no longer resolves (deleted
    // meanwhile) falls back to the default rather than failing the note.
    const pending = templateSlug?.trim() ? null : noteTemplate(noteId)
    let slug = templateSlug?.trim() || pending || DEFAULT_TEMPLATE_SLUG
    let template: Template
    try {
      template = (await resolveTemplate(this.ctx, slug)).template
    } catch (err) {
      const e = toEnhanceError(err)
      if (!pending) throw notulaError(ipcCode(e.code), e.message)
      log('warn', 'enhance:temporary-template-unusable', { noteId, templateId: pending, code: e.code })
      slug = DEFAULT_TEMPLATE_SLUG
      template = (await resolveTemplate(this.ctx, slug)).template
    }
    const panel = await this.createPanel(note, panelTitleFor(template), slug)
    this.start({
      note,
      panel,
      templateSlug: slug,
      notesMarkdown,
      overrides: vars,
      auto,
      isNew: true,
      ...(internal.transcriptText ? { transcriptText: internal.transcriptText } : {})
    })
    return { panelId: panel.id }
  }

  /**
   * `autoGenerate` without a usable LLM: `markdown`
   * becomes a completed summary panel, with the same events as a generation.
   */
  async fallbackPanel(note: Note, markdown: string): Promise<string> {
    const slug = DEFAULT_TEMPLATE_SLUG
    const { template } = await resolveTemplate(this.ctx, slug)
    const created = await this.createPanel(note, panelTitleFor(template), slug)
    const noteId = note.id
    const panelId = created.id
    this.ctx.bus.emit('enhance:started', { noteId, panelId, auto: true })
    this.emit({ noteId, panelId, type: 'panel_id' })
    const saved = await this.ctx.storage.updatePanel(panelId, {
      content_markdown: markdown,
      generated_content: markdown,
      ai_line_map: [],
      content_edited_at: new Date().toISOString(),
      enhance_failed_at: null,
      enhance_error: null
    })
    this.emit({ noteId, panelId, type: 'ai_line_map', lines: [] })
    this.emit({ noteId, panelId, type: 'ydoc', originalContent: markdown, ydocState: null, ydocVersion: saved.crdt_version })
    this.emit({ noteId, panelId, type: 'done', ok: true })
    this.ctx.bus.emit('enhance:completed', { noteId, panelId, ok: true, auto: true })
    return panelId
  }

  /** `enhance:rewrite`: a new "Summary Rewrite" panel. */
  async rewrite(raw: unknown): Promise<{ panelId: string }> {
    const r = (raw ?? {}) as Partial<Record<keyof RewriteRequest, unknown>>
    const noteId = str(r.noteId, 'noteId', 200, true)
    const panelId = str(r.panelId, 'panelId', 200, true)
    const instructions = str(r.instructions, 'instructions', MAX_INSTRUCTIONS_CHARS, true).trim()

    const note = await this.ctx.storage.getNote(noteId)
    if (!note) throw notulaError('not-found', 'That note does not exist.')
    const source = await this.ctx.storage.getPanel(panelId)
    if (!source || source.document_id !== noteId || source.deleted_at) throw notulaError('not-found', 'That panel does not exist.')
    const previous = (source.content_markdown ?? source.generated_content ?? '').trim()
    if (!source.template_key || !previous) {
      throw notulaError('invalid-input', 'A rewrite needs a generated summary to start from.')
    }
    let template: Template
    try {
      template = (await resolveTemplate(this.ctx, source.template_key)).template
    } catch (err) {
      const e = toEnhanceError(err)
      throw notulaError(ipcCode(e.code), e.message)
    }
    const panel = await this.createPanel(note, REWRITE_PANEL_TITLE, source.template_key)
    this.start({
      note,
      panel,
      templateSlug: source.template_key,
      template: { ...template, sections: [] },
      overrides: { edit_instructions: instructions, latest_summary: previous },
      auto: false,
      isNew: true
    })
    return { panelId: panel.id }
  }

  /** Retry or open-generate into an existing panel. */
  private async retry(
    note: Note,
    panel: Panel,
    opts: { notesMarkdown?: string; overrides?: Record<string, string>; auto: boolean }
  ): Promise<{ panelId: string }> {
    if (this.active.has(panel.id)) return { panelId: panel.id }
    const state = panelState(panel)
    if (state === 'completed' || state === 'generating') return { panelId: panel.id }
    try {
      await resolveTemplate(this.ctx, panel.template_key)
    } catch (err) {
      // A blank panel never generates; any other template problem fails the panel below.
      if (err instanceof EnhanceError && err.code === 'blank-template') return { panelId: panel.id }
    }
    const now = new Date().toISOString()
    const reset = await this.ctx.storage.updatePanel(panel.id, {
      enhance_started_at: now,
      enhance_failed_at: null,
      enhance_error: null,
      last_opened_at: now,
      content: null,
      content_markdown: null,
      generated_content: null,
      ai_line_map: null
    })
    this.start({ note, panel: reset, templateSlug: panel.template_key, ...opts, isNew: false })
    return { panelId: panel.id }
  }

  /** A fresh panel, marked generating and last viewed. */
  private createPanel(note: Note, title: string, templateSlug: string): Promise<Panel> {
    const now = new Date().toISOString()
    return this.ctx.storage.createPanel({
      document_id: note.id,
      title,
      template_key: templateSlug,
      content: null,
      content_markdown: null,
      generated_content: null,
      content_edited_at: null,
      deleted_at: null,
      last_opened_at: now,
      enhance_started_at: now,
      enhance_failed_at: null,
      enhance_error: null,
      ai_line_map: null,
      speakers_attributed: false,
      crdt_version: 1
    })
  }

  private emit(e: EnhanceEvent): void {
    pushEnhanceEvent(this.ctx.windows, e)
  }

  private start(job: Job): void {
    const active: Active = {
      noteId: job.note.id,
      panelId: job.panel.id,
      text: '',
      startedAt: job.panel.enhance_started_at ?? new Date().toISOString(),
      abort: new AbortController()
    }
    this.active.set(active.panelId, active)
    log('info', 'enhance:generation-started', {
      noteId: active.noteId,
      panelId: active.panelId,
      templateSlug: job.templateSlug,
      auto: job.auto,
      rewrite: !!job.overrides?.['edit_instructions']
    })
    this.emit({ noteId: active.noteId, panelId: active.panelId, type: 'panel_id' })
    // Speaker-name suggestions start alongside the summary.
    this.ctx.bus.emit('enhance:started', { noteId: active.noteId, panelId: active.panelId, auto: job.auto })
    // Decided when the generation starts.
    const outsideCapture = !this.isCapturing(active.noteId)
    void this.run(job, active, outsideCapture)
  }

  private isCapturing(noteId: string): boolean {
    return this.ctx.capture.isCapturing() && this.ctx.capture.currentNoteId() === noteId
  }

  /**
   * Capture resumed during the speaker-label wait, so this new panel is
   * removed again and nothing is generated (`auto-enhance-skipped-after-speakers`).
   */
  private async dropNewPanel(job: Job, active: Active): Promise<void> {
    const { noteId, panelId } = active
    this.active.delete(panelId)
    try {
      await this.ctx.storage.updatePanel(panelId, { deleted_at: new Date().toISOString() })
    } catch (err) {
      log('error', 'enhance:panel-remove-failed', { noteId, panelId, err })
    }
    this.emit({ noteId, panelId, type: 'done', ok: false })
    log('info', 'enhance:auto-skipped', { noteId, panelId, reason: 'auto-enhance-skipped-after-speakers', auto: job.auto })
  }

  private async run(job: Job, active: Active, outsideCapture: boolean): Promise<void> {
    const { noteId, panelId } = active
    let pending = ''
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    let lineCount = 0
    let noteIndex = new Map<string, string[]>()

    const flush = (): void => {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      if (!pending) return
      this.emit({ noteId, panelId, type: 'completion', delta: pending })
      pending = ''
      // Provenance for the complete lines so far, when a new line has completed.
      const complete = active.text.slice(0, active.text.lastIndexOf('\n') + 1)
      const lines = generatedLines(complete, noteIndex)
      if (lines.length !== lineCount) {
        lineCount = lines.length
        this.emit({ noteId, panelId, type: 'ai_line_map', lines })
      }
    }

    try {
      if (outsideCapture) {
        await awaitFinalSpeakerLabels(this.ctx, noteId)
        if (job.isNew && this.isCapturing(noteId)) return await this.dropNewPanel(job, active)
      }
      const resolved = job.template ? null : await resolveTemplate(this.ctx, job.templateSlug)
      const template = job.template ?? resolved?.template
      const rewriting = !!job.overrides?.['edit_instructions']?.trim()
      const prompt = rewriting ? summaryRewrite : summaryPrompt(resolved?.promptSlug ?? '')
      if (!prompt) throw enhanceError('unknown-template', 'Notula has no prompt for this template.')

      const [note, chunks, settings, session] = await Promise.all([
        this.ctx.storage.getNote(noteId),
        // Stored chunks merged with any still in memory (a rewrite during a meeting).
        job.transcriptText ? Promise.resolve([]) : transcriptionControl(this.ctx).getTranscript(noteId),
        this.ctx.settings.getAll(),
        this.ctx.storage.latestSession(noteId).catch(() => null)
      ])
      if (!note) throw enhanceError('note-not-found', 'The note was deleted.')
      // A source note: its source facts, and the transcript its prompts use (content sources).
      const sourced = await sourcePromptInputs(this.ctx, noteId, chunks)
      const { vars } = buildPromptInputs({
        note,
        chunks: sourced.chunks,
        source: sourced.source,
        settings,
        notesMarkdown: job.notesMarkdown,
        language: session?.language ?? settings['asr.language'],
        locale: app.getLocale(),
        template,
        overrides: job.overrides,
        live: !outsideCapture
      })
      if (job.transcriptText) withTranscriptText(vars, job.transcriptText, template)
      // The user-context "About me" text and the profile's job title; empty skips them.
      vars['author_context'] = (await this.ctx.promptExtras.summaryVars(noteId).catch(() => ({ author_context: '' }))).author_context
      vars['author_job_title'] = settings['profile.jobTitle'].trim()
      noteIndex = noteLineIndex(String(vars['notes'] ?? ''))
      const rendered = prompt.render(vars)
      const system = rendered.system
      let user = rendered.user

      // Local-only mode with a cloud provider makes no call.
      if (await egressBlocked(this.ctx, { kind: 'llm' })) {
        log('info', 'enhance:generation-blocked', { noteId, panelId, reason: LOCAL_ONLY_REASON })
        throw enhanceError('provider-error', 'Local-only mode is on: choose a local AI model in Settings to generate notes.')
      }
      const provider = await currentProvider(this.ctx.settings, this.ctx.secrets)
      const availability = await provider.available()
      if (!availability.ok) throw unavailableError(availability.reason, provider)

      const purpose = rewriting ? 'rewrite' : 'summary'
      // Extra summary inputs: the described screen snapshots and the note's images, inline,
      // for a model that takes them.
      const snapshots = snapshotBlock(note)
      if (snapshots) user = `${user}\n\n${snapshots}`
      const textOnly = user
      let images = purpose === 'summary' ? await summaryImages(this.ctx, note, provider) : []
      if (images.length) user = `${user}\n\n${imagesNote(images.length)}`
      const onDelta = (delta: string): void => {
        active.text += delta
        pending += delta
        flushTimer ??= setTimeout(flush, COALESCE_MS)
      }
      let result: { text: string; stop: LlmStopReason }
      try {
        result = await streamText(provider, { purpose, system, user, maxTokens: MAX_TOKENS[purpose], ...(images.length ? { images } : {}) }, active.abort, onDelta)
      } catch (err) {
        // Refused before any network call: generate again without the images.
        if (!(err instanceof LlmImagesUnsupportedError) || !images.length) throw err
        log('info', 'enhance:images-skipped', { noteId, panelId, count: images.length, reason: 'model-without-images' })
        images = []
        result = await streamText(provider, { purpose, system, user: textOnly, maxTokens: MAX_TOKENS[purpose] }, active.abort, onDelta)
      }
      const { text, stop } = result
      flush()

      // A refusal is checked before the content is used; a partial is discarded.
      if (stop === 'refusal') throw enhanceError('refusal', 'The AI model declined to write these notes.')
      const trimmed = text.trim()
      if (!trimmed) throw enhanceError('empty-response', 'The AI model returned no notes.')
      // A source note's `[mm:ss]` citations open the source at that time.
      const sourceUrl = sourced.source?.source.url
      const final = sourceUrl ? linkTimeCitations(trimmed, sourceUrl, positionLink) : trimmed
      if (stop === 'max_tokens') log('warn', 'enhance:output-truncated', { noteId, panelId, provider: provider.id })

      const lines = generatedLines(final, noteIndex)
      this.active.delete(panelId)
      const saved = await this.ctx.storage.updatePanel(panelId, {
        content_markdown: final,
        generated_content: final,
        ai_line_map: lines,
        content_edited_at: new Date().toISOString(),
        enhance_failed_at: null,
        enhance_error: null
      })
      this.emit({ noteId, panelId, type: 'ai_line_map', lines })
      this.emit({ noteId, panelId, type: 'ydoc', originalContent: final, ydocState: null, ydocVersion: saved.crdt_version })
      this.emit({ noteId, panelId, type: 'done', ok: true })
      this.ctx.bus.emit('enhance:completed', { noteId, panelId, ok: true, auto: job.auto })
      log('info', 'enhance:generation-completed', { noteId, panelId, provider: provider.id, model: provider.model, chars: final.length })
    } catch (err) {
      if (flushTimer) clearTimeout(flushTimer)
      this.active.delete(panelId)
      const e = toEnhanceError(err)
      try {
        await this.ctx.storage.updatePanel(panelId, { enhance_failed_at: new Date().toISOString(), enhance_error: e.code })
      } catch (storeErr) {
        log('error', 'enhance:fail-store-failed', { noteId, panelId, err: storeErr })
      }
      this.emit({ noteId, panelId, type: 'error', code: e.code, message: e.message })
      this.emit({ noteId, panelId, type: 'done', ok: false })
      this.ctx.bus.emit('enhance:completed', { noteId, panelId, ok: false, auto: job.auto })
      log('warn', 'enhance:generation-failed', { noteId, panelId, code: e.code, message: e.message })
    } finally {
      this.active.delete(panelId)
    }
  }
}
