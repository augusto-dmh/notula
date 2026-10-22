// SPDX-License-Identifier: Apache-2.0
// Validation of the chat IPC payloads. The renderer is untrusted input:
// every field is checked and copied, never passed through.

import { notulaError } from '@shared/errors'
import type { ChatEditorTarget, ChatPlace, ChatSendRequest, ChatSurface, DocRef, ToolCallUpdate } from '@shared/types/chat'
import type { RecipeUpsert } from '@shared/types/recipes'
import { expected } from '../ipc-expected'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// `meeting_dock` is offered read-only tools only. Grouping keys `task:*` and
// `meeting-dock:<noteId>` pass the same string check, with places `meeting` or `global`.
const SURFACES: readonly ChatSurface[] = ['sidebar', 'floating', 'fullscreen', 'quick_ask', 'meeting_dock']
const MAX_TEXT = 50_000
const MAX_MARKDOWN = 1_000_000
const MAX_REFS = 100
const MAX_DOC_IDS = 2_000
/** Chat files on one message (one selection holds at most 200; a message carries fewer). */
const MAX_ATTACHMENTS = 20

export function bad(message: string): Error {
  return expected(notulaError('invalid-input', message))
}

export function uuid(v: unknown, what: string): string {
  if (typeof v !== 'string' || !UUID.test(v)) throw bad(`${what} must be a UUID.`)
  return v.toLowerCase()
}

function str(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string') throw bad(`${what} must be text.`)
  if (v.length > max) throw bad(`${what} is too long.`)
  return v
}

function optStr(v: unknown, what: string, max: number): string | null {
  return v === null || v === undefined ? null : str(v, what, max)
}

function refs(v: unknown, what: string): DocRef[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || v.length > MAX_REFS) throw bad(`${what} must be a short list.`)
  const out: DocRef[] = []
  for (const r of v) {
    const o = r as Partial<DocRef> | null
    const id = uuid(o?.id, `${what} id`)
    if (out.some((x) => x.id === id)) continue
    out.push({ id, title: typeof o?.title === 'string' ? o.title.slice(0, 500) : '' })
  }
  return out
}

export function parsePlace(v: unknown): ChatPlace {
  const p = v as Record<string, unknown> | null
  switch (p?.['kind']) {
    case 'global':
      return { kind: 'global' }
    case 'meeting':
      return { kind: 'meeting', noteId: uuid(p['noteId'], 'place.noteId') }
    case 'search': {
      const type = p['type']
      if (type !== 'person' && type !== 'company' && type !== 'freeform') throw bad('place.type is invalid.')
      const ids = p['documentIds']
      if (!Array.isArray(ids) || ids.length > MAX_DOC_IDS) throw bad('place.documentIds must be a list.')
      return { kind: 'search', query: str(p['query'], 'place.query', 1_000), type, documentIds: ids.map((i) => uuid(i, 'place.documentIds')) }
    }
    case 'list':
      return { kind: 'list', folderId: str(p['folderId'], 'place.folderId', 200) }
    default:
      throw bad('place is invalid.')
  }
}

function parseTarget(v: unknown): ChatEditorTarget | null {
  if (v === null || v === undefined) return null
  const t = v as Record<string, unknown>
  const markdown = str(t['markdown'], 'target.markdown', MAX_MARKDOWN)
  if (t['kind'] === 'summary') return { kind: 'summary', panelId: uuid(t['panelId'], 'target.panelId'), markdown }
  if (t['kind'] === 'notes') return { kind: 'notes', markdown }
  throw bad('target is invalid.')
}

function parsePreview(v: unknown): ChatSendRequest['preview'] {
  if (v === null || v === undefined) return null
  const p = v as Record<string, unknown>
  const recipe = p['recipe'] as Partial<RecipeUpsert> | null
  const instructions = recipe?.config?.instructions
  if (!recipe || typeof instructions !== 'string' || !instructions.trim()) throw bad('Write a prompt for this recipe first.')
  if (instructions.length > MAX_TEXT) throw bad('The recipe prompt is too long.')
  const noteIds = p['noteIds']
  if (!Array.isArray(noteIds) || noteIds.length === 0 || noteIds.length > 3) throw bad('preview.noteIds must name 1–3 notes.')
  const model = recipe.config?.model
  return {
    recipe: {
      slug: typeof recipe.slug === 'string' ? recipe.slug.slice(0, 200) : '',
      config: {
        instructions,
        makes_artifact: false,
        examples: [],
        shared_tab_visible: false,
        ...(typeof model === 'string' && model.trim() ? { model: model.trim().slice(0, 200) } : {}),
        ...(Array.isArray(recipe.config?.extra_context) ? { extra_context: recipe.config.extra_context } : {})
      }
    },
    noteIds: noteIds.map((i) => uuid(i, 'preview.noteIds'))
  }
}

function parseApproval(v: unknown): ChatSendRequest['approval'] {
  if (v === null || v === undefined) return null
  const a = v as Record<string, unknown>
  if (a['status'] !== 'approved' && a['status'] !== 'denied') throw bad('approval.status is invalid.')
  const args = a['args']
  if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) throw bad('approval.args must be an object.')
  return {
    assistantMessageId: uuid(a['assistantMessageId'], 'approval.assistantMessageId'),
    toolCallId: str(a['toolCallId'], 'approval.toolCallId', 200),
    approvalId: str(a['approvalId'], 'approval.approvalId', 200),
    status: a['status'],
    ...(typeof a['reason'] === 'string' ? { reason: a['reason'].slice(0, 1_000) } : {}),
    ...(args ? { args: args as Record<string, unknown> } : {})
  }
}

export function parseSendRequest(raw: unknown): ChatSendRequest {
  if (!raw || typeof raw !== 'object') throw bad('The message is invalid.')
  const r = raw as Record<string, unknown>
  const surface = r['surface']
  if (!SURFACES.includes(surface as ChatSurface)) throw bad('surface is invalid.')
  const edit = r['edit'] as { messageId?: unknown } | null | undefined
  const style = r['responseStyle']
  return {
    requestId: uuid(r['requestId'], 'requestId'),
    threadId: r['threadId'] === null || r['threadId'] === undefined ? null : uuid(r['threadId'], 'threadId'),
    groupingKey: str(r['groupingKey'], 'groupingKey', 500),
    surface: surface as ChatSurface,
    place: parsePlace(r['place']),
    text: str(r['text'] ?? '', 'text', MAX_TEXT),
    mentions: refs(r['mentions'], 'mentions'),
    recipeId: optStr(r['recipeId'], 'recipeId', 200),
    selectedDocuments: refs(r['selectedDocuments'], 'selectedDocuments'),
    target: parseTarget(r['target']),
    selectionMarkdown: optStr(r['selectionMarkdown'], 'selectionMarkdown', MAX_MARKDOWN),
    editWithAi: r['editWithAi'] === true,
    responseStyle: style === 'detailed' ? 'detailed' : 'default',
    edit: edit ? { messageId: uuid(edit.messageId, 'edit.messageId') } : null,
    approval: parseApproval(r['approval']),
    preview: parsePreview(r['preview']),
    ...(r['attachmentIds'] !== undefined && r['attachmentIds'] !== null ? { attachmentIds: attachmentIds(r['attachmentIds']) } : {})
  }
}

function attachmentIds(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > MAX_ATTACHMENTS) throw bad(`attachmentIds must list at most ${MAX_ATTACHMENTS} files.`)
  return [...new Set(v.map((i) => uuid(i, 'attachmentIds')))]
}

export function parseToolCallUpdate(raw: unknown): ToolCallUpdate {
  const r = (raw ?? {}) as Record<string, unknown>
  const patch = (r['patch'] ?? {}) as Record<string, unknown>
  const out: ToolCallUpdate['patch'] = {}
  if (patch['reverted'] !== undefined) {
    if (typeof patch['reverted'] !== 'boolean') throw bad('patch.reverted must be a boolean.')
    out.reverted = patch['reverted']
  }
  if (patch['error'] !== undefined) out.error = optStr(patch['error'], 'patch.error', 500)
  return {
    threadId: uuid(r['threadId'], 'threadId'),
    messageId: uuid(r['messageId'], 'messageId'),
    toolCallId: str(r['toolCallId'], 'toolCallId', 200),
    patch: out
  }
}
