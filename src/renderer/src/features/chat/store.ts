// SPDX-License-Identifier: Apache-2.0
// The renderer's chat state: thread lists per grouping
// key, loaded threads, the selection per grouping key, and the answers streaming now.
// One external store; `chat:event` updates are queued and applied once per animation
// frame, and `chat:changed` reloads what is on screen.

import { useSyncExternalStore } from 'react'
import { parseError } from '@shared/errors'
import type {
  ChatContextSources,
  ChatEditorTarget,
  ChatEvent,
  ChatOutput,
  ChatPlace,
  ChatSendAccepted,
  ChatSendRequest,
  ChatSurface,
  ChatThread,
  ChatThreadWithMessages,
  DocRef
} from '@shared/types/chat'
import { groupingKeyFor } from '@shared/types/chat'
import { debugLog } from '../../app/platform'

/** The thread list of every grouping key (the full-screen list). */
export const ALL_KEYS = '*'

export type ContextLimit = { filtered: string[]; unavailable: string[]; excluded: string[] }

export interface StreamMeta {
  finishReason: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'cancelled'
  model: string
  noTools: boolean
}

/** An answer this window asked for, from send until the stored message replaces it. */
export interface LiveAnswer {
  requestId: string
  surfaceId: string
  groupingKey: string
  threadId: string | null
  assistantMessageId: string | null
  userMessageId: string | null
  /** The user's message as shown until the stored one arrives (none for an approval). */
  pendingUser: { text: string; mentions: DocRef[]; editOf: string | null } | null
  outputs: ChatOutput[]
  sources: ChatContextSources | null
  limit: ContextLimit | null
  status: 'sending' | 'streaming' | 'completed' | 'cancelled' | 'error'
  error: { message: string; code: string | null } | null
  meta: StreamMeta | null
  startedAt: number
}

export interface FloatingState {
  open: boolean
  place: ChatPlace
  /** Text to send once the floating chat shows (palette "Ask Chat", list headers). */
  pending: { text: string; nonce: number } | null
}

interface State {
  lists: ReadonlyMap<string, ChatThread[]>
  details: ReadonlyMap<string, ChatThreadWithMessages | null>
  live: ReadonlyMap<string, LiveAnswer>
  /** Per grouping key: the selected thread, null for an explicit "none" (a new chat). Missing = not chosen yet. */
  selection: ReadonlyMap<string, string | null>
  floating: FloatingState
  /** `askChat` for the note whose page is open. */
  noteAsk: { noteId: string; text: string; nonce: number } | null
  /** A question for a new full-screen chat (`askChat` without a note, or quick ask's hand-off). */
  pageAsk: { text: string; nonce: number; surface?: ChatSurface } | null
}

let state: State = {
  lists: new Map(),
  details: new Map(),
  live: new Map(),
  selection: new Map(),
  floating: { open: false, place: { kind: 'global' }, pending: null },
  noteAsk: null,
  pageAsk: null
}

const listeners = new Set<() => void>()
let emitQueued = false

function emit(): void {
  if (emitQueued) return
  emitQueued = true
  queueMicrotask(() => {
    emitQueued = false
    for (const l of listeners) l()
  })
}

function set(patch: Partial<State>): void {
  state = { ...state, ...patch }
  emit()
}

export function getChatState(): State {
  return state
}

function subscribe(cb: () => void): () => void {
  start()
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useChat<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state))
}

// ---------- loading ----------

const inflight = new Map<string, Promise<void>>()
const loadedLists = new Set<string>()
const lastViewed = new Map<string, number>()

export function loadList(key: string): Promise<void> {
  const k = `list:${key}`
  const running = inflight.get(k)
  if (running) return running
  const p = window.notula.chat
    .listThreads(key === ALL_KEYS ? {} : { groupingKey: key })
    .then((threads) => {
      loadedLists.add(key)
      const lists = new Map(state.lists)
      lists.set(key, threads)
      set({ lists })
    })
    .catch((err: unknown) => debugLog('chat:list-failed', { key, err: parseError(err).message }))
    .finally(() => inflight.delete(k))
  inflight.set(k, p)
  return p
}

export function loadThread(threadId: string): Promise<void> {
  const k = `thread:${threadId}`
  const running = inflight.get(k)
  if (running) return running
  const p = window.notula.chat
    .getThread({ threadId })
    .then((detail) => {
      const details = new Map(state.details)
      details.set(threadId, detail)
      set({ details, live: pruneLive(state.live, threadId, detail) })
    })
    .catch((err: unknown) => debugLog('chat:thread-failed', { threadId, err: parseError(err).message }))
    .finally(() => inflight.delete(k))
  inflight.set(k, p)
  return p
}

/** A finished answer gives way to its stored message once that has loaded. */
function pruneLive(live: ReadonlyMap<string, LiveAnswer>, threadId: string, detail: ChatThreadWithMessages | null): ReadonlyMap<string, LiveAnswer> {
  let next: Map<string, LiveAnswer> | null = null
  for (const [id, l] of live) {
    if (l.threadId !== threadId || l.status === 'sending' || l.status === 'streaming') continue
    const stored = !detail || detail.messages.some((m) => m.id === l.assistantMessageId)
    if (!stored) continue
    next ??= new Map(live)
    next.delete(id)
  }
  return next ?? live
}

let changeTimer: ReturnType<typeof setTimeout> | null = null
const changedThreads = new Set<string>()

function onChanged(threadIds: string[]): void {
  for (const id of threadIds) changedThreads.add(id)
  if (changeTimer) return
  changeTimer = setTimeout(() => {
    changeTimer = null
    const ids = [...changedThreads]
    changedThreads.clear()
    for (const key of loadedLists) void loadList(key)
    for (const id of ids) if (state.details.has(id)) void loadThread(id)
  }, 120)
}

// ---------- events ----------

const queued: ChatEvent[] = []
let frame = 0
const outputWatchers = new Map<string, (l: LiveAnswer) => void>()

function flush(): void {
  frame = 0
  if (queued.length === 0) return
  const events = queued.splice(0)
  let live: Map<string, LiveAnswer> | null = null
  const touched = new Set<string>()
  const finished = new Set<string>()
  for (const e of events) {
    const cur = (live ?? state.live).get(e.requestId)
    if (!cur) continue
    live ??= new Map(state.live)
    const next = applyEvent(cur, e)
    live.set(e.requestId, next)
    touched.add(e.requestId)
    if (e.type === 'stream_done' || e.type === 'error') finished.add(e.threadId)
  }
  if (!live) return
  set({ live })
  for (const id of touched) {
    const l = live.get(id)
    const w = outputWatchers.get(id)
    if (l && w) w(l)
  }
  for (const threadId of finished) {
    void loadThread(threadId)
    for (const key of loadedLists) void loadList(key)
  }
}

function applyEvent(l: LiveAnswer, e: ChatEvent): LiveAnswer {
  const base: LiveAnswer = {
    ...l,
    threadId: l.threadId ?? e.threadId,
    assistantMessageId: l.assistantMessageId ?? e.assistantMessageId,
    status: l.status === 'sending' ? 'streaming' : l.status
  }
  switch (e.type) {
    case 'text_delta': {
      const outputs = [...base.outputs]
      const last = outputs[outputs.length - 1]
      if (last?.type === 'text') outputs[outputs.length - 1] = { type: 'text', text: last.text + e.delta }
      else outputs.push({ type: 'text', text: e.delta })
      return { ...base, outputs }
    }
    case 'output_update': {
      const outputs = [...base.outputs]
      outputs[e.index] = e.output
      return { ...base, outputs }
    }
    case 'outputs':
      return { ...base, outputs: e.outputs }
    case 'sources_progress': {
      const prev = base.sources ?? { totalSources: 0, scannedDocuments: {}, citationIds: [] }
      return {
        ...base,
        sources: {
          totalSources: e.totalSources ?? prev.totalSources,
          scannedDocuments: { ...prev.scannedDocuments, ...(e.scannedDocuments ?? {}) },
          citationIds: [...new Set([...prev.citationIds, ...(e.citationIds ?? [])])]
        }
      }
    }
    case 'context_full':
      return { ...base, limit: e.attachments }
    case 'stream_done':
      return {
        ...base,
        outputs: e.outputs,
        meta: e.metadata,
        status: e.metadata.finishReason === 'cancelled' ? 'cancelled' : 'completed'
      }
    case 'error':
      return { ...base, status: 'error', error: { message: e.error, code: e.code } }
  }
}

let started = false

function start(): void {
  if (started) return
  started = true
  window.notula.chat.onEvent((e) => {
    if (!state.live.has(e.requestId)) return
    queued.push(e)
    if (!frame) frame = requestAnimationFrame(flush)
  })
  window.notula.chat.onChanged(({ threadIds }) => onChanged(threadIds))
}

/** Called with the answer after every applied batch (the note-edit queue). */
export function watchOutputs(requestId: string, cb: (l: LiveAnswer) => void): () => void {
  outputWatchers.set(requestId, cb)
  return () => {
    if (outputWatchers.get(requestId) === cb) outputWatchers.delete(requestId)
  }
}

// ---------- selection ----------

export function selectThread(key: string, threadId: string | null): void {
  const selection = new Map(state.selection)
  selection.set(key, threadId)
  set({ selection })
}

/** With no choice yet, the key's most recent user thread; else none. */
export function autoSelect(key: string): void {
  if (state.selection.has(key)) return
  const list = state.lists.get(key)
  if (!list) return
  const latest = list
    .filter((t) => t.initiated_by === 'user')
    .reduce<ChatThread | null>((best, t) => (!best || t.updated_at > best.updated_at ? t : best), null)
  selectThread(key, latest?.id ?? null)
}

export function markViewed(surface: ChatSurface, key: string): void {
  lastViewed.set(`${surface}|${key}`, Date.now())
}

export function viewedAt(surface: ChatSurface, key: string): number | null {
  return lastViewed.get(`${surface}|${key}`) ?? null
}

// ---------- sending ----------

export interface SendOptions {
  surfaceId: string
  surface: ChatSurface
  place: ChatPlace
  threadId: string | null
  text: string
  /** What the user message shows until the stored one arrives (`/<slug> text` for a recipe). */
  displayText?: string
  mentions?: DocRef[]
  recipeId?: string | null
  target?: ChatEditorTarget | null
  selectionMarkdown?: string | null
  editWithAi?: boolean
  responseStyle?: 'default' | 'detailed'
  edit?: { messageId: string } | null
  approval?: ChatSendRequest['approval']
  /** An approval continues this stored answer: its outputs show while it streams. */
  baseOutputs?: ChatOutput[]
  /** Called with the request id before anything is sent (to watch its outputs from the first event). */
  onRequest?(requestId: string): void
  /** The chat files sent with the message. */
  attachmentIds?: string[]
}

export type SendResult = { ok: true; requestId: string; accepted: ChatSendAccepted } | { ok: false; error: string }

export async function sendChat(o: SendOptions): Promise<SendResult> {
  start()
  const requestId = crypto.randomUUID()
  const key = groupingKeyFor(o.place)
  const l: LiveAnswer = {
    requestId,
    surfaceId: o.surfaceId,
    groupingKey: key,
    threadId: o.threadId,
    assistantMessageId: o.approval?.assistantMessageId ?? null,
    userMessageId: o.edit?.messageId ?? null,
    pendingUser: o.approval ? null : { text: o.displayText ?? o.text, mentions: o.mentions ?? [], editOf: o.edit?.messageId ?? null },
    outputs: o.baseOutputs ?? [],
    sources: null,
    limit: null,
    status: 'sending',
    error: null,
    meta: null,
    startedAt: Date.now()
  }
  const live = new Map(state.live)
  live.set(requestId, l)
  set({ live })
  o.onRequest?.(requestId)
  try {
    const accepted = await window.notula.chat.sendMessage({
      requestId,
      threadId: o.threadId,
      groupingKey: key,
      surface: o.surface,
      place: o.place,
      text: o.text,
      mentions: o.mentions ?? [],
      recipeId: o.recipeId ?? null,
      selectedDocuments: [],
      target: o.target ?? null,
      selectionMarkdown: o.selectionMarkdown ?? null,
      editWithAi: o.editWithAi ?? false,
      responseStyle: o.responseStyle ?? 'default',
      edit: o.edit ?? null,
      approval: o.approval ?? null,
      preview: null,
      ...(o.attachmentIds?.length ? { attachmentIds: o.attachmentIds } : {})
    })
    const cur = state.live.get(requestId)
    if (cur) {
      const next = new Map(state.live)
      next.set(requestId, {
        ...cur,
        threadId: accepted.threadId,
        assistantMessageId: accepted.assistantMessageId,
        userMessageId: accepted.userMessageId ?? cur.userMessageId,
        status: cur.status === 'sending' ? 'streaming' : cur.status
      })
      set({ live: next })
    }
    // A new chat selects its thread as soon as it exists.
    if (!o.threadId && (state.selection.get(key) ?? null) === null) selectThread(key, accepted.threadId)
    void loadThread(accepted.threadId)
    void loadList(key)
    if (loadedLists.has(ALL_KEYS)) void loadList(ALL_KEYS)
    return { ok: true, requestId, accepted }
  } catch (err) {
    const next = new Map(state.live)
    next.delete(requestId)
    set({ live: next })
    return { ok: false, error: parseError(err).message || 'Couldn’t send your message. Try again.' }
  }
}

export async function stopThread(threadId: string): Promise<void> {
  try {
    await window.notula.chat.stop({ threadId })
  } catch (err) {
    debugLog('chat:stop-failed', { threadId, err: parseError(err).message })
  }
}

/** The answer streaming in a thread (or about to, for a new chat of this surface). */
export function streamingIn(s: State, threadId: string | null, surfaceId: string): LiveAnswer | null {
  for (const l of s.live.values()) {
    if (l.status !== 'sending' && l.status !== 'streaming') continue
    if (threadId ? l.threadId === threadId : l.threadId === null && l.surfaceId === surfaceId) return l
  }
  return null
}

// ---------- floating chat, askChat ----------

export function openFloating(place: ChatPlace, text?: string): void {
  set({
    floating: { open: true, place, pending: text?.trim() ? { text: text.trim(), nonce: Date.now() } : null }
  })
}

/** The floating chat on a given thread of the place; `text`, if any, is then sent in that thread. */
export function openFloatingThread(place: ChatPlace, threadId: string, text?: string): void {
  selectThread(groupingKeyFor(place), threadId)
  openFloating(place, text)
}

export function closeFloating(): void {
  set({ floating: { ...state.floating, open: false, pending: null } })
}

export function takeFloatingPending(): void {
  if (state.floating.pending) set({ floating: { ...state.floating, pending: null } })
}

/** Note pages whose chat panel is mounted, for `askChat`. */
export const mountedNotePanels = new Set<string>()

export function askNote(noteId: string, text: string): void {
  set({ noteAsk: { noteId, text, nonce: Date.now() } })
}

export function takeNoteAsk(): void {
  if (state.noteAsk) set({ noteAsk: null })
}

export function askPage(text: string, surface?: ChatSurface): void {
  set({ pageAsk: { text, nonce: Date.now(), ...(surface ? { surface } : {}) } })
}

export function takePageAsk(): void {
  if (state.pageAsk) set({ pageAsk: null })
}
