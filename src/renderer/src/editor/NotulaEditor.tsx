// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type JSX } from 'react'
import { Extension, type Editor } from '@tiptap/core'
import Collaboration, { isChangeOrigin } from '@tiptap/extension-collaboration'
import { Placeholder } from '@tiptap/extensions'
import { Markdown } from '@tiptap/markdown'
import type { Fragment } from '@tiptap/pm/model'
import { Selection, type EditorState } from '@tiptap/pm/state'
import { EditorContent, useEditor } from '@tiptap/react'
import type { NotePerson } from '@shared/types/notes'
import { IconCheckbox, IconHeading, IconList, IconSparkle } from '../app/icons'
import { isMac, isMod } from '../app/platform'
import { ActionItemDrafts } from './action-item-drafts'
import { ActionItemThumbs } from './action-item-thumbs'
import { copyFlavors, type CopyHeader } from './copy'
import { FindBar } from './FindBar'
import { FindExtension, getFindState, gotoMatch } from './find'
import { NotulaKeys } from './keys'
import { LinkOpen } from './links'
import { docToMarkdown, htmlToMarkdown, renderFragment } from './markdown'
import { MenuStore, SlashMenu, type MentionItem, type SlashItem } from './menus'
import { highlightPassage, locatePassage, passagePlugin, replacePassage } from './passages'
import { NotulaPaste } from './paste'
import { acquireRoom, releaseRoom, retryRoom, type Room, type Seed } from './room'
import { configureMarked, MARKED_OPTIONS, schemaExtensions, type EditorKind } from './schema'
import { NuxTip } from '../features/nux'
import { useEditorScope } from './scope'
import { SuggestionMenu } from './SuggestionMenu'
import { applyTemplateHeadings, hasTemplateHeadings } from './template-headings'
import type { EditorHandle, NotulaEditorProps } from './types'
import './editor.css'

export type { EditorHandle, NotulaEditorProps } from './types'

/** The projection save debounce: at most 10 s after the first unsaved change. */
const PROJECTION_DELAY_MS = 10_000

const DEFAULT_PLACEHOLDER: Record<EditorKind, string> = {
  notes: 'Write notes…',
  panel: 'Your enhanced notes appear here…'
}

const SLASH_ICONS: Record<SlashItem['id'], (p: { size?: number }) => JSX.Element> = {
  heading: IconHeading,
  bulletList: IconList,
  taskList: IconCheckbox
}

/** The platform modifier plus J. */
const QUICK_EDIT_HINT = isMac ? '⌘J' : 'Ctrl+J'

function noteIdOf(roomId: string): string | null {
  const [type, , id] = roomId.split(':')
  return type === 'notes' && id ? id : null
}

function personItem(p: { email?: string; name?: string; displayName?: string }): MentionItem | null {
  const email = p.email?.trim()
  const label = (p.name ?? p.displayName ?? '').trim() || email
  if (!label) return null
  return { id: email || label, label, ...(email && email !== label ? { detail: email } : {}) }
}

/** `@` suggestions: the note's attendees. Empty without a calendar. */
async function loadAttendees(noteId: string): Promise<MentionItem[]> {
  const note = await window.notula.notes.get({ id: noteId })
  if (!note) return []
  const seen = new Set<string>()
  const out: MentionItem[] = []
  const people: (NotePerson & { displayName?: string })[] = [
    ...(note.people?.attendees ?? []),
    ...(note.linked_event?.attendees ?? []).filter((a) => !a.self && !a.resource)
  ]
  for (const p of people) {
    const item = personItem(p)
    if (!item || seen.has(item.id.toLowerCase())) continue
    seen.add(item.id.toLowerCase())
    out.push(item)
  }
  return out
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY
    if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p
  }
  return null
}

/**
 * The selected content, wrapped in its shared parents; a
 * wrapper open on both sides with a single child is dropped, so a word copied from a
 * list item is a word and two copied items stay a list. Null for an empty selection.
 */
function selectionContent(state: EditorState): Fragment | null {
  const sel = state.selection
  if (sel.empty) return null
  let { content, openStart, openEnd } = sel.content()
  while (openStart > 1 && openEnd > 1 && content.childCount === 1 && content.firstChild?.childCount === 1) {
    openStart--
    openEnd--
    content = (content.firstChild as NonNullable<typeof content.firstChild>).content
  }
  return content
}

/** The selection spans the whole document (the header is added). */
function wholeDocumentSelected(state: EditorState): boolean {
  const { from, to } = state.selection
  return from <= Selection.atStart(state.doc).from && to >= Selection.atEnd(state.doc).to
}

/** The plain-text length the trash rules compare (whitespace counts). */
function textLength(editor: Editor): number {
  return editor.getText({ blockSeparator: '\n' }).replace(/\n{2,}/g, '\n').length
}

function selectionMarkdown(state: EditorState): string | null {
  const content = selectionContent(state)
  if (!content) return null
  const md = htmlToMarkdown(renderFragment(state.schema, content))
  return md === '' ? null : md
}

/** Holds a reference on the room while mounted and re-renders on its status changes. */
function useRoom(roomId: string, kind: EditorKind, seed: Seed | undefined): Room | null {
  const seedRef = useRef(seed)
  seedRef.current = seed
  const [room, setRoom] = useState<Room | null>(null)
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    const r = acquireRoom(roomId, kind, seedRef.current)
    setRoom(r)
    const unsubscribe = r.subscribe(bump)
    bump()
    return () => {
      unsubscribe()
      releaseRoom(r)
    }
  }, [roomId, kind])
  return room && room.id === roomId ? room : null
}

/**
 * The rich-text editor for notes and AI panels. The body is the
 * Yjs room's `prosemirror` fragment; every change is appended to the log at once,
 * and the JSON / plain / markdown projection is handed to `onProjection` within 10 s
 * and when the editor goes away.
 */
export function NotulaEditor(props: NotulaEditorProps): JSX.Element {
  const room = useRoom(props.roomId, props.kind, props.seed)
  const scope = useEditorScope()

  if (!room || room.status === 'loading') return <div className="ne-root ne-root--loading" aria-busy="true" />
  if (room.status === 'error') {
    return (
      <div className="ne-root ne-error" role="alert">
        <p>
          {room.error === 'storage-unavailable'
            ? 'Notes storage is not available right now.'
            : 'This note’s content could not be opened.'}
        </p>
        <button type="button" className="n-btn n-btn--sm" onClick={() => retryRoom(room, props.seed)}>
          Try again
        </button>
      </div>
    )
  }
  // A trashed note is read-only; the page's copy header is the default.
  const editable = props.editable && !scope.readOnly
  const copyHeader = props.copyHeader !== undefined ? props.copyHeader : scope.copyHeader
  return <EditorCore key={room.id} room={room} {...props} editable={editable} copyHeader={copyHeader} />
}

const Passages = Extension.create({
  name: 'notulaPassages',
  addProseMirrorPlugins() {
    return [passagePlugin()]
  }
})

interface QuickEditState {
  top: number
  left: number
}

function EditorCore({
  room,
  kind,
  editable,
  placeholder,
  autofocus = true,
  onProjection,
  onTyping,
  onReady,
  onQuickEdit,
  copyHeader
}: NotulaEditorProps & { room: Room }): JSX.Element {
  const callbacks = useRef({ onProjection, onTyping, onReady, onQuickEdit })
  callbacks.current = { onProjection, onTyping, onReady, onQuickEdit }
  const headerRef = useRef<CopyHeader | null>(copyHeader ?? null)
  headerRef.current = copyHeader ?? null
  const editableRef = useRef(editable)
  editableRef.current = editable
  /** True while an edit animation holds the editor read-only. */
  const animating = useRef(0)

  const slashStore = useMemo(() => new MenuStore<SlashItem>(), [])
  // Each opening of the slash menu counts toward its tip.
  useEffect(() => {
    if (kind !== 'notes') return
    let open = false
    return slashStore.subscribe(() => {
      const now = slashStore.getSnapshot().open
      if (now && !open) window.notula.nux.increment({ id: 'slash-menu' })
      open = now
    })
  }, [kind, slashStore])
  const mentionStore = useMemo(() => new MenuStore<MentionItem>(), [])
  const noteId = noteIdOf(room.id)
  const attendees = useRef<Promise<MentionItem[]> | null>(null)

  const [find, setFind] = useState<{ open: boolean; nonce: number; initial: string }>({ open: false, nonce: 0, initial: '' })
  const findOpen = useRef(false)
  findOpen.current = find.open
  const [quickEdit, setQuickEdit] = useState<QuickEditState | null>(null)

  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const editorRef = useRef<Editor | null>(null)

  const flush = useCallback((): void => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    const editor = editorRef.current
    if (!dirty.current || !editor || editor.isDestroyed) return
    dirty.current = false
    callbacks.current.onProjection?.({
      json: editor.getJSON(),
      plain: editor.getText({ blockSeparator: '\n' }).replace(/\n{2,}/g, '\n'),
      markdown: docToMarkdown(editor.state.doc)
    })
  }, [])

  const openFind = useCallback((editor: Editor): boolean => {
    const { from, to, empty } = editor.state.selection
    const selected = empty ? '' : editor.state.doc.textBetween(from, to, ' ')
    setFind((f) => ({
      open: true,
      nonce: f.nonce + 1,
      initial: f.open ? f.initial : selected.includes('\n') ? '' : selected.slice(0, 200)
    }))
    return true
  }, [])

  /** The panel editor's Quick edit: the selection as markdown. */
  const runQuickEdit = useCallback((): boolean => {
    const ed = editorRef.current
    const cb = callbacks.current.onQuickEdit
    if (!ed || ed.isDestroyed || kind !== 'panel' || !cb) return false
    const md = selectionMarkdown(ed.state)
    if (!md) return false
    setQuickEdit(null)
    cb(md)
    return true
  }, [kind])

  const editor = useEditor(
    {
      extensions: [
        ...schemaExtensions(
          kind,
          kind === 'notes' && noteId
            ? {
                store: mentionStore,
                items: async (query) => {
                  attendees.current ??= loadAttendees(noteId).catch(() => [])
                  const q = query.toLowerCase()
                  return (await attendees.current)
                    .filter((p) => p.label.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
                    .slice(0, 8)
                }
              }
            : undefined
        ),
        Markdown.configure({ markedOptions: { ...MARKED_OPTIONS }, indentation: { style: 'space', size: 2 } }),
        Collaboration.configure({ fragment: room.fragment }),
        Placeholder.configure({ placeholder: placeholder ?? DEFAULT_PLACEHOLDER[kind], showOnlyCurrent: true }),
        NotulaKeys,
        NotulaPaste.configure({ annotate: kind === 'notes' }),
        LinkOpen,
        FindExtension,
        Passages,
        SlashMenu.configure({ store: kind === 'notes' ? slashStore : null }),
        // Thumbs and draft buttons on summary lines that state action items.
        ...(kind === 'panel' ? [ActionItemThumbs.configure({ roomId: room.id }), ActionItemDrafts] : [])
      ],
      editable,
      autofocus: autofocus && editable ? 'end' : false,
      editorProps: {
        attributes: {
          class: `ne-content ne-content--${kind}`,
          spellcheck: 'false',
          ...(kind === 'notes' ? { id: 'user-notes-editor', 'aria-label': 'My notes' } : { 'aria-label': 'Enhanced notes' })
        },
        scrollThreshold: 120,
        scrollMargin: 120,
        handleKeyDown: (view, event) => {
          const ed = editorRef.current
          if (!ed) return false
          const mod = isMod(event)
          const key = event.key.toLowerCase()
          if (mod && !event.altKey && key === 'f') {
            event.preventDefault()
            return openFind(ed)
          }
          if (mod && !event.altKey && !event.shiftKey && key === 'j' && kind === 'panel') {
            if (runQuickEdit()) {
              event.preventDefault()
              return true
            }
            return false
          }
          if (findOpen.current && mod && key === 'g') {
            event.preventDefault()
            event.stopPropagation()
            const fs = getFindState(view.state)
            if (fs && fs.matches.length > 0) gotoMatch(view.state, view.dispatch, fs.current + (event.shiftKey ? -1 : 1))
            return true
          }
          if (findOpen.current && event.key === 'Escape' && !slashStore.getSnapshot().open && !mentionStore.getSnapshot().open) {
            setFind((f) => ({ ...f, open: false }))
            return true
          }
          return false
        },
        handleDOMEvents: {
          // Native copy: both flavors replace the browser's
          // own; the header only when the whole document is selected. Cut is untouched.
          copy: (view, event) => {
            const content = selectionContent(view.state)
            if (!content || !event.clipboardData) return false
            try {
              const html = renderFragment(view.state.schema, content).innerHTML
              const header = wholeDocumentSelected(view.state) ? headerRef.current : null
              const flavors = copyFlavors(html, header)
              event.clipboardData.setData('text/html', flavors.html)
              event.clipboardData.setData('text/plain', flavors.text)
              event.preventDefault()
              return true
            } catch (err) {
              console.error('[notula] copy-failed', err)
              return false
            }
          }
        }
      },
      onCreate: ({ editor: ed }) => {
        if (ed.markdown) configureMarked(ed.markdown)
      },
      onUpdate: ({ transaction }) => {
        if (isChangeOrigin(transaction)) return
        dirty.current = true
        timer.current ??= setTimeout(flush, PROJECTION_DELAY_MS)
        callbacks.current.onTyping?.()
      }
    },
    [room]
  )
  editorRef.current = editor

  useEffect(() => {
    if (!editor || editor.isDestroyed || animating.current > 0) return
    if (editor.isEditable !== editable) editor.setEditable(editable)
  }, [editor, editable])

  useEffect(() => {
    if (!editor) return
    const setReadOnly = (): void => {
      animating.current++
      if (!editor.isDestroyed && editor.isEditable) editor.setEditable(false, false)
    }
    const restore = (): void => {
      animating.current = Math.max(0, animating.current - 1)
      if (animating.current === 0 && !editor.isDestroyed && editor.isEditable !== editableRef.current) {
        editor.setEditable(editableRef.current, false)
      }
    }
    // Edits to one editor run one at a time, in order.
    let queue: Promise<unknown> = Promise.resolve()
    const handle: EditorHandle = {
      focus: () => {
        if (!editor.isDestroyed) editor.commands.focus(undefined, { scrollIntoView: true })
      },
      getMarkdown: () => (editor.isDestroyed ? '' : docToMarkdown(editor.state.doc)),
      scrollToTop: () => {
        if (editor.isDestroyed) return
        const sp = scrollParent(editor.view.dom)
        if (sp) sp.scrollTo({ top: 0, behavior: 'smooth' })
      },
      getTextLength: () => (editor.isDestroyed ? 0 : textLength(editor)),
      getSelectionMarkdown: () => (editor.isDestroyed ? null : selectionMarkdown(editor.state)),
      subscribeSelection: (cb) => {
        let last: string | null = editor.isDestroyed ? null : selectionMarkdown(editor.state)
        const check = (): void => {
          if (editor.isDestroyed) return
          const md = selectionMarkdown(editor.state)
          if (md === last) return
          last = md
          cb(md)
        }
        editor.on('selectionUpdate', check)
        editor.on('update', check)
        return () => {
          editor.off('selectionUpdate', check)
          editor.off('update', check)
        }
      },
      hasPassage: (text) => !editor.isDestroyed && locatePassage(editor.state.doc, text) !== null,
      highlightPassage: (text, opts) => highlightPassage(editor, text, opts),
      replacePassage: (oldText, newText, opts) => {
        const run = (): Promise<boolean> =>
          replacePassage(editor, kind, oldText, newText, {
            animate: opts?.animate ?? false,
            setEditable: setReadOnly,
            restoreEditable: restore
          })
        const result = queue.then(run, run)
        queue = result.catch(() => undefined)
        return result
      },
      undo: () => !editor.isDestroyed && editor.commands.undo(),
      applyTemplateHeadings: (headings) => {
        if (kind === 'notes') applyTemplateHeadings(editor, headings)
      },
      subscribeTemplateHeadings: (cb) => {
        let present = !editor.isDestroyed && hasTemplateHeadings(editor.state.doc)
        const check = (): void => {
          if (editor.isDestroyed) return
          const now = hasTemplateHeadings(editor.state.doc)
          if (now === present) return
          present = now
          cb(now)
        }
        editor.on('update', check)
        return () => {
          editor.off('update', check)
        }
      }
    }
    callbacks.current.onReady?.(handle)
  }, [editor, kind])

  // The panel selection toolbar's Quick edit, above a non-empty selection.
  useEffect(() => {
    if (!editor || kind !== 'panel' || !onQuickEdit) {
      setQuickEdit(null)
      return
    }
    const place = (): void => {
      if (editor.isDestroyed) return
      const { from, to, empty } = editor.state.selection
      if (empty || !editor.isFocused || !selectionMarkdown(editor.state)) {
        setQuickEdit(null)
        return
      }
      const start = editor.view.coordsAtPos(from)
      const end = editor.view.coordsAtPos(to)
      setQuickEdit({ top: Math.min(start.top, end.top) - 40, left: Math.max(8, (start.left + end.right) / 2) })
    }
    const hide = (): void => setQuickEdit(null)
    const onBlur = (): void => {
      // A click on the toolbar itself keeps it (it prevents the blur's default).
      setTimeout(() => {
        if (!editor.isDestroyed && !editor.isFocused) setQuickEdit(null)
      }, 0)
    }
    editor.on('selectionUpdate', place)
    editor.on('focus', place)
    editor.on('blur', onBlur)
    window.addEventListener('scroll', hide, true)
    return () => {
      editor.off('selectionUpdate', place)
      editor.off('focus', place)
      editor.off('blur', onBlur)
      window.removeEventListener('scroll', hide, true)
    }
  }, [editor, kind, onQuickEdit])

  // Save the projection when the editor goes away, the window hides or closes.
  useEffect(() => {
    const onHide = (): void => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
      document.removeEventListener('visibilitychange', onHide)
      flush()
    }
  }, [flush])

  const closeFind = useCallback(() => {
    setFind((f) => ({ ...f, open: false }))
    if (editor && !editor.isDestroyed) editor.commands.focus()
  }, [editor])

  return (
    <div
      className={`ne-root ne-root--${kind}${editable ? '' : ' ne-root--readonly'}`}
      onMouseDown={(e) => {
        // A click on the empty space below the content puts the caret at the end.
        if (editor && editable && e.target === e.currentTarget) {
          e.preventDefault()
          editor.commands.focus('end')
        }
      }}
    >
      {find.open && editor ? (
        <FindBar editor={editor} focusNonce={find.nonce} initialQuery={find.initial} onClose={closeFind} />
      ) : null}
      <EditorContent editor={editor} className="ne-editor" />
      {quickEdit ? (
        <div className="ne-quick-edit" role="toolbar" aria-label="Selection" style={{ top: quickEdit.top, left: quickEdit.left }}>
          <button
            type="button"
            className="ne-quick-edit__button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => runQuickEdit()}
          >
            <IconSparkle size={14} />
            Quick edit
            <kbd className="ne-quick-edit__kbd">{QUICK_EDIT_HINT}</kbd>
          </button>
        </div>
      ) : null}
      {/* The empty-note slash tip. */}
      {kind === 'notes' && editor?.isEmpty ? <NuxTip id="slash-menu" /> : null}
      <SuggestionMenu
        store={slashStore}
        label="Insert block"
        empty="No results"
        itemKey={(i) => i.id}
        renderItem={(item) => {
          const Icon = SLASH_ICONS[item.id]
          return (
            <>
              <span className="ne-menu__icon">
                <Icon size={16} />
              </span>
              <span className="ne-menu__title">{item.title}</span>
              <span className="ne-menu__hint">{item.hint}</span>
            </>
          )
        }}
      />
      <SuggestionMenu
        store={mentionStore}
        label="Mention someone"
        empty={null}
        itemKey={(i) => i.id}
        renderItem={(item) => (
          <>
            <span className="ne-menu__avatar" aria-hidden="true">
              {item.label.slice(0, 1).toUpperCase()}
            </span>
            <span className="ne-menu__title">{item.label}</span>
            {item.detail ? <span className="ne-menu__hint">{item.detail}</span> : null}
          </>
        )}
      />
    </div>
  )
}
