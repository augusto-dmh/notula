// SPDX-License-Identifier: Apache-2.0
// The note page's chat: a sidebar on the right of the note,
// grouped under `meeting:<noteId>` so each note keeps its own threads. It acts on the
// editor the page shows (the summary or the user's notes; none on the transcript tab),
// carries the editor's selection ("Chat with selected text") and Quick edit, and
// opens from a small launcher in the note's corner. One-note chats never auto-clear.

import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { groupingKeyFor, type ChatPlace, type ChatThread } from '@shared/types/chat'
import { IconClose, IconSparkle } from '../../app/icons'
import { navigate } from '../../app/navigation'
import { ChatSurfaceView } from './ChatSurface'
import { NEW_CHAT_SHORTCUT } from './ChatPage'
import { IconCompose, IconExpand, IconHistory } from './icons'
import type { NoteChatPanelProps } from './index'
import { Popover } from './Popover'
import { autoSelect, loadList, loadThread, markViewed, mountedNotePanels, selectThread, takeNoteAsk, useChat } from './store'
import { ThreadList } from './ThreadList'

export function NoteChatPanelView(p: NoteChatPanelProps): JSX.Element | null {
  const place = useMemo((): ChatPlace => ({ kind: 'meeting', noteId: p.noteId }), [p.noteId])
  const key = groupingKeyFor(place)
  const surfaceId = `note:${p.noteId}`
  const list = useChat((s) => s.lists.get(key))
  const selected = useChat((s) => s.selection.get(key))
  const noteAsk = useChat((s) => s.noteAsk)
  const threadId = selected ?? null
  const thread = useChat((s) => (threadId ? (s.details.get(threadId)?.thread ?? null) : null))
  const [selection, setSelection] = useState<string | null>(null)
  const [editWithAi, setEditWithAi] = useState(false)
  const [focusNonce, setFocusNonce] = useState(0)
  const [recentOpen, setRecentOpen] = useState(false)
  const [pending, setPending] = useState<{ text: string; nonce: number } | null>(null)
  const recentAnchor = useRef<HTMLButtonElement>(null)
  const host = useRef<HTMLSpanElement>(null)
  const [launcherHost, setLauncherHost] = useState<HTMLElement | null>(null)

  useEffect(() => {
    mountedNotePanels.add(p.noteId)
    return () => {
      mountedNotePanels.delete(p.noteId)
    }
  }, [p.noteId])

  useEffect(() => {
    void loadList(key)
  }, [key])
  useEffect(() => {
    autoSelect(key)
  }, [key, list])
  useEffect(() => {
    if (threadId) void loadThread(threadId)
  }, [threadId])
  useEffect(() => {
    if (p.open) markViewed('sidebar', key)
  }, [p.open, key])

  // The launcher sits at the end of the note's dock, beside the meeting controls.
  useEffect(() => {
    const body = host.current?.parentElement
    if (!p.open) setLauncherHost((body?.querySelector(':scope > .note-main .note-dock__end') as HTMLElement | null) ?? null)
  }, [p.open])

  // The target editor's selection travels with the next message.
  const editor = p.target?.editor ?? null
  useEffect(() => {
    if (!editor) {
      setSelection(null)
      return
    }
    return editor.subscribeSelection((md) => {
      if (md?.trim()) {
        setSelection(md)
        setEditWithAi(false)
      }
    })
  }, [editor])

  // Quick edit: the selection, marked "edit with AI", in an open panel.
  useEffect(() => {
    if (!p.quickEdit) return
    setSelection(p.quickEdit.selection)
    setEditWithAi(true)
    if (!p.open) p.onOpenChange(true)
    setFocusNonce(Date.now())
  }, [p.quickEdit?.nonce])

  // askChat for this note: open, start a new chat, send.
  useEffect(() => {
    if (!noteAsk || noteAsk.noteId !== p.noteId) return
    takeNoteAsk()
    selectThread(key, null)
    if (!p.open) p.onOpenChange(true)
    setPending({ text: noteAsk.text, nonce: noteAsk.nonce })
  }, [noteAsk?.nonce])

  const newChat = (): void => {
    selectThread(key, null)
    setFocusNonce(Date.now())
  }

  const binding = {
    noteId: p.noteId,
    target: p.target,
    transcribing: p.transcribing,
    selection,
    editWithAi,
    clearSelection: () => {
      setSelection(null)
      setEditWithAi(false)
    },
    onShowInTranscript: p.onShowInTranscript,
    onOpenPanel: p.onOpenPanel
  }

  if (!p.open) {
    const launcher = (
      <button
        type="button"
        className="chat-launcher chat-launcher--note"
        onClick={() => {
          p.onOpenChange(true)
          setFocusNonce(Date.now())
        }}
      >
        <IconSparkle size={15} />
        <span>Ask about this meeting</span>
      </button>
    )
    return (
      <>
        <span ref={host} hidden />
        {launcherHost ? createPortal(launcher, launcherHost) : null}
      </>
    )
  }

  const title = thread?.title?.trim() || (threadId ? 'Chat' : 'New chat')
  return (
    <aside className="chat-note-panel" aria-label="Chat about this meeting">
      <span ref={host} hidden />
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
          {threadId ? (
            <span className="n-tooltip" data-tooltip="Open in Chat">
              <button type="button" className="n-icon-btn n-icon-btn--sm" aria-label="Open in Chat" onClick={() => navigate(`/chat/${encodeURIComponent(threadId)}`)}>
                <IconExpand size={14} />
              </button>
            </span>
          ) : null}
          <span className="n-tooltip n-tooltip--end" data-tooltip="Close">
            <button type="button" className="n-icon-btn n-icon-btn--sm" aria-label="Close chat" onClick={() => p.onOpenChange(false)}>
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
            empty="No chats about this meeting yet."
          />
        </Popover>
      </header>
      <ChatSurfaceView
        surfaceId={surfaceId}
        surface="sidebar"
        place={place}
        threadId={threadId}
        note={binding}
        compact
        autoFocus
        focusNonce={focusNonce}
        onNewChat={newChat}
        pending={pending}
        onPendingTaken={() => setPending(null)}
        empty={
          <div className="chat-hero chat-hero--small">
            <span className="chat-hero__mark">
              <IconSparkle size={18} />
            </span>
            <p className="chat-hero__text">
              Ask about this meeting{p.target ? ', or ask for changes to the ' + (p.target.kind === 'summary' ? 'summary' : 'notes') : ''}.
            </p>
          </div>
        }
      />
    </aside>
  )
}
