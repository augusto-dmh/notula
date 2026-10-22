// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import type { Editor } from '@tiptap/core'
import { IconChevronDown, IconChevronUp, IconClose } from '../app/icons'
import { isMod } from '../app/platform'
import { getFindState, gotoMatch, setFindQuery } from './find'

interface FindBarProps {
  editor: Editor
  /** Bumped by Mod+F so an open bar refocuses and selects its input. */
  focusNonce: number
  initialQuery: string
  onClose(): void
}

/** Mod+F find bar. */
export function FindBar({ editor, focusNonce, initialQuery, onClose }: FindBarProps): JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState(initialQuery)
  const [, force] = useState(0)

  useEffect(() => {
    const el = input.current
    if (!el) return
    el.focus()
    el.select()
  }, [focusNonce])

  // Re-render on every editor transaction so the count follows edits.
  useEffect(() => {
    const update = (): void => force((n) => n + 1)
    editor.on('transaction', update)
    return () => {
      editor.off('transaction', update)
    }
  }, [editor])

  useEffect(() => {
    if (editor.isDestroyed) return
    editor.view.dispatch(setFindQuery(editor.state.tr, query))
    const fs = getFindState(editor.state)
    if (fs && fs.matches.length > 0) gotoMatch(editor.state, editor.view.dispatch, 0)
  }, [editor, query])

  // Clear the highlights when the bar goes away.
  useEffect(
    () => () => {
      if (!editor.isDestroyed) editor.view.dispatch(setFindQuery(editor.state.tr, ''))
    },
    [editor]
  )

  const fs = editor.isDestroyed ? undefined : getFindState(editor.state)
  const total = fs?.matches.length ?? 0
  const current = fs?.current ?? -1

  const step = (delta: number): void => {
    if (total === 0) return
    gotoMatch(editor.state, editor.view.dispatch, current + delta)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    const key = e.key
    let handled = true
    if (key === 'Escape') onClose()
    else if (key === 'Enter') step(e.shiftKey ? -1 : 1)
    else if (key === 'ArrowDown') step(1)
    else if (key === 'ArrowUp') step(-1)
    else if (isMod(e) && key.toLowerCase() === 'g') step(e.shiftKey ? -1 : 1)
    else if (isMod(e) && key.toLowerCase() === 'f') input.current?.select()
    else handled = false
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  return (
    <div className="ne-findbar" role="search" onMouseDown={(e) => e.stopPropagation()}>
      <input
        ref={input}
        className="ne-findbar__input"
        placeholder="Find"
        aria-label="Find in note"
        value={query}
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className="ne-findbar__count" aria-live="polite">
        {query === '' ? '' : total === 0 ? 'No results' : `${current + 1} of ${total}`}
      </span>
      <button type="button" className="n-icon-btn n-icon-btn--sm" aria-label="Previous match" disabled={total === 0} onClick={() => step(-1)}>
        <IconChevronUp size={16} />
      </button>
      <button type="button" className="n-icon-btn n-icon-btn--sm" aria-label="Next match" disabled={total === 0} onClick={() => step(1)}>
        <IconChevronDown size={16} />
      </button>
      <button type="button" className="n-icon-btn n-icon-btn--sm" aria-label="Close find" onClick={onClose}>
        <IconClose size={14} />
      </button>
    </div>
  )
}
