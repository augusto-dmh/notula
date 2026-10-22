// SPDX-License-Identifier: Apache-2.0
// The full-screen chat (`/chat`, `/chat/:threadId`): every
// thread on the left in date groups, the selected conversation on the right. `/chat`
// selects under the `global` key (auto-select); a thread of another place
// (a note, a folder) continues in that place.

import { useEffect, useMemo, useState, type JSX } from 'react'
import type { ChatPlace, ChatThread } from '@shared/types/chat'
import { IconSparkle } from '../../app/icons'
import { navigate } from '../../app/navigation'
import { isMac } from '../../app/platform'
import { ChatSurfaceView } from './ChatSurface'
import { IconCompose } from './icons'
import { ALL_KEYS, autoSelect, loadList, loadThread, selectThread, takePageAsk, useChat } from './store'
import { ThreadList } from './ThreadList'

const SURFACE_ID = 'fullscreen'
export const NEW_CHAT_SHORTCUT = isMac ? '⌘ N' : 'Ctrl N'

/** The place a thread belongs to, from its grouping key (search keys continue as library chat). */
export function placeFromKey(key: string | null): ChatPlace {
  if (key?.startsWith('meeting:')) return { kind: 'meeting', noteId: key.slice('meeting:'.length) }
  if (key?.startsWith('list:')) return { kind: 'list', folderId: key.slice('list:'.length) }
  return { kind: 'global' }
}

/** Note titles for `meeting:<id>` threads; null = the note is gone ("Note deleted"). */
const noteTitles = new Map<string, string | null>()

function useNoteTitles(threads: ChatThread[] | undefined): Map<string, string | null> {
  const [, setVersion] = useState(0)
  useEffect(() => {
    const ids = [
      ...new Set(
        (threads ?? [])
          .map((t) => (t.grouping_key?.startsWith('meeting:') ? t.grouping_key.slice(8) : null))
          .filter((id): id is string => !!id && !noteTitles.has(id))
      )
    ]
    if (ids.length === 0) return
    let cancelled = false
    void Promise.all(
      ids.map((id) =>
        window.notula.notes
          .get({ id })
          .then((n) => noteTitles.set(id, n && !n.deleted_at ? n.title?.trim() || n.linked_event?.summary?.trim() || 'Untitled note' : null))
          .catch(() => noteTitles.set(id, null))
      )
    ).then(() => {
      if (!cancelled) setVersion((v) => v + 1)
    })
    return () => {
      cancelled = true
    }
  }, [threads])
  return noteTitles
}

export function placeLabel(t: ChatThread, titles: Map<string, string | null>): string | null {
  const key = t.grouping_key
  if (!key || key === 'global') return null
  if (key.startsWith('meeting:')) {
    const title = titles.get(key.slice(8))
    return title === undefined ? 'Note' : title === null ? 'Note deleted' : title
  }
  if (key.startsWith('list:')) return 'Folder'
  if (key.startsWith('search')) return 'Search'
  return null
}

export function ChatPageView({ threadId }: { threadId: string | null }): JSX.Element {
  const all = useChat((s) => s.lists.get(ALL_KEYS))
  const globalList = useChat((s) => s.lists.get('global'))
  const globalSel = useChat((s) => s.selection.get('global'))
  const pageAsk = useChat((s) => s.pageAsk)
  const [focusNonce, setFocusNonce] = useState(0)
  const titles = useNoteTitles(all)

  useEffect(() => {
    void loadList(ALL_KEYS)
    void loadList('global')
  }, [])
  useEffect(() => {
    if (!threadId && !pageAsk) autoSelect('global')
  }, [threadId, globalList, pageAsk])

  const selectedId = threadId ?? globalSel ?? null
  const detail = useChat((s) => (selectedId ? s.details.get(selectedId) : undefined))
  useEffect(() => {
    if (selectedId) void loadThread(selectedId)
  }, [selectedId])

  const thread = selectedId ? (detail?.thread ?? all?.find((t) => t.id === selectedId) ?? null) : null
  const place = useMemo(() => placeFromKey(thread?.grouping_key ?? 'global'), [thread?.grouping_key])
  const missing = !!threadId && detail === null

  const newChat = (): void => {
    selectThread('global', null)
    setFocusNonce(Date.now())
    navigate('/chat')
  }

  const open = (t: ChatThread): void => {
    if (t.grouping_key === 'global') selectThread('global', t.id)
    navigate(`/chat/${encodeURIComponent(t.id)}`)
  }

  const label = thread ? placeLabel(thread, titles) : null
  return (
    <div className="chat-page">
      <aside className="chat-page__side" aria-label="Chats">
        <div className="chat-page__side-head">
          <h1 className="chat-page__heading">Chat</h1>
          <span className="n-tooltip n-tooltip--end" data-tooltip={`New chat  ${NEW_CHAT_SHORTCUT}`}>
            <button type="button" className="n-icon-btn" aria-label="New chat" onClick={newChat}>
              <IconCompose size={17} />
            </button>
          </span>
        </div>
        <div className="chat-page__side-list">
          {all === undefined ? (
            <div className="chat-page__side-loading">
              <span className="n-spinner" />
            </div>
          ) : (
            <ThreadList
              variant="page"
              threads={all}
              selectedId={selectedId}
              subtitle={(t) => placeLabel(t, titles)}
              onSelect={open}
              onDeleted={(t, ordered) => {
                if (t.id !== selectedId) return
                const next = ordered[0]?.id === t.id ? ordered[1] : ordered[0]
                selectThread('global', next && next.grouping_key === 'global' ? next.id : null)
                navigate(next ? `/chat/${encodeURIComponent(next.id)}` : '/chat', { replace: true })
              }}
              empty="Your chats will show here."
            />
          )}
        </div>
      </aside>
      <section className="chat-page__main">
        {thread ? (
          <header className="chat-page__head">
            <span className="chat-page__title">{thread.title?.trim() || 'New chat'}</span>
            {label ? (
              <button
                type="button"
                className="chat-page__place"
                disabled={label === 'Note deleted' || place.kind !== 'meeting'}
                onClick={() => place.kind === 'meeting' && navigate(`/meeting/${encodeURIComponent(place.noteId)}`)}
              >
                {label}
              </button>
            ) : null}
          </header>
        ) : null}
        {missing ? (
          <div className="chat-page__missing">
            <p>This chat no longer exists.</p>
            <button type="button" className="n-btn n-btn--sm" onClick={newChat}>
              New chat
            </button>
          </div>
        ) : (
          <ChatSurfaceView
            key={selectedId ?? 'new'}
            surfaceId={SURFACE_ID}
            surface="fullscreen"
            place={place}
            threadId={selectedId}
            fullscreen
            autoFocus
            focusNonce={focusNonce}
            onNewThread={(id) => navigate(`/chat/${encodeURIComponent(id)}`, { replace: true })}
            onNewChat={newChat}
            pending={pageAsk}
            onPendingTaken={takePageAsk}
            empty={
              <div className="chat-hero">
                <span className="chat-hero__mark">
                  <IconSparkle size={22} />
                </span>
                <h2 className="chat-hero__title">Ask about your meetings</h2>
                <p className="chat-hero__text">Answers come from your notes and transcripts, through your own AI provider.</p>
              </div>
            }
          />
        )}
      </section>
    </div>
  )
}
