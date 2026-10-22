// SPDX-License-Identifier: Apache-2.0
// The editor contract. NotulaEditor.tsx implements it; the AI notes and chat features
// drive editors only through EditorHandle.

export interface EditorHandle {
  // Core
  focus(): void
  getMarkdown(): string
  scrollToTop(): void
  // Copy, trash and panels
  /** Plain-text length (the trash rules' auto-delete check). */
  getTextLength(): number
  /** The selection as markdown, or null when nothing is selected. */
  getSelectionMarkdown(): string | null
  subscribeSelection(cb: (markdown: string | null) => void): () => void
  /** Whether `text` occurs in the current markdown. */
  hasPassage(text: string): boolean
  /** Highlights the passage; null clears. */
  highlightPassage(text: string | null, opts?: { scroll?: boolean }): void
  /** Replaces the first occurrence, on markdown. Resolves false when the passage is gone. */
  replacePassage(oldText: string, newText: string, opts?: { animate?: boolean }): Promise<boolean>
  /** Undoes this editor's own last change; false when the stack is empty. */
  undo(): boolean
  /** Notes editor: inserts level-1 template headings; null removes them. */
  applyTemplateHeadings(headings: string[] | null): void
  /** Fires with false once every inserted template heading is gone. */
  subscribeTemplateHeadings(cb: (present: boolean) => void): () => void
}

export interface NotulaEditorProps {
  roomId: string
  kind: 'notes' | 'panel'
  editable: boolean
  placeholder?: string
  seed?: { json?: unknown; markdown?: string }
  autofocus?: boolean
  onProjection?(p: { json: unknown; plain: string; markdown: string }): void
  onTyping?(): void
  onReady?(h: EditorHandle): void
  /** Panel editor: the selection toolbar's "Quick edit" and Mod+J. */
  onQuickEdit?(selectionMarkdown: string): void
  /** The header a whole-document copy adds. */
  copyHeader?: { title: string | null; date: string | null; attendees: string[] } | null
}
