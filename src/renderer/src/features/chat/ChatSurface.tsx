// SPDX-License-Identifier: Apache-2.0
// One chat surface's body (shared by the full-screen chat, the note sidebar and the
// floating chat): the conversation, the composer with its placeholder ladder, sending,
// Stop, Edit and Resend, "Say more", approvals, recipe suggestions for an empty chat, and
// the "no tools" notice.

import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from 'react'
import type { ChatEditorTarget, ChatMessage, ChatPlace, ChatSurface as Surface, ChatToolCall, DocRef } from '@shared/types/chat'
import type { Recipe, RecipeView } from '@shared/types/recipes'
import { isMod } from '../../app/platform'
import type { EditorHandle } from '../../editor/types'
import { allowedIn, recipeDisplayName } from '../recipes'
import { getPrefs } from '../settings/prefs-store'
import { Composer, type ComposerSubmit } from './Composer'
import { Conversation, type AssistantView, type EditControls } from './Conversation'
import type { ApprovalDecision } from './ToolSteps'
import { followEdits, replayEdits } from './edits'
import { IconClose } from '../../app/icons'
import type { NoteChatPanelProps } from './index'
import { getChatState, sendChat, stopThread, streamingIn, useChat } from './store'
import { EXAMPLE_PROMPTS, mentionsAsTitles, messageMentions } from './util'

/** A one-note chat's link to the note page. */
export interface NoteBinding {
  noteId: string
  target: NoteChatPanelProps['target']
  transcribing: boolean
  selection: string | null
  editWithAi: boolean
  clearSelection(): void
  onShowInTranscript(quote: string): void
  onOpenPanel(panelId: string): void
}

interface Props {
  surfaceId: string
  surface: Surface
  place: ChatPlace
  threadId: string | null
  /** A new thread was created by this surface's first send. */
  onNewThread?(threadId: string): void
  /** Mod+N while the surface has focus. */
  onNewChat?(): void
  note?: NoteBinding | null
  empty: ReactNode
  fullscreen?: boolean
  compact?: boolean
  /** Text to send as soon as the surface shows (askChat, list headers, and quick ask with its own surface). */
  pending?: { text: string; nonce: number; surface?: Surface } | null
  onPendingTaken?(): void
  focusNonce?: number
  autoFocus?: boolean
}

let libraryHasNotes: boolean | null = null

/** Whether the library has any note (an empty library disables library chat). */
function useLibraryHasNotes(enabled: boolean): boolean {
  const [has, setHas] = useState(libraryHasNotes ?? true)
  useEffect(() => {
    if (!enabled || libraryHasNotes === true) return
    let cancelled = false
    window.notula.notes
      .list({ scope: 'own', limit: 1 })
      .then((page) => {
        libraryHasNotes = page.items.length > 0
        if (!cancelled) setHas(libraryHasNotes)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [enabled])
  return has
}

function RecipeSuggestions({ view, onRun, onSeeAll }: { view: RecipeView; onRun(r: Recipe): void; onSeeAll(): void }): JSX.Element | null {
  const [recipes, setRecipes] = useState<Recipe[] | null>(null)
  useEffect(() => {
    let cancelled = false
    window.notula.recipes
      .list()
      .then((list) => {
        if (!cancelled) setRecipes(list)
      })
      .catch(() => setRecipes([]))
    return () => {
      cancelled = true
    }
  }, [])
  const picks = useMemo(() => {
    if (!recipes) return []
    const allowed = recipes.filter((r) => allowedIn(r, view))
    const recent = getPrefs()?.['recipes.recent']?.[view] ?? []
    const ranked = [
      ...recent.map((id) => allowed.find((r) => r.id === id)).filter((r): r is Recipe => !!r),
      ...allowed.filter((r) => !recent.includes(r.id))
    ]
    return ranked.slice(0, 3)
  }, [recipes, view])
  if (picks.length === 0) return null
  return (
    <div className="chat-suggest">
      {picks.map((r) => (
        <button key={r.id} type="button" className="chat-chip" title={r.config.description ?? undefined} onClick={() => onRun(r)}>
          /{recipeDisplayName(r.slug)}
        </button>
      ))}
      <button type="button" className="chat-chip chat-chip--ghost" onClick={onSeeAll}>
        See all
      </button>
    </div>
  )
}

export function ChatSurfaceView(p: Props): JSX.Element {
  const note = p.note ?? null
  const streamingAnswer = useChat((s) => streamingIn(s, p.threadId, p.surfaceId))
  const detail = useChat((s) => (p.threadId ? s.details.get(p.threadId) : undefined))
  const liveMap = useChat((s) => s.live)
  const [editing, setEditing] = useState<ChatMessage | null>(null)
  const [prefill, setPrefill] = useState<{ text: string; nonce: number; mentions?: DocRef[] } | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [sentNonce, setSentNonce] = useState(0)
  const [editBusy, setEditBusy] = useState(false)
  // A new chat's files wait under this id until the first send creates the thread.
  const [draftId, setDraftId] = useState(() => crypto.randomUUID())
  const example = useMemo(() => EXAMPLE_PROMPTS[Math.floor(Math.random() * EXAMPLE_PROMPTS.length)] ?? 'Ask anything', [])
  const targetRef = useRef(note?.target ?? null)
  targetRef.current = note?.target ?? null

  const library = p.place.kind === 'global'
  const hasNotes = useLibraryHasNotes(library)
  const messages = detail?.messages ?? []
  const hasMessages = messages.length > 0 || [...liveMap.values()].some((l) => (p.threadId ? l.threadId === p.threadId : l.surfaceId === p.surfaceId && !l.threadId))
  const disabledReason =
    (library && !hasNotes) || (p.place.kind === 'search' && p.place.documentIds.length === 0) ? 'No notes to chat about here.' : null
  const streaming = !!streamingAnswer

  const placeholder =
    disabledReason ??
    (streaming
      ? 'Replying...'
      : note?.selection
        ? 'Chat with selected text'
        : hasMessages
          ? 'Continue chat'
          : p.place.kind === 'list'
            ? 'Ask about this folder'
            : p.fullscreen
              ? example
              : 'Ask anything')

  // The "no tools" notice follows the latest answer of the thread.
  const noTools = useMemo(() => {
    const live = [...liveMap.values()].filter((l) => l.threadId === p.threadId && l.meta).sort((a, b) => b.startedAt - a.startedAt)[0]
    if (live?.meta) return live.meta.noTools
    const last = [...messages].reverse().find((m) => m.role === 'assistant')
    return !!(last?.sources as { meta?: { noTools?: boolean } } | null)?.meta?.noTools
  }, [liveMap, messages, p.threadId])
  const notice = noTools
    ? note
      ? 'Editing notes from chat needs a model with tool support.'
      : 'This model can’t use tools, so answers use only the notes found up front.'
    : null

  /** The current editor for a target captured at send time (null once it is off screen). */
  const editorFor = (t: ChatEditorTarget | null) => (): EditorHandle | null => {
    const cur = targetRef.current
    if (!t || !cur) return null
    if (t.kind !== cur.kind) return null
    if (t.kind === 'summary' && cur.kind === 'summary' && t.panelId !== cur.panelId) return null
    return cur.editor
  }

  const send = async (
    s: ComposerSubmit,
    extra: { responseStyle?: 'default' | 'detailed'; edit?: { messageId: string } | null; surface?: Surface } = {}
  ): Promise<boolean> => {
    setSendError(null)
    const t = note?.target ?? null
    const target: ChatEditorTarget | null = t
      ? t.kind === 'summary'
        ? { kind: 'summary', panelId: t.panelId, markdown: t.editor.getMarkdown() }
        : { kind: 'notes', markdown: t.editor.getMarkdown() }
      : null
    const r = await sendChat({
      surfaceId: p.surfaceId,
      surface: extra.surface ?? p.surface,
      place: p.place,
      threadId: p.threadId,
      text: s.text,
      ...(s.attachmentIds?.length ? { attachmentIds: s.attachmentIds } : {}),
      displayText: s.displayText,
      mentions: s.mentions,
      recipeId: s.recipeId,
      target,
      selectionMarkdown: note?.selection ?? null,
      editWithAi: note?.editWithAi ?? false,
      responseStyle: extra.responseStyle ?? 'default',
      edit: extra.edit ?? (editing ? { messageId: editing.id } : null),
      onRequest: (requestId) => {
        if (target) followEdits(requestId, editorFor(target))
      }
    })
    if (!r.ok) {
      setSendError(r.error)
      return false
    }
    note?.clearSelection()
    setEditing(null)
    setSentNonce((n) => n + 1)
    if (!p.threadId) setDraftId(crypto.randomUUID())
    if (!p.threadId) p.onNewThread?.(r.accepted.threadId)
    return true
  }

  const resend = (m: ChatMessage): void => {
    // The resent message keeps its files (main reuses the edited message's attachments).
    void send({ text: m.raw_text, displayText: m.raw_text, mentions: messageMentions(m), recipeId: null }, { edit: { messageId: m.id } })
  }

  const approve = (a: AssistantView, call: ChatToolCall, d: ApprovalDecision): void => {
    if (!call.approval || !a.threadId) return
    void sendChat({
      surfaceId: p.surfaceId,
      surface: p.surface,
      place: p.place,
      threadId: a.threadId,
      text: '',
      approval: {
        assistantMessageId: a.id,
        toolCallId: call.id,
        approvalId: call.approval.id,
        status: d.status,
        reason: d.reason,
        ...(d.args ? { args: d.args } : {})
      },
      baseOutputs: a.outputs
    }).then((r) => {
      if (!r.ok) setSendError(r.error)
    })
  }

  // askChat / list headers: send the pending question once.
  useEffect(() => {
    if (!p.pending) return
    p.onPendingTaken?.()
    void send(
      { text: p.pending.text, displayText: p.pending.text, mentions: [], recipeId: null },
      p.pending.surface ? { surface: p.pending.surface } : {}
    )
  }, [p.pending?.nonce])

  const edits: EditControls | null = note?.target
    ? {
        busy: editBusy,
        undo: (v) => {
          const editor = targetRef.current?.editor
          if (!editor) return
          setEditBusy(true)
          void replayEdits(v, editor, 'undo').finally(() => setEditBusy(false))
        },
        reapply: (v) => {
          const editor = targetRef.current?.editor
          if (!editor) return
          setEditBusy(true)
          void replayEdits(v, editor, 'reapply').finally(() => setEditBusy(false))
        }
      }
    : null

  const recipeView: RecipeView = note ? (note.transcribing ? 'live-meeting' : 'meeting') : 'multi-meeting'

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (p.onNewChat && isMod(e) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
      e.preventDefault()
      e.stopPropagation()
      setEditing(null)
      p.onNewChat()
    }
  }

  const selectionPreview = note?.selection?.replace(/\s+/g, ' ').trim()
  const top = (
    <>
      {editing ? (
        <div className="chat-composer__banner">
          <span>Editing message</span>
          <button
            type="button"
            className="n-btn n-btn--ghost n-btn--sm"
            onClick={() => {
              setEditing(null)
              setPrefill({ text: '', nonce: Date.now() })
            }}
          >
            Cancel
          </button>
        </div>
      ) : null}
      {selectionPreview ? (
        <div className="chat-composer__selection">
          <span className="chat-composer__selection-label">{note?.editWithAi ? 'Quick edit' : 'Selected text'}</span>
          <span className="chat-composer__selection-text">{selectionPreview}</span>
          <button type="button" className="n-icon-btn n-icon-btn--sm" aria-label="Clear selection" onClick={() => note?.clearSelection()}>
            <IconClose size={12} />
          </button>
        </div>
      ) : null}
      {sendError ? (
        <p className="chat-composer__error" role="alert">
          {sendError}
        </p>
      ) : null}
    </>
  )

  return (
    <div className={`chat-surface${p.compact ? ' chat-surface--compact' : ''}${p.fullscreen ? ' chat-surface--full' : ''}`} onKeyDown={onKeyDown}>
      <Conversation
        threadId={p.threadId}
        surfaceId={p.surfaceId}
        noteId={note?.noteId ?? null}
        onShowInTranscript={note?.onShowInTranscript}
        onOpenPanel={note?.onOpenPanel}
        onEditMessage={(m) => {
          setEditing(m)
          setPrefill({ text: mentionsAsTitles(m.raw_text, messageMentions(m)), nonce: Date.now(), mentions: messageMentions(m) })
        }}
        onResend={resend}
        onSayMore={() => void send({ text: 'Can you provide more details', displayText: 'Can you provide more details', mentions: [], recipeId: null }, { responseStyle: 'detailed' })}
        onApproval={approve}
        edits={edits}
        sentNonce={sentNonce}
        empty={
          <div className="chat-empty">
            {p.empty}
            {disabledReason ? null : (
              <RecipeSuggestions
                view={recipeView}
                onRun={(r) => void send({ text: '', displayText: `/${r.slug}`, mentions: [], recipeId: r.id })}
                onSeeAll={() => setPrefill({ text: '/', nonce: Date.now() })}
              />
            )}
          </div>
        }
      />
      <Composer
        placeholder={placeholder}
        disabled={!!disabledReason}
        streaming={streaming}
        modelKind={p.place.kind === 'meeting' ? 'single' : 'multi'}
        recipeView={recipeView}
        onSubmit={(s) => send(s)}
        onStop={() => {
          const l = streamingIn(getChatState(), p.threadId, p.surfaceId)
          if (l?.threadId) void stopThread(l.threadId)
        }}
        prefill={prefill}
        attachParent={p.threadId ?? draftId}
        {...(p.focusNonce !== undefined ? { focusNonce: p.focusNonce } : {})}
        {...(p.autoFocus !== undefined ? { autoFocus: p.autoFocus } : {})}
        top={top}
        notice={notice}
        {...(p.compact !== undefined ? { compact: p.compact } : {})}
      />
    </div>
  )
}
