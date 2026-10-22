// SPDX-License-Identifier: Apache-2.0
// The editor for one day’s page in the scratchpad.

import { forwardRef, useEffect, useImperativeHandle, useRef, type JSX } from 'react'
import type { Node as PMNode } from '@tiptap/pm/model'
import { EditorState, Plugin } from '@tiptap/pm/state'
import { Decoration, DecorationSet, EditorView, type NodeView } from '@tiptap/pm/view'
import { SCRATCHPAD_SAVE_DEBOUNCE_MS } from '@shared/types/scratchpad'
import { debugLog } from '../../app/platform'
import { outlinePlugins, toggleAttr } from './commands'
import { bulletDataAttrs, schema, type BulletAttrs } from './schema'

const PLACEHOLDER = 'Write today’s notes and to-dos'

// ---------- the bullet node view ----------

class BulletView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private gutter: HTMLElement
  private node: PMNode

  constructor(
    node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined
  ) {
    this.node = node
    this.dom = document.createElement('div')
    this.dom.className = 'sp-bullet'
    this.gutter = document.createElement('div')
    this.gutter.className = 'sp-gutter'
    this.gutter.contentEditable = 'false'
    this.contentDOM = document.createElement('div')
    this.contentDOM.className = 'sp-body'
    this.dom.append(this.gutter, this.contentDOM)
    this.render()
  }

  private toggle(attr: 'collapsed' | 'completed'): void {
    const pos = this.getPos()
    if (pos === undefined) return
    const tr = toggleAttr(this.view.state, pos, attr)
    if (tr) this.view.dispatch(tr)
  }

  private render(): void {
    const attrs = this.node.attrs as BulletAttrs
    for (const a of Array.from(this.dom.attributes)) if (a.name.startsWith('data-')) this.dom.removeAttribute(a.name)
    for (const [k, v] of Object.entries(bulletDataAttrs(attrs))) this.dom.setAttribute(k, v)
    const hasChildren = this.node.childCount > 1
    this.dom.classList.toggle('sp-bullet--parent', hasChildren)
    this.gutter.replaceChildren()

    const caret = document.createElement('button')
    caret.type = 'button'
    caret.className = 'sp-caret'
    caret.tabIndex = -1
    caret.hidden = !hasChildren
    caret.setAttribute('aria-label', attrs.collapsed ? 'Expand' : 'Collapse')
    caret.title = attrs.collapsed ? 'Expand' : 'Collapse'
    caret.addEventListener('mousedown', (e) => e.preventDefault())
    caret.addEventListener('click', () => this.toggle('collapsed'))
    this.gutter.append(caret)

    if (attrs.isTask) {
      const box = document.createElement('button')
      box.type = 'button'
      box.className = 'sp-check'
      box.tabIndex = -1
      box.setAttribute('role', 'checkbox')
      box.setAttribute('aria-checked', String(attrs.completed))
      box.setAttribute('aria-label', attrs.completed ? 'Mark task incomplete' : 'Mark task done')
      box.title = attrs.completed ? 'Mark task incomplete' : 'Mark task done'
      box.addEventListener('mousedown', (e) => e.preventDefault())
      box.addEventListener('click', () => this.toggle('completed'))
      this.gutter.append(box)
    } else {
      const dot = document.createElement('span')
      dot.className = 'sp-dot'
      dot.setAttribute('aria-hidden', 'true')
      this.gutter.append(dot)
    }
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render()
    return true
  }

  stopEvent(e: Event): boolean {
    return e.target instanceof Node && this.gutter.contains(e.target)
  }

  ignoreMutation(m: MutationRecord | { type: 'selection'; target: Node }): boolean {
    if (m.type === 'selection') return false
    return this.gutter.contains(m.target) || (m.type === 'attributes' && m.target === this.dom)
  }
}

// ---------- decorations: the caret's row and the placeholder ----------

function rowDecorations(editable: () => boolean): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const { $from } = state.selection
        const decos: Decoration[] = []
        if ($from.parent.type === schema.nodes.bulletContent) {
          const linePos = $from.before($from.depth)
          decos.push(Decoration.node(linePos, linePos + $from.parent.nodeSize, { class: 'sp-line--active' }))
        }
        if (editable()) {
          const only = state.doc.childCount === 1 && state.doc.firstChild!.childCount === 1
          state.doc.descendants((node, pos) => {
            if (node.type !== schema.nodes.bulletContent) return true
            const atCaret = $from.parent === node
            if (node.content.size === 0 && (atCaret || only)) {
              decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'sp-line--empty', 'data-placeholder': PLACEHOLDER }))
            }
            return false
          })
        }
        return DecorationSet.create(state.doc, decos)
      }
    }
  })
}

// ---------- the React wrapper ----------

export interface DayEditorHandle {
  /** A push for this day arrived: reload it when another window changed it. */
  remoteChanged(): void
  /** Saves any pending change now. */
  flush(): void
}

export const DayEditor = forwardRef<
  DayEditorHandle,
  { date: string; initial: PMNode; editable?: boolean; today: boolean; label: string }
>(function DayEditor({ date, initial, editable = true, today, label }, ref): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const timer = useRef<number | null>(null)
  const dirty = useRef(false)
  const lastSaved = useRef<string>(JSON.stringify(initial.toJSON()))
  const saving = useRef<Promise<void>>(Promise.resolve())

  function save(): void {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    const view = viewRef.current
    if (!view || !dirty.current) return
    dirty.current = false
    const content = view.state.doc.toJSON()
    const json = JSON.stringify(content)
    if (json === lastSaved.current) return
    lastSaved.current = json
    saving.current = saving.current
      .then(() => window.notula.scratchpad.saveDay({ date, content }))
      .then(() => undefined)
      .catch((err: unknown) => {
        // The next change saves again; nothing is thrown away.
        dirty.current = true
        debugLog('scratchpad:save-failed', { err: String(err) })
      })
  }

  useEffect(() => {
    if (!host.current) return
    const view = new EditorView(host.current, {
      state: EditorState.create({ doc: initial, plugins: [...outlinePlugins(), rowDecorations(() => editable)] }),
      editable: () => editable,
      nodeViews: { bullet: (node, v, getPos) => new BulletView(node, v, getPos) },
      attributes: { class: 'sp-editor', 'aria-label': label, role: 'textbox', 'aria-multiline': 'true' },
      dispatchTransaction(tr) {
        view.updateState(view.state.apply(tr))
        if (!tr.docChanged || tr.getMeta('remote')) return
        dirty.current = true
        if (timer.current !== null) window.clearTimeout(timer.current)
        timer.current = window.setTimeout(save, SCRATCHPAD_SAVE_DEBOUNCE_MS)
      },
      handleDOMEvents: {
        blur: () => {
          save()
          return false
        }
      }
    })
    viewRef.current = view
    const flushNow = (): void => save()
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') save()
    }
    window.addEventListener('blur', flushNow)
    window.addEventListener('pagehide', flushNow)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('blur', flushNow)
      window.removeEventListener('pagehide', flushNow)
      document.removeEventListener('visibilitychange', onVisibility)
      save()
      view.destroy()
      viewRef.current = null
    }
    // The view is created once per day; later content arrives through `remoteChanged`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date])

  useImperativeHandle(
    ref,
    () => ({
      flush: save,
      remoteChanged: () => {
        void window.notula.scratchpad
          .getDay({ date })
          .then((day) => {
            const view = viewRef.current
            if (!view || day.content === null) return
            const json = JSON.stringify(day.content)
            // Our own save, or a local edit not saved yet (our next save wins).
            if (json === lastSaved.current || dirty.current) return
            let doc: PMNode
            try {
              doc = schema.nodeFromJSON(day.content)
              doc.check()
            } catch {
              return
            }
            lastSaved.current = json
            const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content).setMeta('remote', true).setMeta('addToHistory', false)
            view.dispatch(tr)
          })
          .catch((err: unknown) => debugLog('scratchpad:reload-failed', { err: String(err) }))
      }
    }),
    [date]
  )

  return <div ref={host} className={`sp-day__editor${today ? ' sp-day__editor--today' : ''}`} />
})
