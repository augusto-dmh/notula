// SPDX-License-Identifier: Apache-2.0
// The chat composer: a text field where `@` opens a note
// menu (a chosen note is sent as `@<noteId>`) and a leading `/` opens the recipe menu.
// Enter sends, Shift+Enter starts a new line; while an answer streams the send
// button becomes Stop. The model picker sits at the end of the bar.
//
// The paperclip adds chat files (`attachments:add-files`, `attachments:list`,
// `attachments:remove`). Files added before a chat's first send are stored under a draft
// id and join the thread with the send.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from 'react'
import type { DocRef } from '@shared/types/chat'
import type { NoteListItem } from '@shared/types/notes'
import type { Recipe, RecipeView } from '@shared/types/recipes'
import { IconClose } from '../../app/icons'
import { debugLog, isMod } from '../../app/platform'
import { ChatDictationButton } from '../dictation'
import { openRecipeModal, RecipeMenu, recipeDisplayName } from '../recipes'
import { usePrefs } from '../settings/prefs-store'
import { parseError } from '@shared/errors'
import { IconDoc, IconImage, IconPaperclip, IconSend, IconStop } from './icons'
import { ModelPickerView } from './ModelPicker'

export interface ComposerSubmit {
  /** The text with each mention as `@<noteId>`. */
  text: string
  /** What the message shows until it is stored (`/<slug> text` for a recipe). */
  displayText: string
  mentions: DocRef[]
  recipeId: string | null
  /** The chat files to send with the message. */
  attachmentIds?: string[]
}

export interface ComposerHandle {
  focus(): void
  setText(text: string): void
}

interface Props {
  placeholder: string
  disabled: boolean
  streaming: boolean
  modelKind: 'single' | 'multi'
  recipeView: RecipeView
  onSubmit(s: ComposerSubmit): Promise<boolean>
  onStop(): void
  /** Text to load into the field (Edit, a recipe chip); the nonce re-applies the same text. */
  prefill?: { text: string; nonce: number; mentions?: DocRef[] } | null
  /** Focus the field when this changes (a quick edit, a new chat). */
  focusNonce?: number
  autoFocus?: boolean
  /** Above the field: the selection chip, the "Editing message" bar. */
  top?: ReactNode
  /** Under the bar: the "no tools" notice. */
  notice?: string | null
  compact?: boolean
  /** Where added files are stored (the thread, or the draft before its first send); null hides the paperclip. */
  attachParent?: string | null
}

interface PendingFile {
  key: string
  name: string
  mimeType: string
  id: string | null
  status: 'adding' | 'ready' | 'failed'
  error: string | null
}

/** Chat files on one message (the request schema's cap). */
const MAX_FILES = 20

function fileError(err: unknown): string {
  const message = parseError(err).message
  return /No handler registered/i.test(String(err)) ? 'Files can’t be added yet.' : message || 'The file could not be added.'
}

const NOTES_TTL_MS = 30_000
const MENTION_MAX = 8
let notesCache: { at: number; items: NoteListItem[] } | null = null

async function listNotes(): Promise<NoteListItem[]> {
  if (notesCache && Date.now() - notesCache.at < NOTES_TTL_MS) return notesCache.items
  try {
    const page = await window.notula.notes.list({ scope: 'own', limit: 500 })
    notesCache = { at: Date.now(), items: page.items }
  } catch (err) {
    debugLog('chat:mention-notes-failed', { err: String(err) })
    notesCache = { at: Date.now(), items: [] }
  }
  return notesCache.items
}

function noteLabel(n: NoteListItem): string {
  return n.title?.trim() || n.linked_event?.summary?.trim() || 'Untitled note'
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `@Title` → `@<id>` for every mention still in the text; the mentions that remain. */
function serialize(text: string, mentions: DocRef[]): { text: string; mentions: DocRef[] } {
  let out = text
  const kept: DocRef[] = []
  for (const m of [...mentions].sort((a, b) => b.title.length - a.title.length)) {
    const re = new RegExp(`@${escapeRe(m.title)}(?=$|[\\s.,;:!?)])`, 'g')
    if (!re.test(out)) continue
    out = out.replace(re, `@${m.id}`)
    if (!kept.some((k) => k.id === m.id)) kept.push(m)
  }
  return { text: out, mentions: kept }
}

/** The `@query` being typed at the caret, if any. */
function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at === -1) return null
  if (at > 0 && !/\s/.test(before[at - 1] ?? '')) return null
  const query = before.slice(at + 1)
  if (query.length > 40 || /\n/.test(query)) return null
  return { start: at, query }
}

export function Composer(p: Props): JSX.Element {
  const [text, setText] = useState('')
  const [mentions, setMentions] = useState<DocRef[]>([])
  const [recipe, setRecipe] = useState<Recipe | null>(null)
  const [caret, setCaret] = useState(0)
  const [noteMenu, setNoteMenu] = useState<{ start: number; query: string } | null>(null)
  const [notes, setNotes] = useState<NoteListItem[]>([])
  const [active, setActive] = useState(0)
  const [recipeMenuClosed, setRecipeMenuClosed] = useState(false)
  const [sending, setSending] = useState(false)
  const [files, setFiles] = useState<PendingFile[]>([])
  const [dropping, setDropping] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)

  const addFiles = async (list: File[]): Promise<void> => {
    const parent = p.attachParent
    if (!parent || list.length === 0) return
    const room = MAX_FILES - files.filter((f) => f.status !== 'failed').length
    for (const file of list.slice(0, Math.max(0, room))) {
      const key = crypto.randomUUID()
      setFiles((fs) => [...fs, { key, name: file.name, mimeType: file.type, id: null, status: 'adding', error: null }])
      let path = ''
      try {
        path = window.notula.files.pathForFile(file)
      } catch {
        path = ''
      }
      const done = (patch: Partial<PendingFile>): void => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, ...patch } : f)))
      if (!path) {
        done({ status: 'failed', error: 'This file can’t be read.' })
        continue
      }
      try {
        const r = await window.notula.attachments.addFiles({ parentType: 'chat_thread', parentId: parent, files: [{ path }] })
        const ok = r.accepted[0]
        if (ok) done({ id: ok.id, status: 'ready', mimeType: ok.mime_type, name: ok.file_name })
        else done({ status: 'failed', error: r.rejected[0]?.message ?? 'The file could not be added.' })
      } catch (err) {
        done({ status: 'failed', error: fileError(err) })
      }
    }
  }

  const removeFile = (f: PendingFile): void => {
    setFiles((fs) => fs.filter((x) => x.key !== f.key))
    if (f.id) void window.notula.attachments.remove({ attachmentId: f.id }).catch(() => undefined)
  }

  // Recipe menu: a leading "/" with the caret still in the first word.
  const slash = !recipe && !recipeMenuClosed && /^\/[^\s]*$/.test(text.slice(0, Math.max(caret, 1))) && text.startsWith('/')
  const slashQuery = slash ? text.slice(1, caret).replace(/\s.*$/, '') : ''

  const matches = useMemo(() => {
    if (!noteMenu) return []
    const q = noteMenu.query.trim().toLowerCase()
    const hits = notes.filter((n) => !q || noteLabel(n).toLowerCase().includes(q))
    hits.sort((a, b) => Number(noteLabel(b).toLowerCase().startsWith(q)) - Number(noteLabel(a).toLowerCase().startsWith(q)))
    return hits.slice(0, MENTION_MAX)
  }, [noteMenu, notes])

  useEffect(() => setActive(0), [noteMenu?.query])

  useEffect(() => {
    if (p.prefill) {
      setText(p.prefill.text)
      setMentions(p.prefill.mentions ?? [])
      setRecipe(null)
      setRecipeMenuClosed(p.prefill.text.startsWith('/') && /\s/.test(p.prefill.text))
      requestAnimationFrame(() => {
        const el = field.current
        if (!el) return
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
        setCaret(el.value.length)
      })
    }
  }, [p.prefill?.nonce])

  useEffect(() => {
    if (p.focusNonce) field.current?.focus()
  }, [p.focusNonce])

  useLayoutEffect(() => {
    const el = field.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, p.compact ? 160 : 220)}px`
  }, [text, p.compact])

  const update = (value: string, at: number): void => {
    setText(value)
    setCaret(at)
    if (!value.startsWith('/')) setRecipeMenuClosed(false)
    const m = mentionAt(value, at)
    setNoteMenu(m)
    if (m && notes.length === 0) void listNotes().then(setNotes)
  }

  const pickNote = (n: NoteListItem): void => {
    if (!noteMenu) return
    const title = noteLabel(n)
    const next = `${text.slice(0, noteMenu.start)}@${title} ${text.slice(caret)}`
    const at = noteMenu.start + title.length + 2
    setMentions((ms) => (ms.some((m) => m.id === n.id) ? ms : [...ms, { id: n.id, title }]))
    setText(next)
    setNoteMenu(null)
    requestAnimationFrame(() => {
      field.current?.focus()
      field.current?.setSelectionRange(at, at)
      setCaret(at)
    })
  }

  const pickRecipe = (r: Recipe): void => {
    const rest = text.replace(/^\/[^\s]*\s*/, '')
    setRecipe(r)
    setText(rest)
    setCaret(rest.length)
    requestAnimationFrame(() => field.current?.focus())
  }

  const readyFiles = files.filter((f) => f.status === 'ready' && f.id)
  const filesBusy = files.some((f) => f.status === 'adding')
  const canSend = !p.disabled && !sending && !p.streaming && !filesBusy && (text.trim().length > 0 || recipe !== null || readyFiles.length > 0)

  const submit = async (): Promise<void> => {
    if (!canSend) return
    const s = serialize(text.trim(), mentions)
    const displayText = recipe ? `/${recipe.slug}${s.text ? ` ${s.text}` : ''}` : s.text
    const prev = { text, mentions, recipe, files }
    const attachmentIds = readyFiles.map((f) => f.id as string)
    setSending(true)
    setText('')
    setMentions([])
    setRecipe(null)
    setNoteMenu(null)
    setFiles([])
    const ok = await p.onSubmit({
      text: s.text,
      displayText,
      mentions: s.mentions,
      recipeId: recipe?.id ?? null,
      ...(attachmentIds.length ? { attachmentIds } : {})
    })
    setSending(false)
    if (!ok) {
      setText(prev.text)
      setMentions(prev.mentions)
      setRecipe(prev.recipe)
      setFiles(prev.files)
    }
    requestAnimationFrame(() => field.current?.focus())
  }

  const enterBehavior = usePrefs()?.['chat.enterBehavior'] ?? 'send'
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (noteMenu && matches.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length)
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
        e.preventDefault()
        const n = matches[active]
        if (n) pickNote(n)
        return
      }
    }
    if (noteMenu && e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setNoteMenu(null)
      return
    }
    if (e.key === 'Backspace' && recipe && field.current?.selectionStart === 0 && field.current.selectionEnd === 0) {
      e.preventDefault()
      setRecipe(null)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      // With `chat.enterBehavior` = `newline`, Enter inserts a line and Mod+Enter sends.
      if (enterBehavior === 'newline' && !isMod(e)) return
      e.preventDefault()
      void submit()
    }
  }

  return (
    <div className={`chat-composer${p.compact ? ' chat-composer--compact' : ''}`}>
      {slash ? (
        <div className="chat-composer__menu">
          <RecipeMenu
            view={p.recipeView}
            query={slashQuery}
            onPick={pickRecipe}
            onCreate={(slug) => {
              setRecipeMenuClosed(true)
              openRecipeModal({ mode: 'create', draft: { slug } })
            }}
            onClose={() => setRecipeMenuClosed(true)}
          />
        </div>
      ) : null}
      {noteMenu && matches.length > 0 ? (
        <div className="chat-composer__menu">
          <div className="chat-mentions" role="listbox" aria-label="Notes" onMouseDown={(e) => e.preventDefault()}>
            <div className="chat-menu__heading">Notes</div>
            {matches.map((n, i) => (
              <button
                key={n.id}
                type="button"
                role="option"
                aria-selected={i === active}
                className="chat-menu__item"
                data-active={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => pickNote(n)}
              >
                <IconDoc size={14} />
                <span className="chat-menu__text">{noteLabel(n)}</span>
                <span className="chat-menu__hint">
                  {new Date(n.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {p.top}
      <div
        className={`chat-composer__box${p.disabled ? ' is-disabled' : ''}${dropping ? ' is-drop' : ''}`}
        onDragOver={(e) => {
          if (!p.attachParent || p.disabled || !e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setDropping(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
        }}
        onDrop={(e) => {
          setDropping(false)
          if (!p.attachParent || p.disabled || e.dataTransfer.files.length === 0) return
          e.preventDefault()
          void addFiles([...e.dataTransfer.files])
        }}
      >
        {files.length ? (
          <div className="chat-files">
            {files.map((f) => (
              <span key={f.key} className={`chat-file chat-file--${f.status}`} title={f.error ?? f.name}>
                {f.status === 'adding' ? <span className="chat-tool__spin" aria-hidden="true" /> : f.mimeType.startsWith('image/') ? <IconImage size={13} /> : <IconPaperclip size={13} />}
                <span className="chat-file__name">{f.name}</span>
                {f.error ? <span className="chat-file__error">{f.error}</span> : null}
                <button type="button" className="chat-file__x" aria-label={`Remove ${f.name}`} onClick={() => removeFile(f)}>
                  <IconClose size={10} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {recipe ? (
          <span className="chat-composer__recipe" title={recipe.config.description ?? undefined}>
            /{recipeDisplayName(recipe.slug)}
            <button type="button" className="chat-composer__recipe-x" aria-label="Remove recipe" onClick={() => setRecipe(null)}>
              <IconClose size={11} />
            </button>
          </span>
        ) : null}
        <textarea
          ref={field}
          className="chat-composer__field"
          rows={1}
          value={text}
          placeholder={recipe ? 'Add details (optional)' : p.placeholder}
          disabled={p.disabled}
          autoFocus={p.autoFocus}
          aria-label="Message"
          onChange={(e) => update(e.target.value, e.target.selectionStart)}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
        />
        <div className="chat-composer__bar">
          {p.attachParent ? (
            <>
              <button
                type="button"
                className="n-icon-btn n-icon-btn--sm chat-composer__attach"
                aria-label="Add files"
                title="Add files"
                disabled={p.disabled || p.streaming}
                onClick={() => picker.current?.click()}
              >
                <IconPaperclip size={15} />
              </button>
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  const list = [...(e.target.files ?? [])]
                  e.target.value = ''
                  void addFiles(list)
                }}
              />
            </>
          ) : null}
          <ModelPickerView kind={p.modelKind} />
          {/* Chat voice input; text goes in without formatting. */}
          <ChatDictationButton
            onText={(t) => setText((prev) => (prev.trim() ? `${prev.replace(/\s+$/, '')} ${t}` : t))}
            disabled={p.disabled || p.streaming}
          />
          {p.streaming ? (
            <button type="button" className="chat-send chat-send--stop" aria-label="Stop" title="Stop" onClick={p.onStop}>
              <IconStop size={14} />
            </button>
          ) : (
            <button type="button" className="chat-send" aria-label="Send" title="Send" disabled={!canSend} onClick={() => void submit()}>
              <IconSend size={15} />
            </button>
          )}
        </div>
      </div>
      {p.notice ? <p className="chat-composer__notice">{p.notice}</p> : null}
    </div>
  )
}
