// SPDX-License-Identifier: Apache-2.0
// `#/quick-ask`: one pill with the Notula mark, the input and a send button, drawn in
// Notula's look and following the app theme like every other window. Enter submits,
// Escape dismisses; the input
// is cleared on every show and focused on the next frame.

import { Component, useEffect, useRef, useState, type FormEvent, type JSX, type KeyboardEvent, type ReactNode } from 'react'
import { NotulaMark } from '../../app/icons'
import { debugLog } from '../../app/platform'
import { usePrefs } from '../settings/prefs-store'
import './quick-ask.css'

/** An error renders nothing (the window stays an empty, transparent panel). */
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  override componentDidCatch(err: unknown): void {
    debugLog('quick-ask:render-failed', { err: String(err) })
  }
  override render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

/** The app theme on this window's document, without telling main (the main window owns that). */
function useTheme(): void {
  const prefs = usePrefs()
  const theme = prefs?.['ui.theme'] ?? 'system'
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      document.documentElement.dataset['theme'] = theme === 'system' ? (query.matches ? 'dark' : 'light') : theme
    }
    apply()
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [theme])
}

function Pill(): JSX.Element {
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useTheme()

  useEffect(() => {
    document.title = 'Quick ask'
    document.documentElement.classList.add('quick-ask-doc')
    const frame = requestAnimationFrame(() => input.current?.focus())
    const off = window.notula.quickAsk.onVisible(({ visible }) => {
      if (visible) {
        setText('')
        requestAnimationFrame(() => input.current?.focus())
      } else {
        input.current?.blur()
      }
    })
    return () => {
      cancelAnimationFrame(frame)
      off()
    }
  }, [])

  const trimmed = text.trim()
  const submit = (e?: FormEvent): void => {
    e?.preventDefault()
    if (!trimmed) return
    window.notula.quickAsk.submit({ message: trimmed })
    setText('')
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      window.notula.quickAsk.dismiss()
    }
  }

  return (
    <form className="quick-ask" onSubmit={submit}>
      <span className="quick-ask__badge" aria-hidden="true">
        <NotulaMark size={26} />
      </span>
      <input
        ref={input}
        className="quick-ask__input"
        value={text}
        placeholder="Ask anything..."
        aria-label="Quick ask"
        spellCheck
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button
        type="submit"
        className="quick-ask__send"
        aria-label="Send question"
        disabled={!trimmed}
        // The button never takes focus from the input.
        onMouseDown={(e) => e.preventDefault()}
      >
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 19V5M6 11l6-6 6 6" />
        </svg>
      </button>
    </form>
  )
}

export function QuickAskRootView(): JSX.Element {
  return (
    <div className="quick-ask-root">
      <Boundary>
        <Pill />
      </Boundary>
    </div>
  )
}
