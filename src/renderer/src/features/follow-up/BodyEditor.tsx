// SPDX-License-Identifier: Apache-2.0
// The follow-up body editor: paragraphs, lists,
// headings, quotes and links, with `<placeholder>` spans highlighted. The draft is
// markdown; the editor works on HTML and writes markdown back, placeholders kept.

import { useEffect, useRef, type JSX } from 'react'
import { getMarkRange, Mark, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Placeholder } from '@tiptap/extensions'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { marked } from 'marked'
import { htmlToMarkdown } from '../../editor/markdown'

/** `<placeholder>…</placeholder>`; `type="attention"` marks a sentence to double-check. */
const PlaceholderMark = Mark.create({
  name: 'followUpPlaceholder',
  inclusive: false,
  excludes: '',

  addAttributes() {
    return {
      type: {
        default: null,
        parseHTML: (el) => (el.getAttribute('type') === 'attention' ? 'attention' : null),
        renderHTML: (attrs) => (attrs['type'] ? { type: attrs['type'] } : {})
      }
    }
  },

  parseHTML() {
    return [{ tag: 'placeholder' }]
  },

  renderHTML({ HTMLAttributes, mark }) {
    const attention = mark.attrs['type'] === 'attention'
    return [
      'placeholder',
      mergeAttributes(HTMLAttributes, {
        class: attention ? 'fu-ph fu-ph--attention' : 'fu-ph',
        title: attention ? 'Double-check this sentence' : 'Fill this in before sending'
      }),
      0
    ]
  },

  addProseMirrorPlugins() {
    const type = this.type
    return [
      new Plugin({
        key: new PluginKey('followUpPlaceholderFill'),
        props: {
          // Typed text is the user's own: it never carries the placeholder mark, even at the
          // start of a paragraph, where a mark would otherwise be inherited.
          handleTextInput: (view, from, to, text) => {
            const { state } = view
            const marked = state.doc.rangeHasMark(from, Math.max(to, from + 1), type) || type.isInSet(state.storedMarks ?? state.doc.resolve(from).marks())
            if (!marked) return false
            view.dispatch(state.tr.insertText(text, from, to).removeMark(from, from + text.length, type).setStoredMarks([]))
            return true
          },
          // A click on a placeholder selects all of it, so typing replaces it.
          handleClick: (view, pos) => {
            const $pos = view.state.doc.resolve(pos)
            const mark = type.isInSet($pos.marks())
            if (!mark) return false
            const range = getMarkRange($pos, type, mark.attrs)
            if (!range) return false
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, range.from, range.to)))
            return true
          }
        }
      })
    ]
  }
})

export function markdownToEditorHtml(md: string): string {
  return marked.parse(md, { async: false, gfm: true, breaks: false }) as string
}

/** The editor's content as markdown; placeholder elements become their literal tags. */
export function editorMarkdown(editor: Editor): string {
  const root = document.createElement('div')
  root.innerHTML = editor.getHTML()
  for (const ph of Array.from(root.querySelectorAll('placeholder'))) {
    const attention = ph.getAttribute('type') === 'attention'
    const text = ph.textContent ?? ''
    ph.replaceWith(document.createTextNode(text ? `<placeholder${attention ? ' type="attention"' : ''}>${text}</placeholder>` : ''))
  }
  return htmlToMarkdown(root)
}

export function BodyEditor({
  markdown,
  version,
  editable,
  onChange,
  onSelection,
  onSubmit
}: {
  markdown: string
  /** Bumped when the body is replaced from outside (a rewrite, an undo). */
  version: number
  editable: boolean
  onChange(markdown: string): void
  onSelection(text: string | null): void
  onSubmit(): void
}): JSX.Element {
  const callbacks = useRef({ onChange, onSelection, onSubmit })
  callbacks.current = { onChange, onSelection, onSubmit }
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        code: false,
        codeBlock: false,
        horizontalRule: false,
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, autolink: true, defaultProtocol: 'https' }
      }),
      PlaceholderMark,
      Placeholder.configure({ placeholder: 'Write your email…' })
    ],
    content: markdownToEditorHtml(markdown),
    editable,
    editorProps: {
      attributes: { class: 'fu-body', 'aria-label': 'Email body', spellcheck: 'true' },
      handleKeyDown: (_view, e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          callbacks.current.onSubmit()
          return true
        }
        return false
      }
    },
    onUpdate: ({ editor: ed }) => callbacks.current.onChange(editorMarkdown(ed)),
    onSelectionUpdate: ({ editor: ed }) => {
      const { from, to } = ed.state.selection
      const text = from === to ? '' : ed.state.doc.textBetween(from, to, '\n').trim()
      callbacks.current.onSelection(text || null)
    }
  })

  // A rewrite or an undo replaces the whole body without counting as a user edit.
  const shown = useRef(version)
  useEffect(() => {
    if (!editor || shown.current === version) return
    shown.current = version
    editor.commands.setContent(markdownToEditorHtml(markdown), { emitUpdate: false })
  }, [editor, version, markdown])

  useEffect(() => {
    editor?.setEditable(editable)
  }, [editor, editable])

  return <EditorContent editor={editor} className="fu-body-wrap" />
}
