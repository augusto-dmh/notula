// SPDX-License-Identifier: Apache-2.0
// A task's chat: the thread group `task:<documentId>:<nodePath>` (manual
// tasks: `task:manual:<id>`), on the user's chat provider. The first message of a thread is sent
// here, with the task's grouping key (the chat store derives keys from places, so it cannot);
// the answer streams into this store until it is stored, then the chat surface shows the thread.

import { useSyncExternalStore } from 'react'
import { parseError } from '@shared/errors'
import type { ChatPlace } from '@shared/types/chat'
import type { ManualTask, TaskGroup, TaskItem } from '@shared/types/tasks'

export type SelectedTask =
  | { kind: 'manual'; task: ManualTask }
  | { kind: 'meeting'; item: TaskItem; group: Pick<TaskGroup, 'documentId' | 'title' | 'meetingAt'> }

export interface LiveRun {
  key: string
  requestId: string
  threadId: string | null
  text: string
  working: boolean
  status: 'streaming' | 'done' | 'error'
  error: string | null
}

export function taskKey(t: SelectedTask): string {
  return t.kind === 'manual' ? `task:manual:${t.task.id}` : `task:${t.item.documentId}:${t.item.nodePath.join('.')}`
}

export function taskTitle(t: SelectedTask): string {
  return t.kind === 'manual' ? t.task.text : t.item.text
}

export function taskSubtitle(t: SelectedTask): string {
  return t.kind === 'manual' ? 'Manual task' : t.group.title || 'New note'
}

export function taskPlace(t: SelectedTask): ChatPlace {
  return t.kind === 'manual' ? { kind: 'global' } : { kind: 'meeting', noteId: t.item.documentId }
}

/** The run prompt: the task, its meeting and surrounding lines, then how to help. */
export function runPrompt(t: SelectedTask): string {
  const lines: string[] = [`Task: ${taskTitle(t)}`]
  if (t.kind === 'meeting') {
    const date = new Date(t.group.meetingAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    lines.push(`From the meeting "${t.group.title || 'New note'}" on ${date}.`)
    if (t.item.description) lines.push(`Details: ${t.item.description}`)
    if (t.item.context) lines.push('', 'The lines around it in my notes:', t.item.context)
  } else {
    lines.push('I added this task myself.')
  }
  lines.push(
    '',
    'Help me get this done:',
    '- First check my notes, the meeting and its transcript for what the task needs: who it is for, the facts, the deadline.',
    '- If it is something you can prepare (an email, a message, a document, an agenda, an event), draft it ready to use, with the details from my notes kept exactly, and mark anything my notes do not settle as a question for me instead of guessing.',
    '- Otherwise give me a short, concrete plan for the next step.',
    '- Keep it brief and tell me what you used from my notes.'
  )
  return lines.join('\n')
}

// ---------- the live first answers ----------

let runs: ReadonlyMap<string, LiveRun> = new Map()
const listeners = new Set<() => void>()
let subscribed = false

function set(next: Map<string, LiveRun>): void {
  runs = next
  for (const l of listeners) l()
}

function update(requestId: string, patch: (r: LiveRun) => LiveRun): void {
  for (const [key, r] of runs) {
    if (r.requestId !== requestId) continue
    const next = new Map(runs)
    next.set(key, patch(r))
    set(next)
    return
  }
}

function subscribe(): void {
  if (subscribed) return
  subscribed = true
  window.notula.chat.onEvent((e) => {
    switch (e.type) {
      case 'text_delta':
        update(e.requestId, (r) => ({ ...r, threadId: e.threadId, text: r.text + e.delta, working: false }))
        break
      case 'output_update':
      case 'outputs':
        update(e.requestId, (r) => ({ ...r, threadId: e.threadId, working: true }))
        break
      case 'stream_done':
        update(e.requestId, (r) => ({ ...r, threadId: e.threadId, status: 'done', working: false }))
        break
      case 'error':
        update(e.requestId, (r) => ({ ...r, threadId: e.threadId, status: 'error', error: e.error, working: false }))
        break
      default:
        break
    }
  })
}

export function useRuns(): ReadonlyMap<string, LiveRun> {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => runs
  )
}

export function isStreaming(key: string): boolean {
  return runs.get(key)?.status === 'streaming'
}

/** Starts a new thread in the task's group with `text`. Resolves with the thread id, or throws. */
export async function sendFirst(t: SelectedTask, text: string): Promise<string> {
  subscribe()
  const key = taskKey(t)
  const requestId = crypto.randomUUID()
  const next = new Map(runs)
  next.set(key, { key, requestId, threadId: null, text: '', working: true, status: 'streaming', error: null })
  set(next)
  try {
    const accepted = await window.notula.chat.sendMessage({
      requestId,
      threadId: null,
      groupingKey: key,
      surface: 'sidebar',
      place: taskPlace(t),
      text,
      mentions: [],
      recipeId: null,
      selectedDocuments: [],
      target: null,
      selectionMarkdown: null,
      editWithAi: false,
      responseStyle: 'default',
      edit: null,
      approval: null,
      preview: null
    })
    update(requestId, (r) => ({ ...r, threadId: accepted.threadId }))
    return accepted.threadId
  } catch (err) {
    const message = parseError(err).message || 'The task could not be sent.'
    update(requestId, (r) => ({ ...r, status: 'error', error: message, working: false }))
    throw new Error(message)
  }
}

/** Forgets a finished first answer once the chat surface shows the stored thread. */
export function clearRun(key: string): void {
  if (!runs.has(key)) return
  const next = new Map(runs)
  next.delete(key)
  set(next)
}
