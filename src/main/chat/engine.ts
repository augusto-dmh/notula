// SPDX-License-Identifier: Apache-2.0
// The chat engine:
// the send order, context assembly, the streamed tool loop against the user's own
// provider, citations, Stop, failures, approvals and thread titles. Everything runs
// in main; the renderer sees only `chat:event` and `chat:changed`.
//
// One answer at a time per thread. Inside an answer the model transcript is
// append-only (the provider's replay of each round, then all of that round's tool
// results); earlier answers are rebuilt as plain text (history.ts).
//
// One answer's tools come from the registry (local tools
// by availability rule, then the providers', fixed for every round). A ✱ write or an
// `askUser` ends the round as the one pending approval of the answer; read calls of
// that round still run, and any other ✱ call is answered "Waiting for approval of an
// earlier change.". The user's decision continues the same assistant message.

import { randomUUID } from 'node:crypto'
import { parseError } from '@shared/errors'
import {
  CHAT_LIMITS,
  QUESTIONS_SKIPPED_REASON,
  type AttachmentRef,
  type ChatContext,
  type ChatContextSources,
  type ChatErrorCode,
  type ChatEvent,
  type ChatMessage,
  type ChatOutput,
  type ChatPlace,
  type ChatSendAccepted,
  type ChatSendRequest,
  type ChatThread,
  type ChatToolCall,
  type ChatViewContext,
  type DirectoryContext,
  type DocRef,
  type PrepBriefRef,
  type ToolCallUpdate
} from '@shared/types/chat'
import type { LlmProviderId } from '@shared/types/enhance'
import type { RecipeAdditionalContext } from '@shared/types/recipes'
import type { Settings } from '@shared/types/settings'
import type { MainContext } from '../context'
import { EnhanceError } from '../enhance/errors'
import { resolveChatModel } from '../llm/models'
import { buildProvider } from '../llm/registry'
import { LlmToolsUnsupportedError, MAX_TOKENS, type LlmChatMessage, type LlmProvider, type LlmToolDef } from '../llm/types'
import { log } from '../log'
import { allRecipes, findRecipe, recipeUserTurn, recipeViewFor, recordRecipeUse, resolveRecipeSend } from '../recipes'
import type { ChatMessageUpsert } from '../storage/api'
import { adoptAttachments, attachmentInputs, attachmentRefs } from './attachments'
import { CitationIndex, citeText, stripCitationKeys } from './citations'
import { assemble, contextToStore, type ContextLimit } from './context'
import { expandMentions, messageMentions } from './history'
import { directoryContext, folders, libraryViewContext } from './library'
import { cleanTitle, momentNow, systemPrompt, TITLE_SYSTEM, titleUser } from './prompt'
import { pushChatChanged, pushChatEvent } from './push'
import { bad, parseSendRequest, parseToolCallUpdate } from './request'
import { charsOf } from './text'
import { toolAvailability, ToolRegistry, type ToolEntry } from './registry'
import { fail, validateLocal, type ApprovalPreview, type NoteTarget, type ToolEnv, type ToolOutcome } from './tools'
import { answersProblem, ASK_USER_QUESTION, cleanQuestions } from './tools-questions'

type FinishReason = 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'cancelled'

/** The stored `sources` of an answer: the context sources plus Notula's own facts. */
export type StoredSources = ChatContextSources & {
  contextLimit?: ContextLimit
  meta?: { model: string; noTools: boolean; finishReason: FinishReason }
}

const REFUSAL_MESSAGE = 'The AI provider declined to answer this. Try rephrasing your question.'
const FAILED_MESSAGE = 'Couldn’t get a response. Try again.'
const STOPPED_MARK = '[Response stopped]'
/** A provider that sends nothing (not even thinking) for this long has stalled. */
const IDLE_TIMEOUT_MS = 60_000
/** `update:delay` on every 5th streamed chunk. */
const DELAY_EVERY = 5
/** Streamed tool arguments reach the renderer at most this often per call. */
const ARGS_EMIT_MS = 80
const TITLE_TIMEOUT_MS = 30_000
const ABORT_WAIT_MS = 5_000
const NO_TOOLS_MAX = 50
const DENIED_BY_NEW_MESSAGE = 'The user sent a new message instead.'
/** The answer to a second ✱ call while another one waits for approval. */
const WAITING_EARLIER = 'Waiting for approval of an earlier change.'
/** The renderer sends it; the default when a decision comes without one. */
const DECLINED_REASON = 'The user declined this change.'
/** Recipes listed in the system prompt for loadRecipe. */
const SKILLS_LISTED = 50
/** A brief counts as meaningful with a headline and the high-signal mark. */
type BriefFacts = { ref: PrepBriefRef; content: string }

class ChatFailure extends Error {
  constructor(
    readonly code: ChatErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ChatFailure'
  }
}

interface Answer {
  requestId: string
  threadId: string
  assistantMessageId: string
  turnIndex: number
  preview: boolean
  controller: AbortController
  outputs: ChatOutput[]
  sources: StoredSources
  model: string
  noTools: boolean
  chunks: number
  done: Promise<void>
}

/** Everything one answer is built from, fixed at send time. */
interface Plan {
  place: ChatPlace
  view: ChatViewContext
  directory: DirectoryContext | null
  kind: 'single' | 'multi'
  recipeModel: string | null
  recipeContexts: RecipeAdditionalContext[]
  question: string
  userContent: string
  earlier: ChatMessage[]
  mentions: DocRef[]
  selectedDocuments: DocRef[]
  includeTranscripts: boolean
  target: ChatSendRequest['target']
  selection: string | null
  editWithAi: boolean
  live: boolean
  detailed: boolean
  /** The message's chat files. */
  attachments: AttachmentRef[]
  /** The meeting's meaningful brief while `prepBrief.inChat` is on. */
  brief: BriefFacts | null
  /** The meeting dock offers only tools marked `readOnly`, and never approvals. */
  readOnlyTools?: boolean
}

/** The state of an answer's tool loop. */
interface Loop {
  provider: LlmProvider
  providerId: LlmProviderId
  system: string
  tools: LlmToolDef[]
  /** Who runs each offered name (local or a provider). */
  entries: Map<string, ToolEntry>
  transcript: LlmChatMessage[]
  maxTokens: number
  env: ToolEnv
  index: CitationIndex
  toolRounds: number
}

interface RoundCall {
  id: string
  name: string
  args: Record<string, unknown> | null
}

function platform(): ChatThread['creation_platform'] {
  return process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'web'
}

function contextTokensKey(p: LlmProviderId): 'chat.contextTokens.anthropic' | 'chat.contextTokens.openai' | 'chat.contextTokens.local' {
  return p === 'anthropic' ? 'chat.contextTokens.anthropic' : p === 'openai' ? 'chat.contextTokens.openai' : 'chat.contextTokens.local'
}

/** The settings with the chat's resolved model in place of the provider's settings model. */
function withModel(s: Settings, provider: LlmProviderId, model: string): Settings {
  if (provider === 'anthropic') return { ...s, 'llm.anthropic.model': model }
  if (provider === 'openai') return { ...s, 'llm.openai.model': model }
  return { ...s, 'llm.local.model': model }
}

/** The output cap: 16,000 tokens, or a quarter of a small local window. */
function outputCap(window: number): number {
  return Math.min(MAX_TOKENS.chat, Math.max(1_024, Math.floor(window / 4)))
}

function newToolCall(id: string, name: string, entry: ToolEntry | undefined): ChatToolCall {
  const meta = entry?.spec.meta
  return {
    id,
    name,
    args: {},
    argsDelta: '',
    renderInline: entry?.local?.renderInline === true,
    shownInChat: true,
    providerExecuted: false,
    completed: false,
    startedAtMs: Date.now(),
    completedAtMs: null,
    reverted: false,
    error: null,
    result: null,
    confirmationRequired: false,
    category: entry?.spec.category ?? 'generic',
    ...(meta ? { mcpLinkId: meta.mcpLinkId, mcpEndpoint: meta.mcpEndpoint, ...(meta.mcpToolLabel ? { mcpToolLabel: meta.mcpToolLabel } : {}) } : {})
  }
}

function toFailure(err: unknown): ChatFailure {
  if (err instanceof ChatFailure) return err
  if (err instanceof EnhanceError) {
    const code: ChatErrorCode =
      err.code === 'missing-key' || err.code === 'no-model' || err.code === 'timeout' || err.code === 'refusal' || err.code === 'empty-response'
        ? err.code
        : 'provider-error'
    return new ChatFailure(code, code === 'refusal' ? REFUSAL_MESSAGE : err.message || FAILED_MESSAGE)
  }
  if (err instanceof Error && err.name === 'AbortError') return new ChatFailure('timeout', 'The AI provider stopped responding.')
  const p = parseError(err)
  if (p.code === 'missing-key' || p.code === 'no-model' || p.code === 'provider-error') return new ChatFailure(p.code, p.message || FAILED_MESSAGE)
  return new ChatFailure('provider-error', FAILED_MESSAGE)
}

/** The message as `upsertChatMessage` takes it, with `patch` applied. */
function toUpsert(m: ChatMessage, patch: Partial<ChatMessageUpsert> = {}): ChatMessageUpsert {
  return {
    id: m.id,
    thread_id: m.thread_id,
    role: m.role,
    turn_index: m.turn_index,
    attachments: m.attachments,
    raw_text: m.raw_text,
    context: m.context,
    sources: m.sources,
    outputs: m.outputs,
    status: m.status,
    custom_type: m.custom_type,
    trace_id: m.trace_id,
    ...patch
  }
}

/** Patches one tool call of an output list; null when the call is not there. */
function patchCall(outputs: ChatOutput[], toolCallId: string, f: (c: ChatToolCall) => ChatToolCall): { outputs: ChatOutput[]; index: number } | null {
  const index = outputs.findIndex((o) => o.type === 'tool_call' && o.tool_call.id === toolCallId)
  if (index === -1) return null
  const next = [...outputs]
  const o = next[index] as Extract<ChatOutput, { type: 'tool_call' }>
  next[index] = { type: 'tool_call', tool_call: f(o.tool_call) }
  return { outputs: next, index }
}

/**
 * Final outputs: each text output becomes `cited_text` (line indexes run on
 * across the message), and streamed argument text is dropped.
 */
function finalizeOutputs(outputs: ChatOutput[], index: CitationIndex, messageId: string): { outputs: ChatOutput[]; cited: string[]; text: string } {
  const cited = new Set<string>()
  const texts: string[] = []
  let lines = 0
  const out = outputs.map((o): ChatOutput => {
    if (o.type === 'text') {
      const r = citeText(o.text, index, messageId, lines)
      lines += r.lines
      for (const id of r.citedNoteIds) cited.add(id)
      if (r.output.type === 'cited_text') texts.push(r.output.plain_text)
      return r.output
    }
    if (o.type === 'cited_text') texts.push(o.plain_text)
    if (o.type === 'tool_call') {
      const { argsDelta: _drop, ...call } = o.tool_call
      return { type: 'tool_call', tool_call: call }
    }
    return o
  })
  return { outputs: out, cited: [...cited], text: texts.join('\n\n').trim() }
}

export class ChatEngine {
  /** threadId → its streaming answer (a preview's thread id is its request id). */
  private readonly active = new Map<string, Answer>()
  /** assistantMessageId → a loop paused on a pending approval. */
  private readonly paused = new Map<string, { loop: Loop; plan: Plan; pending: string[] }>()
  /** A rewrite panel → the tool call that started it. */
  private readonly rewrites = new Map<string, { threadId: string; messageId: string; toolCallId: string }>()
  /** threadId → its grouping key, for a decision that outlived its paused answer. */
  private readonly threadKeys = new Map<string, string>()

  constructor(
    private readonly ctx: MainContext,
    private readonly registry: ToolRegistry
  ) {}

  isStreaming(): boolean {
    return this.active.size > 0
  }

  // ---------- send and stop ----------

  async send(raw: unknown): Promise<ChatSendAccepted> {
    const req = parseSendRequest(raw)
    if (req.preview) return this.sendPreview(req)
    const thread = await this.ensureThread(req)
    if (req.approval) return this.sendApproval(req, thread)

    // One stream per thread.
    await this.abortThread(thread.id)
    let earlier = await this.ctx.storage.listChatMessages(thread.id)

    // Step 5: an edited (or resent) message cuts the history after it and keeps its id.
    let userMessageId: string = randomUUID()
    let turnIndex: number
    let keptAttachments: AttachmentRef[] = []
    if (req.edit) {
      const at = earlier.findIndex((m) => m.id === req.edit?.messageId && m.role === 'user')
      if (at === -1) throw bad('That message no longer exists.')
      const edited = earlier[at] as ChatMessage
      await this.ctx.storage.truncateChatMessagesAfter(thread.id, edited.id)
      userMessageId = edited.id
      turnIndex = edited.turn_index
      keptAttachments = attachmentRefs(edited.attachments)
      earlier = earlier.slice(0, at)
    } else {
      turnIndex = earlier.reduce((n, m) => (m.role === 'user' ? Math.max(n, m.turn_index + 1) : n), 0)
    }

    // Step 6: a new message declines every approval still pending.
    await this.autoDeny(earlier)

    // Files added before this send join the thread.
    let attachments = keptAttachments
    if (req.attachmentIds?.length) {
      try {
        attachments = await adoptAttachments(this.ctx, thread.id, req.attachmentIds)
      } catch (err) {
        log('warn', 'chat:attachments-adopt-failed', { threadId: thread.id, err })
        throw bad('Your files could not be attached. Add them again and resend.')
      }
    }

    const recipe = await resolveRecipeSend(this.ctx, { text: req.text, recipeId: req.recipeId })
    const typed = req.text.trim()
    if (!recipe && !typed && !req.attachmentIds?.length) throw bad('Type a message first.')
    const plan = await this.plan(req, recipe, earlier, attachments)

    const full: ChatContext = {
      mode: 'all',
      activeView: plan.view,
      includeTranscripts: plan.includeTranscripts,
      ...(req.selectedDocuments.length ? { selectedDocuments: req.selectedDocuments } : {}),
      ...(req.selectedDocuments.length || req.mentions.length
        ? {
            additionalContext: {
              ...(req.selectedDocuments.length ? { pickedNotes: req.selectedDocuments } : {}),
              ...(req.mentions.length ? { mentionedNotes: req.mentions } : {})
            }
          }
        : {}),
      ...(plan.directory ? { directoryContext: plan.directory } : {})
    }
    const context = contextToStore(earlier, full, {
      selection: !!req.selectionMarkdown?.trim(),
      selectedDocuments: req.selectedDocuments.length > 0,
      mentions: req.mentions
    })

    // Step 7: the user message is saved before streaming starts.
    await this.ctx.storage.upsertChatMessage({
      id: userMessageId,
      thread_id: thread.id,
      role: 'user',
      turn_index: turnIndex,
      attachments,
      raw_text: recipe ? recipe.displayText : typed,
      context,
      sources: null,
      outputs: null,
      status: 'completed',
      custom_type: null,
      trace_id: null
    })
    if (recipe) void recordRecipeUse(this.ctx, recipe.recipe.id, recipeViewFor(plan.view))
    log('info', 'chat:message-sent', {
      threadId: thread.id,
      surface: req.surface,
      place: req.place.kind,
      chars: typed.length,
      recipe: recipe?.recipe.slug ?? null,
      edit: !!req.edit
    })
    pushChatChanged(this.ctx.windows, [thread.id])

    const assistantMessageId = randomUUID()
    this.start(
      { requestId: req.requestId, threadId: thread.id, assistantMessageId, turnIndex, preview: false },
      (a) => this.runAnswer(a, plan)
    )
    return { threadId: thread.id, userMessageId, assistantMessageId }
  }

  async stop(threadId: unknown): Promise<void> {
    const id = typeof threadId === 'string' ? threadId.toLowerCase() : ''
    const a = this.active.get(id)
    if (!a) return
    a.controller.abort()
    await Promise.race([a.done, new Promise((r) => setTimeout(r, ABORT_WAIT_MS))])
  }

  /** Every stream stops (quit). */
  stopAll(): void {
    for (const a of this.active.values()) a.controller.abort()
  }

  // ---------- tool-call decisions ----------

  async updateToolCall(raw: unknown): Promise<void> {
    const u: ToolCallUpdate = parseToolCallUpdate(raw)
    const apply = (c: ChatToolCall): ChatToolCall => ({
      ...c,
      ...(u.patch.reverted !== undefined ? { reverted: u.patch.reverted } : {}),
      ...(u.patch.error !== undefined ? { error: u.patch.error } : {})
    })
    const live = [...this.active.values()].find((a) => a.assistantMessageId === u.messageId)
    if (live) {
      const r = patchCall(live.outputs, u.toolCallId, apply)
      if (!r) throw bad('That tool call does not exist.')
      live.outputs = r.outputs
      this.emit(live, { type: 'output_update', index: r.index, output: r.outputs[r.index] as ChatOutput })
      return
    }
    const m = (await this.ctx.storage.listChatMessages(u.threadId)).find((x) => x.id === u.messageId)
    if (!m) throw bad('That message no longer exists.')
    const r = patchCall(m.outputs ?? [], u.toolCallId, apply)
    if (!r) throw bad('That tool call does not exist.')
    await this.ctx.storage.upsertChatMessage(toUpsert(m, { outputs: r.outputs }))
    pushChatChanged(this.ctx.windows, [m.thread_id])
  }

  /** Bus `enhance:completed`: a rewrite started by chat failed → its call shows "Couldn’t rewrite notes". */
  onGenerationCompleted(e: { panelId: string; ok: boolean }): void {
    const call = this.rewrites.get(e.panelId)
    if (!call) return
    this.rewrites.delete(e.panelId)
    if (e.ok) {
      pushChatChanged(this.ctx.windows, [call.threadId])
      return
    }
    this.updateToolCall({ threadId: call.threadId, messageId: call.messageId, toolCallId: call.toolCallId, patch: { error: 'The rewrite failed.' } }).catch(
      (err: unknown) => log('warn', 'chat:rewrite-failure-save-failed', { err })
    )
  }

  // ---------- sending ----------

  private async ensureThread(req: ChatSendRequest): Promise<ChatThread> {
    if (req.threadId) {
      // The renderer never names a new thread, so an unknown id is a deleted chat.
      const existing = await this.ctx.storage.getChatThread(req.threadId)
      if (existing) return existing
      throw bad('That chat no longer exists. Start a new chat.')
    }
    if (req.edit || req.approval) throw bad('That chat no longer exists.')
    // A new thread, untitled, under the surface's grouping key.
    const thread = await this.ctx.storage.upsertChatThread({
      id: randomUUID(),
      creation_platform: platform(),
      title: null,
      grouping_key: req.groupingKey,
      initiated_by: 'user',
      is_pinned: false
    })
    log('info', 'chat:thread-created', { threadId: thread.id, groupingKey: req.groupingKey, place: req.place.kind })
    pushChatChanged(this.ctx.windows, [thread.id])
    return thread
  }

  private async plan(
    req: ChatSendRequest,
    recipe: Awaited<ReturnType<typeof resolveRecipeSend>>,
    earlier: ChatMessage[],
    attachments: AttachmentRef[]
  ): Promise<Plan> {
    const contexts = recipe?.contexts ?? []
    const selection = req.selectionMarkdown?.trim() ? req.selectionMarkdown : null
    const live = req.place.kind === 'meeting' && this.ctx.capture.isCapturing() && this.ctx.capture.currentNoteId() === req.place.noteId
    let view: ChatViewContext
    let directory: DirectoryContext | null = null
    let brief: BriefFacts | null = null
    if (req.place.kind === 'meeting') {
      const note = await this.ctx.storage.getNote(req.place.noteId).catch(() => null)
      const start = (note?.linked_event?.start as { dateTime?: unknown } | undefined)?.dateTime
      const upcoming = typeof start === 'string' && Date.parse(start) > Date.now()
      brief = note?.event_id ? await this.meaningfulBrief(note.event_id) : null
      const base = {
        meetingId: req.place.noteId,
        selectionText: selection,
        relatedMeetings: [] as DocRef[],
        includeUpcoming: contexts.includes('upcoming_events'),
        prepBrief: brief?.ref ?? null
      }
      view = live ? { view: 'live-meeting', ...base } : { view: 'meeting', ...base, isUpcoming: upcoming }
    } else {
      view = await libraryViewContext(this.ctx, req.place)
      directory = directoryContext(await folders(this.ctx))
    }
    const typed = expandMentions(req.text.trim(), req.mentions)
    let userContent = recipe ? recipe.promptText : typed
    if (selection) userContent += `\n\nThe passage I selected:\n"""\n${selection.trim()}\n"""`
    if (req.editWithAi && selection) userContent += '\n\n(Quick edit: change the selected passage in the document.)'
    return {
      readOnlyTools: req.surface === 'meeting_dock',
      place: req.place,
      view,
      directory,
      kind: req.place.kind === 'meeting' ? 'single' : 'multi',
      recipeModel: recipe?.model ?? null,
      recipeContexts: contexts,
      question: recipe ? `${recipe.rest} ${recipe.recipe.config.instructions}` : typed,
      userContent,
      earlier,
      mentions: req.mentions,
      selectedDocuments: req.selectedDocuments,
      includeTranscripts: contexts.includes('with_transcripts'),
      target: req.place.kind === 'meeting' ? req.target : null,
      selection,
      editWithAi: req.editWithAi,
      live,
      detailed: req.responseStyle === 'detailed',
      attachments,
      brief
    }
  }

  /** The event's brief, when the Labs switch adds briefs to note chat and it says something. */
  private async meaningfulBrief(eventId: string): Promise<BriefFacts | null> {
    const s = await this.ctx.settings.getAll()
    if (!s['prepBrief.enabled'] || !s['prepBrief.inChat']) return null
    const b = await this.ctx.storage.getBrief(eventId).catch(() => null)
    if (!b || b.status !== 'completed' || !b.headline?.trim() || b.worth_showing !== true) return null
    return { ref: { id: b.id, shortBrief: b.headline, isNotable: true }, content: b.content ?? b.headline }
  }

  /** Test recipe: streamed, never stored. */
  private async sendPreview(req: ChatSendRequest): Promise<ChatSendAccepted> {
    const preview = req.preview as NonNullable<ChatSendRequest['preview']>
    const notes = await this.ctx.storage.queryNotes({ ids: preview.noteIds })
    const refs: DocRef[] = notes.map((n) => ({ id: n.id, title: n.title?.trim() || 'Untitled note' }))
    const single = preview.noteIds.length === 1 && !!preview.noteIds[0]
    const place: ChatPlace = single ? { kind: 'meeting', noteId: preview.noteIds[0] as string } : { kind: 'global' }
    const view: ChatViewContext =
      place.kind === 'meeting'
        ? {
            view: 'meeting',
            meetingId: place.noteId,
            selectionText: null,
            relatedMeetings: [],
            isUpcoming: false,
            includeUpcoming: false,
            prepBrief: null
          }
        : await libraryViewContext(this.ctx, { kind: 'global' })
    const contexts = preview.recipe.config.extra_context ?? []
    const plan: Plan = {
      place,
      view,
      directory: null,
      kind: single ? 'single' : 'multi',
      recipeModel: preview.recipe.config.model ?? null,
      recipeContexts: contexts,
      question: preview.recipe.config.instructions,
      userContent: recipeUserTurn(preview.recipe.config, ''),
      earlier: [],
      mentions: [],
      selectedDocuments: single ? [] : refs,
      includeTranscripts: contexts.includes('with_transcripts'),
      target: null,
      selection: null,
      editWithAi: false,
      live: false,
      detailed: false,
      attachments: [],
      brief: null
    }
    const assistantMessageId = randomUUID()
    this.start(
      { requestId: req.requestId, threadId: req.requestId, assistantMessageId, turnIndex: 0, preview: true },
      (a) => this.runAnswer(a, plan)
    )
    return { threadId: req.requestId, userMessageId: null, assistantMessageId }
  }

  private start(
    base: Pick<Answer, 'requestId' | 'threadId' | 'assistantMessageId' | 'turnIndex' | 'preview'> & { outputs?: ChatOutput[]; sources?: StoredSources },
    run: (a: Answer) => Promise<void>
  ): Answer {
    const a: Answer = {
      ...base,
      controller: new AbortController(),
      outputs: base.outputs ?? [],
      sources: base.sources ?? { totalSources: 0, scannedDocuments: {}, citationIds: [] },
      model: '',
      noTools: false,
      chunks: 0,
      done: Promise.resolve()
    }
    this.active.set(a.threadId, a)
    // Started after the acceptance is returned, so the renderer has the ids first.
    a.done = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => run(a))
      .catch((err: unknown) => log('error', 'chat:answer-crashed', { err }))
      .finally(() => {
        if (this.active.get(a.threadId) === a) this.active.delete(a.threadId)
      })
    return a
  }

  private async abortThread(threadId: string): Promise<void> {
    const a = this.active.get(threadId)
    if (!a) return
    a.controller.abort()
    await Promise.race([a.done, new Promise((r) => setTimeout(r, ABORT_WAIT_MS))])
  }

  private emit(a: Answer, e: ChatEvent extends infer T ? (T extends unknown ? Omit<T, 'threadId' | 'assistantMessageId' | 'requestId'> : never) : never): void {
    pushChatEvent(this.ctx.windows, { threadId: a.threadId, assistantMessageId: a.assistantMessageId, requestId: a.requestId, ...e } as ChatEvent)
  }

  // ---------- one answer ----------

  private async runAnswer(a: Answer, plan: Plan): Promise<void> {
    let loop: Loop | null = null
    try {
      const settings = await this.ctx.settings.getAll()
      const resolved = await resolveChatModel(this.ctx, { kind: plan.kind, recipeModel: plan.recipeModel })
      const provider = buildProvider(resolved.provider, withModel(settings, resolved.provider, resolved.model), this.ctx.secrets)
      const availability = await provider.available()
      if (!availability.ok) {
        throw availability.reason === 'no-key'
          ? new ChatFailure('missing-key', 'Add an API key for your AI provider in Settings ▸ AI to chat.')
          : new ChatFailure('no-model', 'Choose a model for your AI provider in Settings ▸ AI to chat.')
      }
      a.model = provider.model
      const noToolsKey = `${resolved.provider}:${provider.model}`
      const knownNoTools = settings['chat.noTools'].includes(noToolsKey)
      const window = (await provider.contextWindow()) ?? settings[contextTokensKey(resolved.provider)]
      const maxTokens = outputCap(window)

      // Chat files: images as image blocks when the model reads them, else their text.
      const files = await attachmentInputs(this.ctx, plan.attachments, await provider.acceptsImages().catch(() => false))
      const userContent = files.text ? `${plan.userContent}\n\n${files.text}` : plan.userContent

      // The answer's tools, chosen once. The budget counts the widest set this answer could get.
      const noteId = plan.place.kind === 'meeting' ? plan.place.noteId : null
      const avail = await toolAvailability(this.ctx, { place: plan.place, noteId, noteEdit: !!noteId && !!plan.target, rewrite: true })
      const providerTools = knownNoTools ? [] : await this.registry.providerTools({ place: plan.place, noteId })
      const widest = this.registry.build(avail, providerTools)
      const fixed =
        systemPrompt({ moment: momentNow(settings['profile.name']), tools: true, detailed: true, note: null, context: '', approvals: true, scheduling: true }).length +
        1_200 +
        JSON.stringify(widest.defs).length
      const budget = charsOf(window - maxTokens) - fixed - userContent.length

      const asm = await assemble(this.ctx, { ...plan, userContent, brief: plan.brief ? { id: plan.brief.ref.id, content: plan.brief.content } : null, budget })
      const lastTurn = asm.messages[asm.messages.length - 1]
      if (files.images.length && lastTurn?.role === 'user') lastTurn.images = files.images
      a.sources = { ...asm.sources, ...(asm.limit ? { contextLimit: asm.limit } : {}) }
      this.emit(a, { type: 'sources_progress', totalSources: asm.sources.totalSources, scannedDocuments: asm.sources.scannedDocuments })
      if (asm.limit) this.emit(a, { type: 'context_full', attachments: asm.limit })

      const offerNote = !!asm.note && !!plan.target
      const offerRewrite = offerNote && !!asm.note?.latestSummaryPanelId
      const answerTools = this.registry.build({ ...avail, noteEdit: offerNote, rewrite: offerRewrite }, providerTools)
      if (plan.readOnlyTools) {
        for (const [name, e] of answerTools.entries) if (!e.spec.readOnly) answerTools.entries.delete(name)
        answerTools.defs = [...answerTools.entries.values()].map((e) => e.spec.def)
      }
      // The user-context "About me" text, appended to the system context (empty when off).
      const extras = (await this.ctx.promptExtras.chatContext().catch(() => '')).trim()
      const skills = answerTools.entries.has('loadRecipe')
        ? (await allRecipes(this.ctx).catch(() => []))
            .slice(0, SKILLS_LISTED)
            .map((r) => ({ slug: r.slug, description: r.config.description ?? '' }))
        : []
      const approvals = [...answerTools.entries.values()].some((e) => e.spec.needsApproval)
      const scheduling = answerTools.entries.has('checkAvailability')
      const target: NoteTarget | null =
        asm.note && plan.target
          ? {
              noteId: asm.note.noteId,
              kind: plan.target.kind,
              panelId: plan.target.kind === 'summary' ? plan.target.panelId : null,
              markdown: plan.target.markdown
            }
          : null
      const moment = momentNow(settings['profile.name'])
      const build = (tools: boolean): Loop => ({
        provider,
        providerId: resolved.provider,
        system: systemPrompt({
          moment,
          tools,
          detailed: plan.detailed,
          note: asm.note ? { ...asm.note, editTools: tools && offerNote, rewriteTool: tools && offerRewrite } : null,
          context: extras ? `${asm.context}

${extras}` : asm.context,
          ...(tools ? { skills, approvals, scheduling } : {})
        }),
        tools: tools ? answerTools.defs : [],
        entries: tools ? answerTools.entries : new Map(),
        transcript: [...asm.messages],
        maxTokens,
        env: {
          ctx: this.ctx,
          place: plan.place,
          threadId: a.threadId,
          signal: a.controller.signal,
          noteId: asm.note?.noteId ?? null,
          target: target ? { ...target } : null,
          latestSummaryPanelId: asm.note?.latestSummaryPanelId ?? null,
          rewriteStarted: false,
          scanned: new Map(),
          windows: new Map()
        },
        index: asm.index,
        toolRounds: 0
      })

      loop = build(!knownNoTools)
      a.noTools = knownNoTools
      let finish: FinishReason
      try {
        finish = await this.runLoop(a, loop, plan)
      } catch (err) {
        if (!(err instanceof LlmToolsUnsupportedError) || loop.tools.length === 0 || loop.toolRounds > 0) throw err
        // Once more without tools; the pair is remembered (main-only `chat.noTools`).
        log('info', 'chat:no-tools-retry', { provider: resolved.provider, model: provider.model })
        await this.rememberNoTools(noToolsKey)
        a.outputs = []
        this.emit(a, { type: 'outputs', outputs: [] })
        loop = build(false)
        a.noTools = true
        finish = await this.runLoop(a, loop, plan)
      }
      await this.complete(a, loop, finish)
    } catch (err) {
      if (a.controller.signal.aborted && !(err instanceof ChatFailure && err.code === 'timeout')) {
        await this.cancelled(a, loop)
      } else {
        await this.fail(a, loop, err)
      }
    }
  }

  /** Rounds until the model stops calling tools (≤ 8 tool rounds, then one last round). */
  private async runLoop(a: Answer, loop: Loop, plan: Plan): Promise<FinishReason> {
    for (;;) {
      const r = await this.round(a, loop)
      if (r.reason === 'refusal') throw new ChatFailure('refusal', REFUSAL_MESSAGE)
      if (r.reason !== 'tool_use' || r.calls.length === 0) {
        if (r.reason === 'max_tokens') {
          // A tool call cut off by the length limit never runs.
          for (const c of r.calls) this.finishCall(a, c.id, { content: '', isError: true, result: null }, 'The answer reached its length limit before this step ran.')
          return 'length'
        }
        return 'stop'
      }
      loop.transcript.push({
        role: 'assistant',
        content: r.text,
        toolCalls: r.calls.map((c) => ({ id: c.id, name: c.name, args: c.args ?? {} })),
        replay: r.replay
      })
      loop.toolRounds++
      let pending: string | null = null
      for (const c of r.calls) {
        const entry = loop.entries.get(c.name)
        if (entry?.spec.needsApproval) {
          const problem = entry.local
            ? validateLocal(entry.local, c.args)
            : c.args === null
              ? 'The tool input was not valid JSON.'
              : ((await entry.provider?.check?.(c.name, c.args).catch(() => null)) ?? null)
          // An invalid call goes back as a tool error; a second ✱ call waits for the first.
          const early: ToolOutcome | null = problem ? fail(problem) : pending ? fail(WAITING_EARLIER) : null
          if (early) {
            this.finishCall(a, c.id, early)
            loop.transcript.push({ role: 'tool', toolCallId: c.id, name: c.name, content: early.content, isError: true })
            continue
          }
          pending = c.id
          const previewFailed = (err: unknown): null => {
            log('warn', 'chat:approval-preview-failed', { tool: c.name, err })
            return null
          }
          const preview: ApprovalPreview | null = entry.local?.preview
            ? await entry.local.preview(c.args ?? {}, loop.env).catch(previewFailed)
            : entry.provider?.preview
              ? await entry.provider.preview(c.name, c.args ?? {}).catch(previewFailed)
              : null
          this.setCall(a, c.id, (tc) => ({
            ...tc,
            confirmationRequired: true,
            confirmationStatus: 'pending',
            approval: { id: randomUUID(), status: 'pending', proposedArgs: c.args ?? {} },
            ...(preview ? { result: { approvalPreview: preview } } : {})
          }))
          continue
        }
        const outcome: ToolOutcome =
          loop.toolRounds > CHAT_LIMITS.maxToolRounds
            ? { content: 'This answer has used all of its tool calls. Answer with what you have.', isError: true, result: null }
            : entry
              ? await this.registry.run(entry, c.name, c.args, loop.env)
              : fail(`Unknown tool ${c.name}.`)
        this.finishCall(a, c.id, outcome)
        loop.transcript.push({ role: 'tool', toolCallId: c.id, name: c.name, content: outcome.content, ...(outcome.isError ? { isError: true } : {}) })
        if (!outcome.isError && c.name === 'rewriteNote') {
          const panelId = (outcome.result as { newPanelId?: string } | null)?.newPanelId
          if (panelId && !a.preview) this.rewrites.set(panelId, { threadId: a.threadId, messageId: a.assistantMessageId, toolCallId: c.id })
        }
        this.noteScanned(a, loop)
      }
      if (pending) {
        this.paused.set(a.assistantMessageId, { loop, plan, pending: [pending] })
        return 'tool-calls'
      }
      if (loop.toolRounds > CHAT_LIMITS.maxToolRounds + 1) return 'tool-calls'
    }
  }

  /** One streamed provider call. */
  private async round(
    a: Answer,
    loop: Loop
  ): Promise<{ reason: 'end' | 'max_tokens' | 'refusal' | 'tool_use'; replay: unknown; text: string; calls: RoundCall[] }> {
    const ctl = new AbortController()
    const onAbort = (): void => ctl.abort()
    a.controller.signal.addEventListener('abort', onAbort)
    if (a.controller.signal.aborted) ctl.abort()
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const touch = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timedOut = true
        ctl.abort()
      }, IDLE_TIMEOUT_MS)
    }
    touch()
    let text = ''
    const calls = new Map<string, RoundCall & { lastEmit: number }>()
    let stop: { reason: 'end' | 'max_tokens' | 'refusal' | 'tool_use'; replay: unknown; model: string } | null = null
    try {
      const stream = loop.provider.chat(
        { purpose: 'chat', system: loop.system, messages: loop.transcript, tools: loop.tools, maxTokens: loop.maxTokens },
        ctl.signal,
        touch
      )
      for await (const ev of stream) {
        touch()
        if (ev.type === 'stop') {
          stop = { reason: ev.reason, replay: ev.replay, model: ev.model }
          continue
        }
        this.tick(a)
        if (ev.type === 'text') {
          text += ev.delta
          const last = a.outputs[a.outputs.length - 1]
          if (last?.type === 'text') last.text += ev.delta
          else a.outputs.push({ type: 'text', text: ev.delta })
          this.emit(a, { type: 'text_delta', delta: ev.delta })
        } else if (ev.type === 'tool_call_start') {
          calls.set(ev.id, { id: ev.id, name: ev.name, args: null, lastEmit: 0 })
          a.outputs.push({ type: 'tool_call', tool_call: newToolCall(ev.id, ev.name, loop.entries.get(ev.name)) })
          this.emitCall(a, ev.id)
        } else if (ev.type === 'tool_args_chunk') {
          const call = calls.get(ev.id)
          this.setCall(a, ev.id, (tc) => ({ ...tc, argsDelta: (tc.argsDelta ?? '') + ev.argsDelta }), false)
          if (call && Date.now() - call.lastEmit >= ARGS_EMIT_MS) {
            call.lastEmit = Date.now()
            this.emitCall(a, ev.id)
          }
        } else if (ev.type === 'tool_call_end') {
          const call = calls.get(ev.id)
          if (call) call.args = ev.args
          this.setCall(a, ev.id, (tc) => ({ ...tc, args: ev.args ?? {} }))
        }
      }
    } catch (err) {
      if (timedOut) throw new ChatFailure('timeout', 'The AI provider stopped responding.')
      throw err
    } finally {
      if (timer) clearTimeout(timer)
      a.controller.signal.removeEventListener('abort', onAbort)
    }
    if (!stop) throw new ChatFailure('provider-error', 'The AI provider ended the answer early.')
    a.model = stop.model || a.model
    this.emit(a, { type: 'outputs', outputs: a.outputs })
    return { reason: stop.reason, replay: stop.replay, text, calls: [...calls.values()].map(({ id, name, args }) => ({ id, name, args })) }
  }

  private tick(a: Answer): void {
    a.chunks++
    if (a.chunks % DELAY_EVERY === 0) this.ctx.bus.emit('update:delay', { reason: 'chatActive' })
  }

  private setCall(a: Answer, id: string, f: (c: ChatToolCall) => ChatToolCall, emit = true): void {
    const r = patchCall(a.outputs, id, f)
    if (!r) return
    a.outputs = r.outputs
    if (emit) this.emit(a, { type: 'output_update', index: r.index, output: r.outputs[r.index] as ChatOutput })
  }

  private emitCall(a: Answer, id: string): void {
    const index = a.outputs.findIndex((o) => o.type === 'tool_call' && o.tool_call.id === id)
    if (index !== -1) this.emit(a, { type: 'output_update', index, output: a.outputs[index] as ChatOutput })
  }

  private finishCall(a: Answer, id: string, outcome: ToolOutcome, error?: string): void {
    this.setCall(a, id, (tc) => ({
      ...tc,
      completed: !outcome.isError,
      completedAtMs: Date.now(),
      result: outcome.isError ? null : outcome.result,
      error: outcome.isError ? (error ?? (outcome.content.slice(0, 300) || 'The tool failed.')) : null
    }))
  }

  private noteScanned(a: Answer, loop: Loop): void {
    for (const [noteId, windows] of loop.env.windows) loop.index.addWindows(noteId, windows)
    let added = false
    for (const [id, ref] of loop.env.scanned) {
      if (a.sources.scannedDocuments[id]) continue
      a.sources.scannedDocuments[id] = ref
      loop.index.addNote(id, ref.title)
      added = true
    }
    if (!added) return
    a.sources.totalSources = Object.keys(a.sources.scannedDocuments).length
    this.emit(a, { type: 'sources_progress', totalSources: a.sources.totalSources, scannedDocuments: { ...a.sources.scannedDocuments } })
  }

  private async rememberNoTools(key: string): Promise<void> {
    try {
      const list = await this.ctx.settings.get('chat.noTools')
      if (list.includes(key)) return
      await this.ctx.settings.set('chat.noTools', [...list, key].slice(-NO_TOOLS_MAX))
    } catch (err) {
      log('warn', 'chat:no-tools-save-failed', { err })
    }
  }

  // ---------- endings ----------

  private async persist(a: Answer, outputs: ChatOutput[] | null, status: ChatMessage['status'], rawText: string): Promise<void> {
    if (a.preview) return
    await this.ctx.storage.upsertChatMessage({
      id: a.assistantMessageId,
      thread_id: a.threadId,
      role: 'assistant',
      turn_index: a.turnIndex,
      attachments: [],
      raw_text: rawText,
      context: null,
      sources: a.sources,
      outputs,
      status,
      custom_type: null,
      trace_id: null
    })
  }

  private async complete(a: Answer, loop: Loop, finish: FinishReason): Promise<void> {
    const hasText = a.outputs.some((o) => o.type === 'text' && o.text.trim() !== '')
    const hasCalls = a.outputs.some((o) => o.type === 'tool_call')
    if (!hasText && !hasCalls) throw new ChatFailure('empty-response', FAILED_MESSAGE)
    const final = finalizeOutputs(a.outputs, loop.index, a.assistantMessageId)
    a.sources = { ...a.sources, citationIds: final.cited, meta: { model: a.model, noTools: a.noTools, finishReason: finish } }
    await this.persist(a, final.outputs, 'completed', final.text)
    this.emit(a, { type: 'sources_progress', citationIds: final.cited })
    this.emit(a, {
      type: 'stream_done',
      outputs: final.outputs,
      reasoning: null,
      metadata: { finishReason: finish, model: a.model, noTools: a.noTools }
    })
    log('info', 'chat:answer-completed', { threadId: a.threadId, finish, model: a.model, rounds: loop.toolRounds, noTools: a.noTools })
    if (a.preview) return
    pushChatChanged(this.ctx.windows, [a.threadId])
    void this.title(a.threadId, loop.provider)
  }

  private async cancelled(a: Answer, loop: Loop | null): Promise<void> {
    this.paused.delete(a.assistantMessageId)
    let outputs = a.outputs.map((o): ChatOutput =>
      o.type === 'tool_call' && !o.tool_call.completed && !o.tool_call.error && o.tool_call.approval?.status !== 'pending'
        ? { type: 'tool_call', tool_call: { ...o.tool_call, error: 'Stopped before this step finished.' } }
        : o
    )
    // Stopped: "[Response stopped]" after a blank line, on the last text output.
    const lastText = [...outputs].reverse().find((o) => o.type === 'text')
    if (lastText && lastText.type === 'text') lastText.text = `${lastText.text.trimEnd()}\n\n${STOPPED_MARK}`
    else outputs = [...outputs, { type: 'text', text: STOPPED_MARK }]
    const final = finalizeOutputs(outputs, loop?.index ?? new CitationIndex(), a.assistantMessageId)
    a.sources = { ...a.sources, citationIds: final.cited, meta: { model: a.model, noTools: a.noTools, finishReason: 'cancelled' } }
    try {
      await this.persist(a, final.outputs, 'cancelled', final.text)
    } catch (err) {
      log('warn', 'chat:cancel-save-failed', { err })
    }
    this.emit(a, {
      type: 'stream_done',
      outputs: final.outputs,
      reasoning: null,
      metadata: { finishReason: 'cancelled', model: a.model, noTools: a.noTools }
    })
    log('info', 'chat:answer-stopped', { threadId: a.threadId })
    if (!a.preview) pushChatChanged(this.ctx.windows, [a.threadId])
  }

  private async fail(a: Answer, loop: Loop | null, err: unknown): Promise<void> {
    this.paused.delete(a.assistantMessageId)
    const f = toFailure(err)
    log(f.code === 'provider-error' && f.message === FAILED_MESSAGE ? 'error' : 'info', 'chat:answer-failed', {
      threadId: a.threadId,
      code: f.code,
      message: f.message,
      ...(err instanceof ChatFailure ? {} : { err })
    })
    const partial = a.outputs.length > 0 ? finalizeOutputs(a.outputs, loop?.index ?? new CitationIndex(), a.assistantMessageId).outputs : null
    try {
      await this.persist(a, partial, 'error', f.message)
    } catch (e) {
      log('warn', 'chat:error-save-failed', { err: e })
    }
    this.emit(a, { type: 'error', error: f.message, code: f.code })
    if (!a.preview) pushChatChanged(this.ctx.windows, [a.threadId])
  }

  // ---------- approvals ----------

  /** A new message declines every approval still pending in the thread. */
  private async autoDeny(earlier: ChatMessage[]): Promise<void> {
    for (const m of earlier) {
      if (m.role !== 'assistant' || !m.outputs?.some((o) => o.type === 'tool_call' && o.tool_call.approval?.status === 'pending')) continue
      const outputs = m.outputs.map((o): ChatOutput => {
        if (o.type !== 'tool_call' || o.tool_call.approval?.status !== 'pending') return o
        const question = o.tool_call.name === ASK_USER_QUESTION
        return {
          type: 'tool_call',
          tool_call: {
            ...o.tool_call,
            completed: true,
            completedAtMs: Date.now(),
            confirmationStatus: 'cancelled',
            // A skipped question, or a declined change.
            result: question ? { answers: {} } : null,
            approval: { ...o.tool_call.approval, status: 'denied', reason: question ? QUESTIONS_SKIPPED_REASON : DENIED_BY_NEW_MESSAGE }
          }
        }
      })
      this.paused.delete(m.id)
      await this.ctx.storage.upsertChatMessage(toUpsert(m, { outputs }))
      log('info', 'chat:approval-auto-denied', { messageId: m.id })
    }
  }

  /** An approval decision: merged into the original answer, which then continues. */
  private async sendApproval(req: ChatSendRequest, thread: ChatThread): Promise<ChatSendAccepted> {
    const d = req.approval as NonNullable<ChatSendRequest['approval']>
    if (thread.grouping_key) this.threadKeys.set(thread.id, thread.grouping_key)
    await this.abortThread(thread.id)
    const messages = await this.ctx.storage.listChatMessages(thread.id)
    const m = messages.find((x) => x.id === d.assistantMessageId && x.role === 'assistant')
    const call = m?.outputs?.find((o) => o.type === 'tool_call' && o.tool_call.id === d.toolCallId)
    if (!m || !call || call.type !== 'tool_call') throw bad('That request no longer exists.')
    if (call.tool_call.approval?.id !== d.approvalId || call.tool_call.approval.status !== 'pending') throw bad('That request was already answered.')

    const approved = d.status === 'approved'
    const name = call.tool_call.name
    const proposed = call.tool_call.approval.proposedArgs ?? call.tool_call.args
    const question = name === ASK_USER_QUESTION
    let args: Record<string, unknown>
    if (question) {
      // Send carries {questions, answers}; Skip carries {questions}.
      const questions = cleanQuestions(proposed['questions'])
      const answers = approved ? (d.args?.['answers'] ?? {}) : undefined
      const problem = approved ? answersProblem(questions, answers) : null
      if (problem) throw bad(problem)
      args = approved ? { questions, answers } : { questions }
    } else {
      // Only createFolder's title may change before approving.
      const title = d.args?.['title']
      args = name === 'createFolder' && approved && typeof title === 'string' && title.trim() ? { ...proposed, title: title.trim().slice(0, 200) } : proposed
    }
    const reason = d.reason ?? (approved ? undefined : question ? QUESTIONS_SKIPPED_REASON : DECLINED_REASON)
    const decided = patchCall(m.outputs ?? [], d.toolCallId, (tc) => ({
      ...tc,
      args,
      confirmationStatus: approved ? 'confirmed' : 'cancelled',
      approval: { id: d.approvalId, status: d.status, ...(reason ? { reason } : {}), proposedArgs: proposed },
      ...(approved ? { result: null } : { completed: true, completedAtMs: Date.now(), result: question ? { answers: {} } : null })
    }))
    const outputs = decided?.outputs ?? m.outputs ?? []
    const paused = this.paused.get(m.id)
    this.paused.delete(m.id)
    log('info', 'chat:approval-decided', { messageId: m.id, status: d.status })

    this.start(
      {
        requestId: req.requestId,
        threadId: thread.id,
        assistantMessageId: m.id,
        turnIndex: m.turn_index,
        preview: false,
        outputs,
        sources: (m.sources as StoredSources | null) ?? undefined
      },
      (a) => this.continueAfterApproval(a, m, paused, { toolCallId: d.toolCallId, name, args, approved, ...(reason ? { reason } : {}) })
    )
    return { threadId: thread.id, userMessageId: null, assistantMessageId: m.id }
  }

  private async continueAfterApproval(
    a: Answer,
    m: ChatMessage,
    paused: { loop: Loop; plan: Plan; pending: string[] } | undefined,
    d: { toolCallId: string; name: string; args: Record<string, unknown>; approved: boolean; reason?: string }
  ): Promise<void> {
    this.emit(a, { type: 'outputs', outputs: a.outputs })
    const loop: Loop | null = paused?.loop ?? null
    try {
      if (!paused) {
        // The paused loop is gone (a restart): the decision still takes effect, and the next message carries on.
        if (d.approved) {
          const outcome = await this.decide(d, null, this.restartEnv(a))
          this.finishCall(a, d.toolCallId, outcome)
        }
        const final = finalizeOutputs(a.outputs, new CitationIndex(), a.assistantMessageId)
        await this.persist(a, final.outputs, 'completed', m.raw_text)
        this.emit(a, { type: 'stream_done', outputs: final.outputs, reasoning: null, metadata: { finishReason: 'tool-calls', model: '', noTools: false } })
        pushChatChanged(this.ctx.windows, [a.threadId])
        return
      }
      a.model = paused.loop.provider.model
      const outcome = await this.decide(d, paused.loop.entries.get(d.name) ?? null, paused.loop.env)
      if (d.approved) this.finishCall(a, d.toolCallId, outcome)
      paused.loop.transcript.push({ role: 'tool', toolCallId: d.toolCallId, name: d.name, content: outcome.content, ...(outcome.isError ? { isError: true } : {}) })
      this.noteScanned(a, paused.loop)
      // Every call of that round needs a result; any other pending one counts as declined.
      for (const id of paused.pending) {
        if (id === d.toolCallId) continue
        const other = a.outputs.find((o) => o.type === 'tool_call' && o.tool_call.id === id)
        this.setCall(a, id, (tc) => ({
          ...tc,
          completed: true,
          completedAtMs: Date.now(),
          confirmationStatus: 'cancelled',
          approval: tc.approval ? { ...tc.approval, status: 'denied', reason: DECLINED_REASON } : tc.approval
        }))
        paused.loop.transcript.push({
          role: 'tool',
          toolCallId: id,
          name: other?.type === 'tool_call' ? other.tool_call.name : 'tool',
          content: DECLINED_REASON
        })
      }
      const finish = await this.runLoop(a, paused.loop, paused.plan)
      await this.complete(a, paused.loop, finish)
    } catch (err) {
      if (a.controller.signal.aborted && !(err instanceof ChatFailure && err.code === 'timeout')) await this.cancelled(a, loop)
      else await this.fail(a, loop, err)
    }
  }

  /**
   * The tool result a decision produces: the answers plus
   * the reason for a question; the tool's own result for an approved change; the reason
   * for a declined one.
   */
  private async decide(
    d: { toolCallId: string; name: string; args: Record<string, unknown>; approved: boolean; reason?: string },
    entry: ToolEntry | null,
    env: ToolEnv
  ): Promise<ToolOutcome> {
    if (d.name === ASK_USER_QUESTION) {
      if (!d.approved) return { content: d.reason ?? QUESTIONS_SKIPPED_REASON, isError: false, result: { answers: {} } }
      const answers = (d.args['answers'] ?? {}) as Record<string, string[]>
      return { content: `${JSON.stringify({ answers })}${d.reason ? `\n\n${d.reason}` : ''}`, isError: false, result: { answers } }
    }
    if (!d.approved) return { content: d.reason ?? DECLINED_REASON, isError: false, result: null }
    const found = entry ?? (await this.registry.find(d.name, { place: env.place, noteId: env.noteId }))
    if (!found) return fail('That tool is no longer available.')
    const outcome = await this.registry.run(found, d.name, d.args, env)
    log('info', 'chat:approved-tool-ran', { tool: d.name, ok: !outcome.isError })
    return outcome
  }

  /** A tool env for a decision whose paused answer was lost (a restart). */
  private restartEnv(a: Answer): ToolEnv {
    const key = this.threadKeys.get(a.threadId) ?? 'global'
    const noteId = key.startsWith('meeting:') ? key.slice('meeting:'.length) : null
    const place: ChatPlace = noteId ? { kind: 'meeting', noteId } : key.startsWith('list:') ? { kind: 'list', folderId: key.slice(5) } : { kind: 'global' }
    return {
      ctx: this.ctx,
      place,
      threadId: a.threadId,
      signal: a.controller.signal,
      noteId,
      target: null,
      latestSummaryPanelId: null,
      rewriteStarted: false,
      scanned: new Map(),
      windows: new Map()
    }
  }

  // ---------- titles ----------

  private async title(threadId: string, provider: LlmProvider): Promise<void> {
    try {
      const thread = await this.ctx.storage.getChatThread(threadId)
      if (!thread || thread.title) return
      const messages = await this.ctx.storage.listChatMessages(threadId)
      const first = messages.find((x) => x.role === 'user') ?? messages[0]
      if (!first) return
      let message = expandMentions(first.raw_text, messageMentions(first))
      // An invoked recipe's instructions come before the rest of the text.
      const lead = /^\/([\p{L}\p{N}_-]+)(?=\s|$)/u.exec(message)
      if (lead?.[1]) {
        const recipe = await findRecipe(this.ctx, lead[1])
        const rest = message.slice(lead[0].length).trim()
        if (recipe) message = rest ? `${recipe.config.instructions.trim()}\n\n${rest}` : recipe.config.instructions.trim()
      }
      const now = new Date()
      const reply = await provider.complete(
        {
          purpose: 'title',
          system: TITLE_SYSTEM,
          user: titleUser({
            message,
            current_date: now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
            day_of_week: now.toLocaleDateString('en-US', { weekday: 'long' })
          }),
          maxTokens: MAX_TOKENS.title,
          model: provider.model
        },
        AbortSignal.timeout(TITLE_TIMEOUT_MS)
      )
      const title = cleanTitle(stripCitationKeys(reply), CHAT_LIMITS.titleCodePoints)
      if (!title) return
      const current = await this.ctx.storage.getChatThread(threadId)
      if (!current || current.title) return
      await this.ctx.storage.upsertChatThread({ id: threadId, title })
      pushChatChanged(this.ctx.windows, [threadId])
    } catch (err) {
      // Any failure leaves the title unset, with no message.
      log('debug', 'chat:title-failed', { threadId, err: err instanceof Error ? err.message : String(err) })
    }
  }
}
