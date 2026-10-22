// SPDX-License-Identifier: Apache-2.0
// Suggestion menus: the `/` menu and `@` mentions. The TipTap suggestion plugin reports
// into a MenuStore; the SuggestionMenu component renders it inside the editor's React tree.

import { Extension, type Editor, type Range } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion'

export interface MenuState<I> {
  open: boolean
  items: I[]
  query: string
  selected: number
  rect: DOMRect | null
  pick: ((item: I) => void) | null
}

function closed<I>(): MenuState<I> {
  return { open: false, items: [], query: '', selected: 0, rect: null, pick: null }
}

export class MenuStore<I> {
  private state: MenuState<I> = closed<I>()
  private readonly listeners = new Set<() => void>()

  readonly subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  readonly getSnapshot = (): MenuState<I> => this.state

  private set(next: MenuState<I>): void {
    this.state = next
    for (const l of this.listeners) l()
  }

  private fromProps(p: SuggestionProps<I, I>, keepSelection: boolean): MenuState<I> {
    const selected = keepSelection && p.query === this.state.query ? Math.min(this.state.selected, Math.max(p.items.length - 1, 0)) : 0
    return { open: true, items: p.items, query: p.query, selected, rect: p.clientRect?.() ?? null, pick: (item) => p.command(item) }
  }

  select(index: number): void {
    if (!this.state.open) return
    this.set({ ...this.state, selected: index })
  }

  close(): void {
    if (this.state.open) this.set(closed<I>())
  }

  /** Lifecycle hooks for the suggestion plugin's `render` option. */
  readonly render = () => ({
    onStart: (p: SuggestionProps<I, I>) => this.set(this.fromProps(p, false)),
    onUpdate: (p: SuggestionProps<I, I>) => this.set(this.fromProps(p, true)),
    onExit: () => this.close(),
    onKeyDown: ({ event }: SuggestionKeyDownProps): boolean => {
      const s = this.state
      if (!s.open) return false
      if (event.key === 'Escape') {
        this.close()
        return true
      }
      if (s.items.length === 0) return false
      if (event.key === 'ArrowDown') {
        this.set({ ...s, selected: (s.selected + 1) % s.items.length })
        return true
      }
      if (event.key === 'ArrowUp') {
        this.set({ ...s, selected: (s.selected - 1 + s.items.length) % s.items.length })
        return true
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const item = s.items[s.selected]
        if (item !== undefined) s.pick?.(item)
        return true
      }
      return false
    }
  })
}

// ---------- slash menu ----------

export interface SlashItem {
  id: 'heading' | 'bulletList' | 'taskList'
  title: string
  hint: string
  keywords: string[]
  run(editor: Editor, range: Range): void
}

export const SLASH_ITEMS: readonly SlashItem[] = [
  {
    id: 'heading',
    title: 'Heading',
    hint: '#',
    keywords: ['heading', 'title', 'h1'],
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 1 }).run()
    }
  },
  {
    id: 'bulletList',
    title: 'Bullet list',
    hint: '-',
    keywords: ['bullet', 'list', 'unordered'],
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).toggleBulletList().run()
    }
  },
  {
    id: 'taskList',
    title: 'Checkbox',
    hint: '[ ]',
    keywords: ['checkbox', 'task', 'todo', 'check'],
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).toggleTaskList().run()
    }
  }
]

export function filterSlashItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...SLASH_ITEMS]
  return SLASH_ITEMS.filter((i) => i.title.toLowerCase().includes(q) || i.keywords.some((k) => k.startsWith(q)))
}

export const SlashMenu = Extension.create<{ store: MenuStore<SlashItem> | null }>({
  name: 'notulaSlashMenu',

  addOptions() {
    return { store: null }
  },

  addProseMirrorPlugins() {
    const store = this.options.store
    if (!store) return []
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        pluginKey: new PluginKey('notulaSlashMenu'),
        char: '/',
        allow: ({ state, range }) => state.doc.resolve(range.from).parent.type.name === 'paragraph',
        items: ({ query }) => filterSlashItems(query),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: store.render
      })
    ]
  }
})

// ---------- mentions ----------

export interface MentionItem {
  id: string
  label: string
  detail?: string
}
