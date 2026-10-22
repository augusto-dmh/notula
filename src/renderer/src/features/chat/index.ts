// SPDX-License-Identifier: Apache-2.0
// Chat in the renderer: the full-screen chat page, the note-page panel, the
// floating chat, the model picker, the markdown renderer, and the
// list-header chat input and `askChat`. This module holds the public signatures;
// the bodies live in the files below.

import { createElement, type JSX } from 'react'
import type { ChatCitation, ChatPlace } from '@shared/types/chat'
import type { EditorHandle } from '../../editor/types'
import { MarkdownView } from './ChatMarkdown'
import { ChatPageView } from './ChatPage'
import { askChatImpl, FloatingChatView, ListChatInputView } from './Floating'
import { ModelPickerView } from './ModelPicker'
import { ImageInputRowsView } from './ImageInputRows'
import { NoteChatPanelView } from './NoteChatPanel'
import { stripKeys } from './util'
import './chat.css'
import './tools.css'

export interface NoteChatPanelProps {
  noteId: string
  /** null on the transcript tab. */
  target: { kind: 'summary'; panelId: string; editor: EditorHandle } | { kind: 'notes'; editor: EditorHandle } | null
  transcribing: boolean
  open: boolean
  onOpenChange(open: boolean): void
  quickEdit: { selection: string; nonce: number } | null
  onOpenPanel(panelId: string): void
  onShowInTranscript(quote: string): void
}

export type ModelPickerProps =
  | { kind: 'single' | 'multi' }
  | { kind: 'recipe'; value: string | null; onChange(v: string | null): void }

/** `/chat` and `/chat/:threadId`. */
export function ChatPage({ threadId }: { threadId: string | null }): JSX.Element {
  return createElement(ChatPageView, { threadId })
}

/** The note page's right sidebar. */
export function NoteChatPanel(p: NoteChatPanelProps): JSX.Element | null {
  return createElement(NoteChatPanelView, p)
}

/** Mounted once in App (main window). */
export function FloatingChat(): JSX.Element | null {
  return createElement(FloatingChatView)
}

export function ModelPicker(p: ModelPickerProps): JSX.Element | null {
  return createElement(ModelPickerView, p)
}

/**
 * marked lexer → React elements; raw HTML renders as text. Citations, when
 * given, use `answer_line` relative to this markdown's lines.
 */
export function ChatMarkdown(p: { markdown: string; citations?: ChatCitation[] }): JSX.Element {
  // Streamed text (a recipe preview) still carries citation keys: they never show.
  const markdown = p.citations ? p.markdown : stripKeys(p.markdown, true)
  return createElement(MarkdownView, { markdown, citations: p.citations, lineOffset: 0 })
}

/** The list-header chat input of the folder and search pages. */
export function ListChatInput(p: { place: ChatPlace }): JSX.Element {
  return createElement(ListChatInputView, p)
}

/**
 * The palette's Tab / "Ask Chat": the note's floating chat when `noteId` is given,
 * else a new global chat on `/chat`.
 */
export function askChat(opts: { text: string; noteId?: string | null }): void {
  askChatImpl(opts)
}

// ---------- tools, approvals and files ----------

/** Settings ▸ AI: "This model accepts images" for OpenAI-compatible and local. */
export function ImageInputRows(): JSX.Element {
  return createElement(ImageInputRowsView)
}

export { askPage, selectThread } from './store'
