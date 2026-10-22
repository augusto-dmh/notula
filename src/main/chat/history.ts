// SPDX-License-Identifier: Apache-2.0
// Conversation history for the model.
// Earlier answers are rebuilt as plain text from their stored outputs, so trimming and
// context changes never invalidate anything: newest turn first, up to the history
// budget, older turns dropped whole, and tool results reduced to one-line summaries.

import type { ChatMessage, ChatOutput, DocRef } from '@shared/types/chat'
import type { LlmChatMessage } from '../llm/types'
import { stripCitationKeys } from './citations'

const MENTION = /@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\s|$)/gi
const RECIPE_LEAD = /^\/([\p{L}\p{N}_-]+)(?=\s|$)/u

/** `@<uuid>` mentions as `@<title>` (`@New note` when unknown). */
export function expandMentions(text: string, refs: readonly DocRef[]): string {
  return text.replace(MENTION, (_m, id: string) => {
    const ref = refs.find((r) => r.id.toLowerCase() === id.toLowerCase())
    return `@${ref?.title || 'New note'}`
  })
}

/** The mentions a stored user message carried. */
export function messageMentions(m: ChatMessage): DocRef[] {
  return m.context?.additionalContext?.mentionedNotes ?? []
}

function userText(m: ChatMessage): string {
  const text = expandMentions(m.raw_text, messageMentions(m))
  const files = (Array.isArray(m.attachments) ? m.attachments : [])
    .map((a) => (a && typeof a === 'object' && typeof (a as { name?: unknown }).name === 'string' ? (a as { name: string }).name : ''))
    .filter(Boolean)
  const out = text.replace(RECIPE_LEAD, (_m, slug: string) => `(Ran the recipe "${slug.replace(/[-_]+/g, ' ')}")`)
  return files.length ? `${out}\n(Attached: ${files.join(', ')})` : out
}

function toolSummary(o: Extract<ChatOutput, { type: 'tool_call' }>): string {
  const c = o.tool_call
  if (c.name === 'askUser') return questionSummary(c)
  if (c.approval?.status === 'denied') return `(Tool ${c.name}: the user declined this change.)`
  if (c.approval?.status === 'pending') return `(Tool ${c.name}: still waiting for the user's approval.)`
  if (c.error) return `(Tool ${c.name} failed: ${c.error})`
  if (c.reverted) return `(Tool ${c.name}: the user reverted this change.)`
  const r = c.result as Record<string, unknown> | string | null
  if (typeof r === 'string') return `(Tool ${c.name}: ${r})`
  if (r && typeof r === 'object') {
    if (typeof r['count'] === 'number') return `(Tool ${c.name}: ${r['count']} meeting${r['count'] === 1 ? '' : 's'} found.)`
    if (typeof r['newPanelId'] === 'string') return `(Tool ${c.name}: started a "Summary Rewrite" panel.)`
  }
  return `(Tool ${c.name} ran.)`
}

/** A question card as text: what was asked and what the user answered (or that they skipped). */
function questionSummary(c: Extract<ChatOutput, { type: 'tool_call' }>['tool_call']): string {
  const qs = (c.approval?.proposedArgs?.['questions'] ?? c.args['questions']) as { id?: string; question?: string }[] | undefined
  const answers = ((c.result as { answers?: Record<string, string[]> } | null)?.answers ?? {}) as Record<string, string[]>
  const asked = (qs ?? []).map((q) => q.question ?? '').filter(Boolean).join(' / ')
  if (c.approval?.status === 'denied') return `(Asked the user: ${asked}. They skipped the questions.)`
  if (c.approval?.status === 'pending') return `(Asked the user: ${asked}. No answer yet.)`
  const lines = (qs ?? []).map((q) => `${q.question ?? ''} → ${(answers[q.id ?? ''] ?? []).join(', ') || '(no answer)'}`)
  return `(Asked the user:\n${lines.join('\n')})`
}

/** An answer as the plain text the model sees on later turns. */
export function assistantText(m: ChatMessage): string {
  const parts: string[] = []
  for (const o of m.outputs ?? []) {
    if (o.type === 'tool_call') parts.push(toolSummary(o))
    else if (o.type === 'text') parts.push(stripCitationKeys(o.text))
    else if (o.type === 'cited_text') parts.push(o.plain_text)
  }
  if (parts.length === 0 && m.raw_text) parts.push(m.raw_text)
  return parts.join('\n\n').trim()
}

/** Earlier turns within `budget` characters, oldest first. */
export function historyMessages(earlier: readonly ChatMessage[], budget: number): { messages: LlmChatMessage[]; dropped: number } {
  const turns = new Map<number, { user?: ChatMessage; assistant?: ChatMessage }>()
  for (const m of earlier) {
    const t = turns.get(m.turn_index) ?? {}
    if (m.role === 'user') t.user = m
    else t.assistant = m
    turns.set(m.turn_index, t)
  }
  const ordered = [...turns.entries()].sort((a, b) => b[0] - a[0])
  const kept: LlmChatMessage[][] = []
  let used = 0
  let dropped = 0
  for (const [, t] of ordered) {
    const msgs: LlmChatMessage[] = []
    const u = t.user ? userText(t.user) : ''
    // An approval-only turn has no user text of its own.
    if (u.trim()) msgs.push({ role: 'user', content: u })
    const a = t.assistant && t.assistant.status !== 'error' ? assistantText(t.assistant) : ''
    if (a) msgs.push({ role: 'assistant', content: a, toolCalls: [] })
    if (msgs.length === 0) continue
    const cost = msgs.reduce((n, m) => n + m.content.length, 0)
    if (used + cost > budget) {
      dropped = ordered.length - kept.length
      break
    }
    used += cost
    kept.push(msgs)
  }
  return { messages: kept.reverse().flat(), dropped }
}
