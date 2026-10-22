// SPDX-License-Identifier: Apache-2.0
// A thread's messages: user
// messages with their recipe chip and mentions, answers with tool status lines,
// markdown and citation chips, "Searched N notes", the context-limit note, errors,
// and the message actions. Stored messages and the answers streaming now are merged.
//
// Ordinary tool calls fold into a group of
// steps with their cards; inline tools, approvals and questions render on their own
// (ToolSteps.tsx). User messages show their chat files.

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import type { AttachmentRef, ChatCitation, ChatMessage, ChatOutput, ChatToolCall, DocRef } from '@shared/types/chat'
import { IconCheck } from '../../app/icons'
import { navigate } from '../../app/navigation'
import { toolCardFor, useSlotsVersion } from '../../app/slots'
import { showToast } from '../../app/toast'
import { openRecipeModal, RecipeChip, leadingRecipeRef } from '../recipes'
import { MarkdownView, type CitationRendering } from './ChatMarkdown'
import { IconArrowDown, IconBookmark, IconCopy, IconEdit, IconImage, IconPaperclip, IconResend, IconSearchDoc, IconTool, IconUndo, IconRedo, IconWarn } from './icons'
import { StandaloneStep, standalone, StepGroup, type ApprovalDecision } from './ToolSteps'
import { useChat, type ContextLimit, type LiveAnswer, type StreamMeta } from './store'
import { answerText, mentionsAsTitles, messageMentions, stripKeys, toolLine, toolPhase } from './util'

export interface AssistantView {
  id: string
  threadId: string | null
  outputs: ChatOutput[]
  sources: { totalSources: number; scannedDocuments: Record<string, DocRef> } | null
  limit: ContextLimit | null
  status: 'streaming' | 'completed' | 'cancelled' | 'error'
  error: string | null
  meta: StreamMeta | null
  /** The user message this answers. */
  user: ChatMessage | null
}

export interface EditControls {
  undo(a: AssistantView): void
  reapply(a: AssistantView): void
  busy: boolean
}

interface Props {
  threadId: string | null
  surfaceId: string
  /** The note of a one-note chat. */
  noteId: string | null
  onShowInTranscript?: ((quote: string) => void) | undefined
  onOpenPanel?: ((panelId: string) => void) | undefined
  onEditMessage(m: ChatMessage): void
  onResend(m: ChatMessage): void
  onSayMore(): void
  onApproval(a: AssistantView, call: ChatToolCall, decision: ApprovalDecision): void
  edits?: EditControls | null | undefined
  empty: ReactNode
  /** Changes when the surface sends, so the list scrolls to the new message. */
  sentNonce: number
}

type Item =
  | { kind: 'user'; key: string; text: string; mentions: DocRef[]; message: ChatMessage | null; pending: boolean }
  | { kind: 'assistant'; key: string; view: AssistantView }

type StoredSourcesLike = {
  totalSources?: number
  scannedDocuments?: Record<string, DocRef>
  contextLimit?: ContextLimit
  meta?: StreamMeta
} | null

function liveStatus(l: LiveAnswer): AssistantView['status'] {
  return l.status === 'sending' || l.status === 'streaming' ? 'streaming' : l.status
}

function fromLive(l: LiveAnswer, user: ChatMessage | null, base?: AssistantView): AssistantView {
  return {
    id: l.assistantMessageId ?? l.requestId,
    threadId: l.threadId,
    outputs: l.outputs,
    sources: l.sources ?? base?.sources ?? null,
    limit: l.limit ?? base?.limit ?? null,
    status: liveStatus(l),
    error: l.error?.message ?? null,
    meta: l.meta,
    user
  }
}

function fromStored(m: ChatMessage, user: ChatMessage | null): AssistantView {
  const s = m.sources as StoredSourcesLike
  return {
    id: m.id,
    threadId: m.thread_id,
    outputs: m.outputs ?? [],
    sources: s && typeof s.totalSources === 'number' ? { totalSources: s.totalSources, scannedDocuments: s.scannedDocuments ?? {} } : null,
    limit: s?.contextLimit ?? null,
    status: m.status === 'error' ? 'error' : m.status === 'cancelled' ? 'cancelled' : 'completed',
    error: m.status === 'error' ? m.raw_text || 'Couldn’t get a response. Try again.' : null,
    meta: s?.meta ?? null,
    user
  }
}

/** Stored messages merged with this window's live answers, in display order. */
function buildItems(stored: readonly ChatMessage[], lives: readonly LiveAnswer[]): Item[] {
  const items: Item[] = []
  const editing = lives.find((l) => l.pendingUser?.editOf && (l.status === 'sending' || l.status === 'streaming'))
  const cutIndex = editing ? stored.findIndex((m) => m.id === editing.pendingUser?.editOf) : -1
  const byId = new Map(lives.filter((l) => l.assistantMessageId).map((l) => [l.assistantMessageId as string, l]))
  let lastUser: ChatMessage | null = null
  stored.forEach((m, i) => {
    if (cutIndex !== -1 && i >= cutIndex) return
    if (m.role === 'user') {
      lastUser = m
      if (!m.raw_text.trim()) return
      items.push({ kind: 'user', key: m.id, text: m.raw_text, mentions: messageMentions(m), message: m, pending: false })
      return
    }
    const live = byId.get(m.id)
    items.push({ kind: 'assistant', key: m.id, view: live ? fromLive(live, lastUser, fromStored(m, lastUser)) : fromStored(m, lastUser) })
  })
  for (const l of lives) {
    const storedUser = l.userMessageId ? stored.find((m) => m.id === l.userMessageId) ?? null : null
    const showPending = l.pendingUser && (!storedUser || (l.pendingUser.editOf && cutIndex !== -1))
    if (showPending && l.pendingUser) {
      items.push({ kind: 'user', key: `p-${l.requestId}`, text: l.pendingUser.text, mentions: l.pendingUser.mentions, message: storedUser, pending: !storedUser })
    }
    if (l.assistantMessageId && stored.some((m) => m.id === l.assistantMessageId) && !(cutIndex !== -1 && l === editing)) continue
    items.push({ kind: 'assistant', key: `a-${l.requestId}`, view: fromLive(l, storedUser) })
  }
  return items
}

export function Conversation(p: Props): JSX.Element {
  const detail = useChat((s) => (p.threadId ? s.details.get(p.threadId) : undefined))
  const liveMap = useChat((s) => s.live)
  const lives = useMemo(
    () =>
      [...liveMap.values()]
        .filter((l) => (p.threadId ? l.threadId === p.threadId : l.threadId === null && l.surfaceId === p.surfaceId))
        .sort((a, b) => a.startedAt - b.startedAt),
    [liveMap, p.threadId, p.surfaceId]
  )
  const stored = useMemo(() => (p.threadId ? (detail?.messages ?? []) : []), [detail, p.threadId])
  const items = useMemo(() => buildItems(stored, lives), [stored, lives])

  const scroller = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const [showJump, setShowJump] = useState(false)

  const onScroll = (): void => {
    const el = scroller.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    atBottom.current = bottom
    setShowJump(!bottom)
  }

  const jump = (smooth: boolean): void => {
    const el = scroller.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    atBottom.current = true
    setShowJump(false)
  }

  // Follow the stream while the reader is at the bottom.
  useLayoutEffect(() => {
    if (atBottom.current) jump(false)
  }, [items])
  useEffect(() => {
    atBottom.current = true
    jump(false)
  }, [p.sentNonce, p.threadId])

  const lastAssistant = [...items].reverse().find((i) => i.kind === 'assistant')
  const loading = !!p.threadId && detail === undefined && lives.length === 0

  return (
    <div className="chat-convo">
      <div className="chat-convo__scroll" ref={scroller} onScroll={onScroll}>
        {loading ? (
          <div className="chat-convo__loading" aria-busy="true">
            <span className="n-spinner" />
          </div>
        ) : items.length === 0 ? (
          p.empty
        ) : (
          <div className="chat-convo__list">
            {items.map((item) =>
              item.kind === 'user' ? (
                <UserMessage key={item.key} item={item} onEdit={p.onEditMessage} onResend={p.onResend} />
              ) : (
                <AssistantMessage
                  key={item.key}
                  view={item.view}
                  isLast={item === lastAssistant}
                  noteId={p.noteId}
                  onShowInTranscript={p.onShowInTranscript}
                  onOpenPanel={p.onOpenPanel}
                  onResend={p.onResend}
                  onSayMore={p.onSayMore}
                  onApproval={p.onApproval}
                  edits={p.edits ?? null}
                />
              )
            )}
          </div>
        )}
      </div>
      {showJump && items.length > 0 ? (
        <button type="button" className="chat-convo__jump" aria-label="Scroll to bottom" title="Scroll to bottom" onClick={() => jump(true)}>
          <IconArrowDown size={15} />
        </button>
      ) : null}
    </div>
  )
}

// ---------- user messages ----------

function MessageText({ text, mentions }: { text: string; mentions: DocRef[] }): JSX.Element {
  const parts = text.split(/(@[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\s|$)/i)
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 1) {
          const id = part.slice(1).toLowerCase()
          const ref = mentions.find((m) => m.id.toLowerCase() === id)
          return (
            <button key={i} type="button" className="chat-mention" onClick={() => navigate(`/meeting/${encodeURIComponent(id)}`)}>
              @{ref?.title || 'New note'}
            </button>
          )
        }
        return <Fragment key={i}>{part}</Fragment>
      })}
    </>
  )
}

/** The chat files a stored user message carried. */
function messageFiles(m: ChatMessage | null): AttachmentRef[] {
  return (Array.isArray(m?.attachments) ? m.attachments : []).filter(
    (a): a is AttachmentRef => !!a && typeof a === 'object' && typeof (a as AttachmentRef).name === 'string'
  )
}

function UserMessage({
  item,
  onEdit,
  onResend
}: {
  item: Extract<Item, { kind: 'user' }>
  onEdit(m: ChatMessage): void
  onResend(m: ChatMessage): void
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  const recipe = leadingRecipeRef(item.text)
  const m = item.message
  const copy = async (): Promise<void> => {
    // "Copy text" keeps the `/<recipe>` prefix and shows mentions by title.
    await window.notula.clipboard.writeText({ text: mentionsAsTitles(item.text, item.mentions) })
    setCopied(true)
    setTimeout(() => setCopied(false), 1_500)
  }
  const files = messageFiles(m)
  return (
    <div className={`chat-msg chat-msg--user${item.pending ? ' is-pending' : ''}`}>
      {files.length ? (
        <div className="chat-files chat-files--sent">
          {files.map((f) => (
            <span key={f.id} className="chat-file" title={f.name}>
              {f.mimeType.startsWith('image/') ? <IconImage size={13} /> : <IconPaperclip size={13} />}
              <span className="chat-file__name">{f.name}</span>
            </span>
          ))}
        </div>
      ) : null}
      <div className="chat-bubble">
        {recipe ? (
          <>
            <RecipeChip recipeRef={recipe.ref} />
            {recipe.rest ? <span className="chat-bubble__rest"> <MessageText text={recipe.rest} mentions={item.mentions} /></span> : null}
          </>
        ) : (
          <MessageText text={item.text} mentions={item.mentions} />
        )}
      </div>
      {m && !item.pending ? (
        <div className="chat-msg__actions chat-msg__actions--user">
          <ActionButton end label={copied ? 'Copied' : 'Copy text'} onClick={() => void copy()} icon={copied ? <IconCheck size={14} /> : <IconCopy size={14} />} />
          {recipe ? null : <ActionButton end label="Edit" onClick={() => onEdit(m)} icon={<IconEdit size={14} />} />}
          <ActionButton end label="Resend" onClick={() => onResend(m)} icon={<IconResend size={14} />} />
          {item.text.trim().startsWith('/') ? null : (
            <ActionButton
              end
              label="Save as recipe"
              icon={<IconBookmark size={14} />}
              onClick={() =>
                openRecipeModal({
                  mode: 'create',
                  draft: {
                    slug: '',
                    config: {
                      instructions: mentionsAsTitles(item.text, item.mentions),
                      makes_artifact: false,
                      examples: [],
                      shared_tab_visible: false
                    },
                    creation_context: m.context
                  }
                })
              }
            />
          )}
        </div>
      ) : null}
    </div>
  )
}

function ActionButton({
  label,
  icon,
  onClick,
  disabled,
  end
}: {
  label: string
  icon: ReactNode
  onClick(): void
  disabled?: boolean
  end?: boolean
}): JSX.Element {
  return (
    <span className={`n-tooltip${end ? ' n-tooltip--end' : ''}`} data-tooltip={label}>
      <button type="button" className="n-icon-btn n-icon-btn--sm chat-act" aria-label={label} disabled={disabled} onClick={onClick}>
        {icon}
      </button>
    </span>
  )
}

// ---------- answers ----------

/** Whether a rewrite panel is still generating (its call says "Rewriting meeting notes..." until then). */
function useRewriteRunning(noteId: string | null, panelId: string | null): boolean {
  const [running, setRunning] = useState(false)
  useEffect(() => {
    if (!noteId || !panelId) return
    let cancelled = false
    window.notula.panels
      .list({ noteId })
      .then((panels) => {
        const p = panels.find((x) => x.id === panelId)
        if (!cancelled) setRunning(!!p && !!p.enhance_started_at && !p.content_edited_at && !p.enhance_failed_at)
      })
      .catch(() => undefined)
    const off = window.notula.enhance.onEvent((e) => {
      if (e.panelId !== panelId) return
      if (e.type === 'done') setRunning(false)
      else if (e.type === 'panel_id' || e.type === 'completion') setRunning(true)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [noteId, panelId])
  return running
}

/** The tools that act on the open note keep their own line: the rewrite runs on, and its panel opens from it. */
const NOTE_EDIT_TOOLS = new Set(['editNote', 'rewriteNote'])

function ToolLine({
  call,
  noteId,
  onOpenPanel
}: {
  call: ChatToolCall
  noteId: string | null
  onOpenPanel?: ((panelId: string) => void) | undefined
}): JSX.Element {
  const panelId = call.name === 'rewriteNote' ? ((call.result as { newPanelId?: string } | null)?.newPanelId ?? null) : null
  const rewriting = useRewriteRunning(noteId, panelId)
  const phase = toolPhase(call, rewriting)
  const line = toolLine(call, phase)
  const openable = panelId && phase === 'done' && onOpenPanel
  const icon =
    phase === 'running' ? (
      <span className="chat-tool__spin" aria-hidden="true" />
    ) : phase === 'failed' ? (
      <IconWarn size={14} />
    ) : phase === 'done' ? (
      call.name.startsWith('search') || call.name === 'listMeetings' || call.name === 'gatherMeetingContext' ? (
        <IconSearchDoc size={14} />
      ) : (
        <IconCheck size={14} />
      )
    ) : (
      <IconTool size={14} />
    )
  return (
    <div className={`chat-tool chat-tool--${phase}`}>
      {openable ? (
        <button type="button" className="chat-tool__line chat-tool__line--link" onClick={() => onOpenPanel(panelId)} title="Open the rewritten summary">
          {icon}
          <span>{line}</span>
        </button>
      ) : (
        <div className="chat-tool__line" title={phase === 'failed' && call.error ? call.error : undefined}>
          {icon}
          <span>{line}</span>
        </div>
      )}
    </div>
  )
}

function Sources({ sources }: { sources: NonNullable<AssistantView['sources']> }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const docs = Object.values(sources.scannedDocuments)
  const n = docs.length || sources.totalSources
  if (n === 0) return null
  return (
    <div className="chat-sources">
      <button type="button" className="chat-sources__toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <IconSearchDoc size={13} />
        Searched {n} note{n === 1 ? '' : 's'}
      </button>
      {open ? (
        <ul className="chat-sources__list">
          {docs.map((d) => (
            <li key={d.id}>
              <button type="button" className="chat-sources__doc" onClick={() => navigate(`/meeting/${encodeURIComponent(d.id)}`)}>
                {d.title || 'Untitled note'}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function LimitNote({ limit }: { limit: ContextLimit }): JSX.Element {
  const n = limit.filtered.length
  return (
    <p className="chat-limit">
      {/* The context-limit note, counted in notes. */}
      Only {n} note{n === 1 ? '' : 's'} fit in this answer.
      {limit.unavailable.length ? ` Left out: ${limit.unavailable.join(', ')}.` : ''}
    </p>
  )
}

function AssistantMessage({
  view,
  isLast,
  noteId,
  onShowInTranscript,
  onOpenPanel,
  onResend,
  onSayMore,
  onApproval,
  edits
}: {
  view: AssistantView
  isLast: boolean
  noteId: string | null
  onShowInTranscript?: ((quote: string) => void) | undefined
  onOpenPanel?: ((panelId: string) => void) | undefined
  onResend(m: ChatMessage): void
  onSayMore(): void
  onApproval(a: AssistantView, call: ChatToolCall, decision: ApprovalDecision): void
  edits: EditControls | null
}): JSX.Element {
  // Tool cards registered in app/slots.ts (the draft blocks) replace the default step line.
  useSlotsVersion()
  const ref = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState<'text' | 'image' | null>(null)
  const streaming = view.status === 'streaming'

  // Citation chips are numbered across the whole message.
  const cite = useMemo((): CitationRendering => {
    const keys: string[] = []
    const keyOf = (c: ChatCitation): string => `${c.meeting_id}|${c.source_kind}|${c.source_quote ?? ''}`
    for (const o of view.outputs) {
      if (o.type !== 'cited_text') continue
      for (const l of o.answer_lines) for (const c of l.citations) if (!keys.includes(keyOf(c))) keys.push(keyOf(c))
    }
    return {
      number: (c) => keys.indexOf(keyOf(c)) + 1,
      title: (c) => {
        const title = (c.meeting_id && view.sources?.scannedDocuments[c.meeting_id]?.title) || 'A note'
        return c.source_quote ? `${title} — “${c.source_quote}”` : title
      },
      onOpen: (c) => {
        if (!c.meeting_id) return
        const quote = c.source_kind === 'transcript' ? c.source_quote : null
        if (quote && c.meeting_id === noteId && onShowInTranscript) {
          // "Show in transcript" after 100 ms.
          setTimeout(() => onShowInTranscript(quote), 100)
          return
        }
        if (c.meeting_id === noteId) return
        navigate(`/meeting/${encodeURIComponent(c.meeting_id)}${quote ? `?reveal=${encodeURIComponent(quote)}` : ''}`)
      }
    }
  }, [view.outputs, view.sources, noteId, onShowInTranscript])

  const editCalls = view.outputs
    .filter((o): o is Extract<ChatOutput, { type: 'tool_call' }> => o.type === 'tool_call' && o.tool_call.name === 'editNote')
    .map((o) => o.tool_call)
  const lastEdit = editCalls[editCalls.length - 1] ?? null
  const hasText = view.outputs.some((o) => (o.type === 'text' && o.text.trim()) || (o.type === 'cited_text' && o.plain_text.trim()))
  const hasCalls = view.outputs.some((o) => o.type === 'tool_call')
  const last = view.outputs[view.outputs.length - 1]
  const waiting = view.outputs.some((o) => o.type === 'tool_call' && o.tool_call.approval?.status === 'pending')
  // In a one-note chat, "Searched 1 note" about that same note says nothing.
  const showSources =
    !!view.sources && !(noteId && Object.keys(view.sources.scannedDocuments).every((id) => id === noteId))
  const thinking = streaming && (!last || (last.type === 'tool_call' && (last.tool_call.completed || !!last.tool_call.error)))

  const copyText = async (): Promise<void> => {
    await window.notula.clipboard.writeText({ text: answerText(view.outputs) })
    setCopied('text')
    setTimeout(() => setCopied(null), 1_500)
  }
  const copyImage = async (): Promise<void> => {
    const r = ref.current?.querySelector('.chat-msg__body')?.getBoundingClientRect()
    if (!r) return
    try {
      await window.notula.clipboard.writeImageRect({
        rect: { x: Math.max(0, Math.floor(r.left) - 8), y: Math.max(0, Math.floor(r.top) - 8), width: Math.ceil(r.width) + 16, height: Math.ceil(r.height) + 16 }
      })
      setCopied('image')
      setTimeout(() => setCopied(null), 1_500)
    } catch {
      showToast({ title: 'Couldn’t copy the image. It may have been deleted.', kind: 'error' })
    }
  }

  let lineOffset = 0
  // Consecutive ordinary calls fold into one group; the group is keyed by its first call.
  const segments: ({ kind: 'output'; o: ChatOutput; i: number } | { kind: 'group'; calls: ChatToolCall[] })[] = []
  view.outputs.forEach((o, i) => {
    if (
      o.type === 'tool_call' &&
      o.tool_call.shownInChat &&
      !standalone(o.tool_call) &&
      !NOTE_EDIT_TOOLS.has(o.tool_call.name) &&
      !toolCardFor(o.tool_call.name)
    ) {
      const last = segments[segments.length - 1]
      if (last?.kind === 'group') last.calls.push(o.tool_call)
      else segments.push({ kind: 'group', calls: [o.tool_call] })
      return
    }
    segments.push({ kind: 'output', o, i })
  })
  return (
    <div className={`chat-msg chat-msg--assistant${streaming ? ' is-streaming' : ''}`} ref={ref}>
      <div className="chat-msg__body">
        {segments.map((seg) => {
          if (seg.kind === 'group') return <StepGroup key={`g-${seg.calls[0]?.id ?? ''}`} calls={seg.calls} />
          const { o, i } = seg
          if (o.type === 'tool_call') {
            if (!o.tool_call.shownInChat) return null
            const Card = toolCardFor(o.tool_call.name)
            if (Card && view.threadId) {
              return <Card key={`c-${o.tool_call.id}`} threadId={view.threadId} messageId={view.id} toolCall={o.tool_call} />
            }
            return (
              <StandaloneStep
                key={`t-${o.tool_call.id}`}
                call={o.tool_call}
                onApproval={(d) => onApproval(view, o.tool_call, d)}
                {...(NOTE_EDIT_TOOLS.has(o.tool_call.name)
                  ? { renderLine: (call: ChatToolCall) => <ToolLine call={call} noteId={noteId} onOpenPanel={onOpenPanel} /> }
                  : {})}
              />
            )
          }
          if (o.type === 'text') {
            const md = stripKeys(o.text, streaming)
            return md.trim() ? <MarkdownView key={`x-${i}`} markdown={md} /> : null
          }
          if (o.type === 'cited_text') {
            const offset = o.answer_lines[0]?.line_index ?? lineOffset
            lineOffset = offset + o.answer_lines.length
            const citations = o.answer_lines.flatMap((l) => l.citations)
            return o.plain_text.trim() ? (
              <MarkdownView key={`c-${i}`} markdown={o.plain_text} citations={citations} lineOffset={offset} cite={cite} />
            ) : null
          }
          return null
        })}
        {thinking ? (
          <div className="chat-thinking" aria-label="Thinking">
            <span />
            <span />
            <span />
          </div>
        ) : null}
      </div>
      {view.error ? (
        <div className="chat-msg__error" role="alert">
          <IconWarn size={14} />
          <span>{view.error}</span>
          {view.user ? (
            <button type="button" className="n-btn n-btn--ghost n-btn--sm" onClick={() => view.user && onResend(view.user)}>
              Resend
            </button>
          ) : null}
        </div>
      ) : null}
      {!streaming && showSources && view.sources ? <Sources sources={view.sources} /> : null}
      {view.limit ? <LimitNote limit={view.limit} /> : null}
      {!streaming && lastEdit && edits ? (
        <div className="chat-edits">
          {lastEdit.error && !lastEdit.reverted ? (
            view.user ? (
              <button type="button" className="n-btn n-btn--sm" disabled={edits.busy} onClick={() => view.user && onResend(view.user)}>
                <IconResend size={13} />
                Retry
              </button>
            ) : null
          ) : lastEdit.reverted ? (
            <button type="button" className="n-btn n-btn--sm" disabled={edits.busy} onClick={() => edits.reapply(view)}>
              <IconRedo size={13} />
              Reapply
            </button>
          ) : lastEdit.completed ? (
            <button type="button" className="n-btn n-btn--sm" disabled={edits.busy} onClick={() => edits.undo(view)}>
              <IconUndo size={13} />
              Undo
            </button>
          ) : null}
        </div>
      ) : null}
      {!streaming && !waiting && (hasText || hasCalls) ? (
        <div className="chat-msg__actions">
          <ActionButton
            label={copied === 'text' ? 'Copied' : 'Copy response'}
            onClick={() => void copyText()}
            icon={copied === 'text' ? <IconCheck size={14} /> : <IconCopy size={14} />}
            disabled={!hasText}
          />
          <ActionButton
            label={copied === 'image' ? 'Copied' : 'Copy as image'}
            onClick={() => void copyImage()}
            icon={copied === 'image' ? <IconCheck size={14} /> : <IconImage size={14} />}
          />
        </div>
      ) : null}
      {isLast && view.status === 'completed' && !waiting && (hasText || hasCalls) ? (
        <div className="chat-followups">
          <button type="button" className="chat-chip" onClick={onSayMore}>
            Say more
          </button>
        </div>
      ) : null}
    </div>
  )
}

