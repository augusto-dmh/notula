// SPDX-License-Identifier: Apache-2.0
// Courses: what Generate notes reads on a course note, and jumps from its lesson notes.
// - The scope picker beside Generate notes: *Watched part (42 min)* / *Whole video (2 h 25 min)*.
//   The automatic pick is main's watched-scope rule; a pick is remembered per note here (local
//   storage) and sent to main, which uses it for the prompts (`sources:lesson-notes-scope`).
// - The budget warning when main says the scoped transcript is over the model's budget.
// - The footer under generated notes: "From 0:00–42:10 of 2:25:51 and your 12 notes". It
//   describes the scope as it is now.
// - A click on a `[mm:ss]` citation in lesson notes seeks the lesson's player (Shift: the link).
// Course notes only: main answers null for every other note, and nothing shows.

import { useCallback, useEffect, useState, type JSX, type MouseEvent as ReactMouseEvent } from 'react'
import type { InvokeRes } from '@shared/ipc'
import { debugLog } from '../../app/platform'
import { jumpToPosition } from '../../editor/source-position'
import { trySources } from '../sources/note/source-store'
import { useNoteSource } from '../transcript/SourcePlan'

export type LessonScope = NonNullable<InvokeRes<'sources:lesson-notes-scope'>>
type Choice = LessonScope['choice']

const STORE_PREFIX = 'notula.lessonScope.'

function storedChoice(noteId: string): Choice | null {
  try {
    const v = window.localStorage.getItem(STORE_PREFIX + noteId)
    return v === 'watched' || v === 'whole' ? v : null
  } catch {
    return null
  }
}

function storeChoice(noteId: string, choice: Choice, automatic: Choice): void {
  try {
    if (choice === automatic) window.localStorage.removeItem(STORE_PREFIX + noteId)
    else window.localStorage.setItem(STORE_PREFIX + noteId, choice)
  } catch (err) {
    debugLog('lesson-scope-store-failed', { err: String(err) })
  }
}

/** `0:00`, `42:10`, `2:25:51`. */
export function clockLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** `42 min`, `2 h 25 min`. */
function lengthLabel(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h > 0 ? (m > 0 ? `${h} h ${m} min` : `${h} h`) : `${m} min`
}

/** The note's scope from main, with the remembered pick applied once. Null for other notes. */
export function useLessonScope(noteId: string, enabled: boolean): { scope: LessonScope | null; choose(choice: Choice): void } {
  const [scope, setScope] = useState<LessonScope | null>(null)
  useEffect(() => {
    setScope(null)
    if (!enabled) return
    let alive = true
    void (async () => {
      let s = await trySources('sources:lesson-notes-scope-failed', () => window.notula.sources.lessonNotesScope({ noteId }))
      // A pick from an earlier run: main keeps picks in memory only.
      const kept = s ? storedChoice(noteId) : null
      if (s && kept && kept !== s.choice) s = await trySources('sources:lesson-notes-scope-failed', () => window.notula.sources.lessonNotesScope({ noteId, choice: kept }))
      if (alive) setScope(s)
    })()
    return () => {
      alive = false
    }
  }, [noteId, enabled])
  const choose = useCallback(
    (choice: Choice): void => {
      void trySources('sources:lesson-notes-scope-failed', () => window.notula.sources.lessonNotesScope({ noteId, choice })).then((s) => {
        if (!s) return
        storeChoice(noteId, choice, s.defaultChoice)
        setScope(s)
      })
    },
    [noteId]
  )
  return { scope, choose }
}

/**
 * The picker beside Generate notes. Only while there is a watched part to choose: with no spans,
 * or most of the video watched, both choices are the whole video.
 */
export function ScopePicker({ scope, onChoose }: { scope: LessonScope; onChoose(choice: Choice): void }): JSX.Element | null {
  if (scope.defaultChoice !== 'watched') return null
  return (
    <select className="enh-scope" aria-label="Notes cover" value={scope.choice} onChange={(e) => onChoose(e.target.value === 'whole' ? 'whole' : 'watched')}>
      <option value="watched">{`Watched part (${lengthLabel(scope.watchedMs)})`}</option>
      <option value="whole">{scope.totalMs ? `Whole video (${lengthLabel(scope.totalMs)})` : 'Whole video'}</option>
    </select>
  )
}

/**
 * Before generating: the scoped transcript is over the model's budget. No range is named:
 * generation sends the whole scope and the model decides what it reads.
 */
export function ScopeWarning({ scope }: { scope: LessonScope }): JSX.Element | null {
  if (scope.cutAtMs === null) return null
  return (
    <p className="enh-scope-warning" role="note">
      The part you chose may be longer than your AI model can read at once.
    </p>
  )
}

/** "From 0:00–42:10 of 2:25:51 and your 12 notes". */
export function scopeFooterText(scope: LessonScope): string | null {
  if (scope.startMs === null || scope.endMs === null) return null
  let text = `From ${clockLabel(scope.startMs)}–${clockLabel(scope.endMs)}`
  if (scope.totalMs) text += ` of ${clockLabel(scope.totalMs)}`
  if (scope.noteCount > 0) text += ` and your ${scope.noteCount} ${scope.noteCount === 1 ? 'note' : 'notes'}`
  return text
}

export function LessonNotesFooter({ noteId }: { noteId: string }): JSX.Element | null {
  const { scope } = useLessonScope(noteId, true)
  const text = scope ? scopeFooterText(scope) : null
  return text ? <p className="enh-scope-footer">{text}</p> : null
}

const CITATION = /\[(?:(\d+):)?(\d{1,2}):(\d{2})\]/g
const LINK_TIME = /^\[?(?:(\d+):)?(\d{1,2}):(\d{2})\]?$/

function toMs(m: RegExpMatchArray | RegExpExecArray): number {
  return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1_000
}

/** The `[mm:ss]` under the pointer: a time link, or the citation text around the caret. */
function citationAt(e: ReactMouseEvent): number | null {
  const link = (e.target as HTMLElement).closest?.('a')
  const linked = link ? LINK_TIME.exec((link.textContent ?? '').trim()) : null
  if (linked) return toMs(linked)
  let node: Node | null = null
  let offset = 0
  const pos = document.caretPositionFromPoint?.(e.clientX, e.clientY)
  if (pos) {
    node = pos.offsetNode
    offset = pos.offset
  }
  if (!node || node.nodeType !== Node.TEXT_NODE) return null
  for (const m of (node.textContent ?? '').matchAll(CITATION)) {
    const at = m.index ?? 0
    if (offset >= at && offset <= at + m[0].length) return toMs(m)
  }
  return null
}

/** A click handler for lesson notes: a citation seeks the lesson's player. Null on other notes. */
export function useCitationJump(noteId: string): ((e: ReactMouseEvent) => void) | null {
  const view = useNoteSource(noteId)
  const url = view?.source.url ?? null
  const handler = useCallback(
    (e: ReactMouseEvent): void => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey) return
      const ms = citationAt(e)
      if (ms === null) return
      e.preventDefault()
      e.stopPropagation()
      void jumpToPosition(noteId, url, ms, { newTab: e.shiftKey })
    },
    [noteId, url]
  )
  return view ? handler : null
}
