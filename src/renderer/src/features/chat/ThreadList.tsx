// SPDX-License-Identifier: Apache-2.0
// Thread lists: "Pinned" first, then the date
// groups; each row can be pinned (at most 10), renamed (at most 100 characters) and
// deleted. Used by the full-screen chat and by the "Recent chats" menu.

import { useEffect, useRef, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import { CHAT_LIMITS, type ChatThread } from '@shared/types/chat'
import { showToast } from '../../app/toast'
import { IconMore, IconPin } from './icons'
import { Popover } from './Popover'
import { groupThreads } from './util'

interface Props {
  threads: ChatThread[]
  selectedId: string | null
  onSelect(t: ChatThread): void
  onDeleted(t: ChatThread, grouped: ChatThread[]): void
  /** A second line per row (the full-screen list shows the thread's place). */
  subtitle?: ((t: ChatThread) => string | null) | undefined
  variant: 'page' | 'menu'
  empty?: string
}

export async function setPinned(t: ChatThread, pinned: boolean): Promise<void> {
  try {
    await window.notula.chat.updateThread({ threadId: t.id, patch: { is_pinned: pinned } })
  } catch (err) {
    const p = parseError(err)
    showToast({ title: p.code === 'invalid-input' ? p.message : 'Couldn’t update this chat', kind: 'error' })
  }
}

export function ThreadList({ threads, selectedId, onSelect, onDeleted, subtitle, variant, empty }: Props): JSX.Element {
  const groups = groupThreads(threads)
  const ordered = groups.flatMap((g) => g.threads)
  const [renaming, setRenaming] = useState<string | null>(null)
  if (threads.length === 0) return <p className="chat-threads__empty">{empty ?? 'No chats yet'}</p>
  return (
    <div className={`chat-threads chat-threads--${variant}`}>
      {groups.map((g) => (
        <div key={g.key} className="chat-threads__group">
          <div className="chat-threads__heading">{g.label}</div>
          {g.threads.map((t) => (
            <ThreadRow
              key={t.id}
              thread={t}
              selected={t.id === selectedId}
              renaming={renaming === t.id}
              subtitle={subtitle?.(t) ?? null}
              onSelect={() => onSelect(t)}
              onRename={() => setRenaming(t.id)}
              onRenamed={() => setRenaming(null)}
              onDelete={async () => {
                try {
                  await window.notula.chat.deleteThread({ threadId: t.id })
                  onDeleted(t, ordered)
                } catch (err) {
                  showToast({ title: 'Couldn’t delete this chat', description: parseError(err).message, kind: 'error' })
                }
              }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

function ThreadRow({
  thread,
  selected,
  renaming,
  subtitle,
  onSelect,
  onRename,
  onRenamed,
  onDelete
}: {
  thread: ChatThread
  selected: boolean
  renaming: boolean
  subtitle: string | null
  onSelect(): void
  onRename(): void
  onRenamed(): void
  onDelete(): Promise<void>
}): JSX.Element {
  const [menu, setMenu] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const title = thread.title?.trim() || 'New chat'
  if (renaming) return <RenameField thread={thread} onDone={onRenamed} />
  return (
    <div className={`chat-thread${selected ? ' is-selected' : ''}${menu ? ' has-menu' : ''}`}>
      <button type="button" className="chat-thread__main" aria-current={selected ? 'true' : undefined} onClick={onSelect}>
        <span className="chat-thread__title">
          {thread.is_pinned ? <IconPin size={12} className="chat-thread__pin" /> : null}
          <span className="chat-thread__text">{title}</span>
          {thread.needs_input ? (
            // A question or a change is waiting for the user.
            <span className="chat-thread__waiting" title="Waiting for your answer" aria-label="Waiting for your answer" />
          ) : null}
        </span>
        {subtitle ? <span className="chat-thread__sub">{subtitle}</span> : null}
      </button>
      <button
        ref={anchor}
        type="button"
        className="n-icon-btn n-icon-btn--sm chat-thread__more"
        aria-label={`Actions for ${title}`}
        aria-haspopup="menu"
        aria-expanded={menu}
        onClick={() => setMenu((m) => !m)}
      >
        <IconMore size={15} />
      </button>
      <Popover anchor={anchor} open={menu} onClose={() => setMenu(false)} align="end" label="Chat actions">
        <button
          type="button"
          role="menuitem"
          className="chat-menu__item"
          onClick={() => {
            setMenu(false)
            void setPinned(thread, !thread.is_pinned)
          }}
        >
          {thread.is_pinned ? 'Unpin' : 'Pin'}
        </button>
        <button
          type="button"
          role="menuitem"
          className="chat-menu__item"
          onClick={() => {
            setMenu(false)
            onRename()
          }}
        >
          Rename
        </button>
        <button
          type="button"
          role="menuitem"
          className="chat-menu__item chat-menu__item--danger"
          onClick={() => {
            setMenu(false)
            void onDelete()
          }}
        >
          Delete
        </button>
      </Popover>
    </div>
  )
}

function RenameField({ thread, onDone }: { thread: ChatThread; onDone(): void }): JSX.Element {
  const [value, setValue] = useState(thread.title ?? '')
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const save = async (): Promise<void> => {
    if (done.current) return
    done.current = true
    const title = value.trim()
    if (title !== (thread.title ?? '')) {
      try {
        await window.notula.chat.updateThread({ threadId: thread.id, patch: { title: title || null } })
      } catch (err) {
        showToast({ title: 'Couldn’t rename this chat', description: parseError(err).message, kind: 'error' })
      }
    }
    onDone()
  }
  return (
    <div className="chat-thread chat-thread--rename">
      <input
        ref={ref}
        className="n-input chat-thread__input"
        value={value}
        maxLength={CHAT_LIMITS.renameMax}
        placeholder="New chat"
        aria-label="Chat name"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void save()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            done.current = true
            onDone()
          }
        }}
        onBlur={() => void save()}
      />
    </div>
  )
}
