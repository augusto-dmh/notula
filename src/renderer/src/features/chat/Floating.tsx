// SPDX-License-Identifier: Apache-2.0
// The floating chat (21–22), the folder and search
// pages' chat input, and `askChat`. The floating chat lives in the
// main window: a launcher on Home, a panel that hosts any place's chat. Opening it
// outside a one-note chat, with messages in the current thread and nothing viewed for
// 2 hours, starts a new thread (`floating-idle-reset`).

import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react'
import { CHAT_LIMITS, groupingKeyFor, type ChatPlace, type ChatThread } from '@shared/types/chat'
import { IconClose, IconSparkle } from '../../app/icons'
import { currentRoute, navigate, useRoute } from '../../app/navigation'
import { debugLog } from '../../app/platform'
import { ChatSurfaceView } from './ChatSurface'
import { NEW_CHAT_SHORTCUT } from './ChatPage'
import { IconCompose, IconExpand, IconHistory, IconSend } from './icons'
import { Popover } from './Popover'
import {
  askNote,
  askPage,
  autoSelect,
  closeFloating,
  getChatState,
  loadList,
  loadThread,
  markViewed,
  mountedNotePanels,
  openFloating,
  selectThread,
  takeFloatingPending,
  useChat,
  viewedAt
} from './store'
import { ThreadList } from './ThreadList'

const SURFACE_ID = 'floating'

export function FloatingChatView(): JSX.Element | null {
  const route = useRoute()
  const floating = useChat((s) => s.floating)
  const key = groupingKeyFor(floating.place)
  const list = useChat((s) => s.lists.get(key))
  const selected = useChat((s) => s.selection.get(key))
  const threadId = selected ?? null
  const thread = useChat((s) => (threadId ? (s.details.get(threadId)?.thread ?? null) : null))
  const [recentOpen, setRecentOpen] = useState(false)
  const [focusNonce, setFocusNonce] = useState(0)
  const recentAnchor = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (floating.open) void loadList(key)
  }, [floating.open, key])
  useEffect(() => {
    if (floating.open && !floating.pending) autoSelect(key)
  }, [floating.open, key, list])
  useEffect(() => {
    if (threadId) void loadThread(threadId)
  }, [threadId])

  // The 2-hour auto-clear, checked when the floating chat opens.
  useEffect(() => {
    if (!floating.open) return
    const s = getChatState()
    const sel = s.selection.get(key)
    const viewed = viewedAt('floating', key)
    if (floating.place.kind !== 'meeting' && sel && viewed !== null && Date.now() - viewed > CHAT_LIMITS.floatingAutoClearMs) {
      const messages = s.details.get(sel)?.messages ?? []
      if (messages.length > 0 || (s.lists.get(key) ?? []).some((t) => t.id === sel)) {
        debugLog('chat-thread-started', { source: 'floating-idle-reset' })
        selectThread(key, null)
      }
    }
    markViewed('floating', key)
    setFocusNonce(Date.now())
    return () => markViewed('floating', key)
  }, [floating.open, key])

  useEffect(() => {
    if (!floating.open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (!panel.current?.contains(document.activeElement)) return
      closeFloating()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [floating.open])

  const onChat = route.path === '/chat' || route.path.startsWith('/chat/')
  if (onChat || route.path.startsWith('/settings') || route.path === '/permissions') return null

  if (!floating.open) {
    if (route.path !== '/') return null
    return (
      <button type="button" className="chat-launcher chat-launcher--floating" onClick={() => openFloating({ kind: 'global' })}>
        <IconSparkle size={15} />
        <span>Ask anything</span>
      </button>
    )
  }

  const newChat = (): void => {
    selectThread(key, null)
    setFocusNonce(Date.now())
  }
  const title = thread?.title?.trim() || (threadId ? 'Chat' : 'New chat')
  return (
    <div className="chat-floating" ref={panel} role="dialog" aria-label="Chat">
      <header className="chat-panel__head">
        <span className="chat-panel__title" title={title}>
          {title}
        </span>
        <span className="chat-panel__tools">
          <span className="n-tooltip" data-tooltip="Recent chats">
            <button
              ref={recentAnchor}
              type="button"
              className="n-icon-btn n-icon-btn--sm"
              aria-label="Recent chats"
              aria-haspopup="menu"
              aria-expanded={recentOpen}
              onClick={() => setRecentOpen((o) => !o)}
            >
              <IconHistory size={15} />
            </button>
          </span>
          <span className="n-tooltip" data-tooltip={`New chat  ${NEW_CHAT_SHORTCUT}`}>
            <button type="button" className="n-icon-btn n-icon-btn--sm" aria-label="New chat" onClick={newChat}>
              <IconCompose size={15} />
            </button>
          </span>
          <span className="n-tooltip" data-tooltip="Open in Chat">
            <button
              type="button"
              className="n-icon-btn n-icon-btn--sm"
              aria-label="Open in Chat"
              onClick={() => {
                closeFloating()
                navigate(threadId ? `/chat/${encodeURIComponent(threadId)}` : '/chat')
              }}
            >
              <IconExpand size={14} />
            </button>
          </span>
          <span className="n-tooltip n-tooltip--end" data-tooltip="Close">
            <button type="button" className="n-icon-btn n-icon-btn--sm" aria-label="Close chat" onClick={closeFloating}>
              <IconClose size={15} />
            </button>
          </span>
        </span>
        <Popover anchor={recentAnchor} open={recentOpen} onClose={() => setRecentOpen(false)} align="end" label="Recent chats" className="chat-recent">
          <ThreadList
            variant="menu"
            threads={list ?? []}
            selectedId={threadId}
            onSelect={(t: ChatThread) => {
              selectThread(key, t.id)
              setRecentOpen(false)
            }}
            onDeleted={(t, ordered) => {
              if (t.id !== threadId) return
              const next = ordered[0]?.id === t.id ? ordered[1] : ordered[0]
              selectThread(key, next?.id ?? null)
            }}
          />
        </Popover>
      </header>
      <ChatSurfaceView
        surfaceId={SURFACE_ID}
        surface="floating"
        place={floating.place}
        threadId={threadId}
        compact
        autoFocus
        focusNonce={focusNonce}
        onNewChat={newChat}
        pending={floating.pending}
        onPendingTaken={takeFloatingPending}
        empty={
          <div className="chat-hero chat-hero--small">
            <span className="chat-hero__mark">
              <IconSparkle size={18} />
            </span>
            <p className="chat-hero__text">
              {floating.place.kind === 'meeting' ? 'Ask about this meeting.' : floating.place.kind === 'list' ? 'Ask about the notes in this folder.' : 'Ask about your meetings.'}
            </p>
          </div>
        }
      />
    </div>
  )
}

/** The folder and search pages' header input: the question opens in the floating chat. */
export function ListChatInputView({ place }: { place: ChatPlace }): JSX.Element {
  const [text, setText] = useState('')
  const submit = (e: FormEvent): void => {
    e.preventDefault()
    const q = text.trim()
    if (!q) return
    selectThread(groupingKeyFor(place), null)
    openFloating(place, q)
    setText('')
  }
  return (
    <form className="chat-list-input" onSubmit={submit}>
      <IconSparkle size={15} />
      <input
        className="chat-list-input__field"
        value={text}
        placeholder={place.kind === 'list' ? 'Ask about this folder' : 'Ask anything'}
        aria-label={place.kind === 'list' ? 'Ask about this folder' : 'Ask about these notes'}
        onChange={(e) => setText(e.target.value)}
      />
      <button type="submit" className="chat-list-input__send" aria-label="Ask" disabled={!text.trim()}>
        <IconSend size={14} />
      </button>
    </form>
  )
}

/**
 * The palette's "Ask Chat": the note's chat when `noteId` is given (its sidebar when
 * that note is open, else the floating chat), otherwise a new chat on `/chat`.
 */
export function askChatImpl(opts: { text: string; noteId?: string | null }): void {
  const text = opts.text.trim()
  if (opts.noteId) {
    const onNote = currentRoute().path === `/meeting/${opts.noteId}`
    if (onNote && mountedNotePanels.has(opts.noteId)) {
      askNote(opts.noteId, text)
      return
    }
    const place: ChatPlace = { kind: 'meeting', noteId: opts.noteId }
    selectThread(groupingKeyFor(place), null)
    openFloating(place, text)
    return
  }
  selectThread('global', null)
  if (text) askPage(text)
  navigate('/chat')
}
