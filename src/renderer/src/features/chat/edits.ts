// SPDX-License-Identifier: Apache-2.0
// Note edits from chat: while an answer streams, an edit call's
// passage is highlighted (the first one scrolled into view); each completed call joins
// a per-answer queue and is applied in order through the editor's animated `replacePassage`
// (read-only, delete, 200 ms, insert, 300 ms). A passage that is gone marks the call
// "Unable to apply edit". Undo and Reapply run every successful edit of an answer
// backwards or forwards, one second apart, and refuse when the notes have changed.

import { parseError } from '@shared/errors'
import type { ChatToolCall } from '@shared/types/chat'
import { debugLog } from '../../app/platform'
import { showToast } from '../../app/toast'
import type { EditorHandle } from '../../editor/types'
import type { AssistantView } from './Conversation'
import { watchOutputs, type LiveAnswer } from './store'
import { streamingTextToReplace } from './util'

export const UNABLE_TO_APPLY = 'Couldn’t apply the edit'
const STEP_MS = 1_000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function report(threadId: string | null, messageId: string | null, toolCallId: string, patch: { reverted?: boolean; error?: string | null }): Promise<void> {
  if (!threadId || !messageId) return
  try {
    await window.notula.chat.updateToolCall({ threadId, messageId, toolCallId, patch })
  } catch (err) {
    debugLog('chat:tool-call-update-failed', { err: parseError(err).message })
  }
}

function editArgs(c: ChatToolCall): { oldText: string; newText: string } {
  return {
    oldText: typeof c.args['findText'] === 'string' ? c.args['findText'] : '',
    newText: typeof c.args['newText'] === 'string' ? c.args['newText'] : ''
  }
}

/**
 * Follows one answer's edit calls into the editor `getEditor` returns (null when the
 * target is no longer on screen, which fails the edit). Stops by itself once the
 * answer has ended and its queue is drained.
 */
export function followEdits(requestId: string, getEditor: () => EditorHandle | null): void {
  const seen = new Set<string>()
  let queue: Promise<void> = Promise.resolve()
  let scrolled = false
  let highlighted: string | null = null
  let off: (() => void) | null = null

  const apply = async (c: ChatToolCall, l: LiveAnswer): Promise<void> => {
    const editor = getEditor()
    const { oldText, newText } = editArgs(c)
    let ok = false
    try {
      ok = !!editor && !!oldText && (await editor.replacePassage(oldText, newText, { animate: true }))
    } catch (err) {
      debugLog('chat:edit-apply-failed', { err: String(err) })
    }
    if (ok) return
    editor?.highlightPassage(null)
    debugLog('chat-note-edit-failed', { toolCallId: c.id })
    await report(l.threadId, l.assistantMessageId, c.id, { error: UNABLE_TO_APPLY })
  }

  off = watchOutputs(requestId, (l) => {
    for (const o of l.outputs) {
      if (o.type !== 'tool_call' || o.tool_call.name !== 'editNote') continue
      const c = o.tool_call
      if (seen.has(c.id)) continue
      if (c.completed && !c.error && c.result) {
        seen.add(c.id)
        queue = queue.then(() => apply(c, l))
      } else if (!c.completed && !c.error) {
        const passage = streamingTextToReplace(c)
        if (passage && passage !== highlighted) {
          highlighted = passage
          getEditor()?.highlightPassage(passage, { scroll: !scrolled })
          scrolled = true
        }
      }
    }
    if (l.status === 'completed' || l.status === 'cancelled' || l.status === 'error') {
      if (l.status !== 'completed') getEditor()?.highlightPassage(null)
      const stop = off
      off = null
      void queue.then(() => stop?.())
    }
  })
}

/** Undo (backwards) or Reapply (forwards) every successful edit of an answer. */
export async function replayEdits(view: AssistantView, editor: EditorHandle, direction: 'undo' | 'reapply'): Promise<void> {
  const calls = view.outputs
    .filter((o): o is Extract<typeof o, { type: 'tool_call' }> => o.type === 'tool_call' && o.tool_call.name === 'editNote')
    .map((o) => o.tool_call)
    .filter((c) => (direction === 'undo' ? c.completed && !c.error && !c.reverted : c.reverted))
  if (calls.length === 0) return
  // Nothing changes unless every edit still matches; a deletion is undone with the editor's own undo.
  const stale = calls.some((c) => {
    const { oldText, newText } = editArgs(c)
    return direction === 'undo' ? newText !== '' && !editor.hasPassage(newText) : !editor.hasPassage(oldText)
  })
  if (stale) {
    showToast({ title: direction === 'undo' ? 'Cannot undo edits to changed notes' : 'Cannot reapply edits to changed notes', kind: 'error' })
    return
  }
  const ordered = direction === 'undo' ? [...calls].reverse() : calls
  for (let i = 0; i < ordered.length; i++) {
    const c = ordered[i] as ChatToolCall
    const { oldText, newText } = editArgs(c)
    if (i > 0) await sleep(STEP_MS)
    if (direction === 'undo') {
      if (newText === '') editor.undo()
      else await editor.replacePassage(newText, oldText, { animate: true })
    } else {
      await editor.replacePassage(oldText, newText, { animate: true })
    }
  }
  for (const c of calls) await report(view.threadId, view.id, c.id, { reverted: direction === 'undo' })
}
