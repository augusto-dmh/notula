// SPDX-License-Identifier: Apache-2.0
// Folder tools: findFolders and locateNotes (also served by the local MCP server), the two
// ✱ writes createFolder and organizeNote, and the folder files (listFolderAttachments,
// readFile). Writes go through the same storage calls as the folder IPC, so the
// folder pushes and bus events follow as for a renderer change.

import { CHAT_LIMITS } from '@shared/types/chat'
import type { Folder, FoldersState } from '@shared/types/folders'
import type { MainContext } from '../context'
import { createRequest } from '../folders/validate'
import { docRef, folders, forgetFolders, noteTitle } from './library'
import { truncateLines } from './text'
import { fail, idsArg, okJson, type LocalTool } from './tools'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function state(ctx: MainContext): Promise<FoldersState> {
  const s = await folders(ctx)
  if (!s) throw new Error('Folders are not available right now.')
  return s
}

/** A folder by id, else by exact title (case-insensitive); null when none or ambiguous. */
function resolveFolder(s: FoldersState, ref: string): Folder | null {
  const r = ref.trim()
  const byId = s.folders.find((f) => f.id.toLowerCase() === r.toLowerCase())
  if (byId) return byId
  const named = s.folders.filter((f) => f.title.trim().toLowerCase() === r.toLowerCase())
  return named.length === 1 ? (named[0] as Folder) : null
}

function folderRefs(v: unknown): string[] {
  const raw = typeof v === 'string' ? [v] : Array.isArray(v) ? v : []
  return raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
}

const findFolders: LocalTool = {
  def: {
    name: 'findFolders',
    description: "Finds the user's folders by name and returns their ids, titles and note counts. Without a query, lists every folder.",
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', maxLength: 200, description: 'Part of the folder name to look for.' } },
      additionalProperties: false
    }
  },
  category: 'notes',
  title: 'Find folders',
  needsApproval: false,
  readOnly: true,
  available: () => true,
  run: async (args, env) => {
    const s = await state(env.ctx)
    const q = typeof args['query'] === 'string' ? args['query'].trim().toLowerCase() : ''
    const found = s.folders
      .filter((f) => !q || f.title.toLowerCase().includes(q))
      .sort((a, b) => Number(b.is_favourite) - Number(a.is_favourite) || a.title.localeCompare(b.title))
      .map((f) => ({ id: f.id, title: f.title, noteCount: s.membership[f.id]?.length ?? 0, parentId: f.parent_id }))
    return okJson({ folders: found })
  }
}

const locateNotes: LocalTool = {
  def: {
    name: 'locateNotes',
    description: 'Returns the folders each given note is in.',
    inputSchema: {
      type: 'object',
      properties: { note_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20, description: 'The ids of the notes.' } },
      required: ['note_ids'],
      additionalProperties: false
    }
  },
  category: 'notes',
  title: 'Find note locations',
  needsApproval: false,
  readOnly: true,
  available: () => true,
  validate: (args) => (idsArg(args['note_ids']).every((id) => UUID.test(id)) ? null : 'note_ids must be note ids (UUIDs).'),
  run: async (args, env) => {
    const s = await state(env.ctx)
    const ids = idsArg(args['note_ids'])
    return okJson({
      notes: ids.map((id) => ({
        id,
        folders: s.folders.filter((f) => s.membership[f.id]?.includes(id)).map((f) => ({ id: f.id, title: f.title }))
      }))
    })
  }
}

// ---------- ✱ createFolder ----------

function createTarget(args: Record<string, unknown>, s: FoldersState): { parent: Folder | null; error: string | null } {
  const location = args['location'] ?? 'my_notes'
  if (location === 'shared') return { parent: null, error: 'Shared folders need a Notula server, which this version does not have. Create it in My notes instead.' }
  if (location !== 'existing') return { parent: null, error: null }
  const ref = typeof args['parent_id'] === 'string' && args['parent_id'].trim() ? args['parent_id'] : typeof args['parent_name'] === 'string' ? args['parent_name'] : ''
  if (!ref.trim()) return { parent: null, error: 'With location existing, give parent_id or parent_name.' }
  const parent = resolveFolder(s, ref)
  if (!parent) return { parent: null, error: `No single folder matches "${ref.trim()}".` }
  if (parent.parent_id) return { parent: null, error: 'Folders can be nested only one level deep.' }
  return { parent, error: null }
}

const createFolder: LocalTool = {
  def: {
    name: 'createFolder',
    description: "Creates a folder for notes. Waits for the user's approval.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200, description: "The new folder's name." },
        location: { type: 'string', enum: ['my_notes', 'shared', 'existing'], description: "my_notes: a top-level folder of the user's own; shared: a top-level shared folder; existing: inside the folder given by parent_id or parent_name." },
        parent_name: { type: 'string', description: 'With location existing: the name of the folder to create it in.' },
        parent_id: { type: 'string', description: 'With location existing: the id of the folder to create it in (preferred over parent_name).' }
      },
      required: ['title'],
      additionalProperties: false
    }
  },
  category: 'notes',
  title: 'Create a folder',
  needsApproval: true,
  readOnly: false,
  available: () => true,
  validate: (args) => (typeof args['title'] === 'string' && args['title'].trim() ? null : 'title is empty.'),
  preview: async (args, env) => {
    const title = String(args['title'] ?? '').trim()
    const s = await folders(env.ctx)
    const target = s ? createTarget(args, s) : { parent: null, error: null }
    return {
      title: `Create folder “${title}”?`,
      lines: [target.parent ? `Inside “${target.parent.title}”` : 'In My notes'],
      editableTitle: title
    }
  },
  run: async (args, env) => {
    const s = await state(env.ctx)
    const target = createTarget(args, s)
    if (target.error) return fail(target.error)
    const folder = await env.ctx.storage.createFolder(
      createRequest({ title: String(args['title']).trim(), ...(target.parent ? { parentId: target.parent.id } : {}) })
    )
    forgetFolders()
    return okJson({ id: folder.id, title: folder.title })
  }
}

// ---------- ✱ organizeNote ----------

async function organizeFacts(
  ctx: MainContext,
  args: Record<string, unknown>
): Promise<{ noteTitle: string; add: Folder[]; remove: Folder[]; missing: string[]; noteFound: boolean }> {
  const s = await state(ctx)
  const noteId = String(args['noteId'] ?? '').trim().toLowerCase()
  const note = UUID.test(noteId) ? await ctx.storage.getNote(noteId).catch(() => null) : null
  const missing: string[] = []
  const pick = (refs: string[]): Folder[] =>
    refs
      .map((r) => {
        const f = resolveFolder(s, r)
        if (!f) missing.push(r)
        return f
      })
      .filter((f): f is Folder => !!f)
  return {
    noteTitle: note && !note.deleted_at ? noteTitle(note) : 'this note',
    add: pick(folderRefs(args['addTo'])),
    remove: pick(folderRefs(args['removeFrom'])),
    missing,
    noteFound: !!note && !note.deleted_at
  }
}

const organizeNote: LocalTool = {
  def: {
    name: 'organizeNote',
    description:
      "Adds a note to folders, removes it from folders, or both (a move). Waits for the user's approval. Use findFolders first when you are unsure of a folder's exact name.",
    inputSchema: {
      type: 'object',
      properties: {
        noteId: { type: 'string', description: 'The id of the note to file.' },
        addTo: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, maxItems: 10 }], description: 'The folders to add the note to, by id or exact name.' },
        removeFrom: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, maxItems: 10 }], description: 'The folders to take the note out of, by id or exact name.' }
      },
      required: ['noteId'],
      additionalProperties: false
    }
  },
  category: 'notes',
  title: 'Organize a note',
  needsApproval: true,
  readOnly: false,
  available: () => true,
  validate: (args) => {
    if (!UUID.test(String(args['noteId'] ?? '').trim())) return 'noteId must be a note id (UUID).'
    return folderRefs(args['addTo']).length + folderRefs(args['removeFrom']).length === 0 ? 'Give addTo or removeFrom.' : null
  },
  preview: async (args, env) => {
    const f = await organizeFacts(env.ctx, args)
    // The names the model gave, with the folder's own title once it resolves.
    const label = (refs: string[], found: Folder[]): string =>
      refs.map((r) => found.find((x) => x.id.toLowerCase() === r.toLowerCase() || x.title.trim().toLowerCase() === r.toLowerCase())?.title ?? r).join(', ')
    const add = label(folderRefs(args['addTo']), f.add)
    const remove = label(folderRefs(args['removeFrom']), f.remove)
    const title = add && remove ? `Move “${f.noteTitle}” from ${remove} to ${add}?` : add ? `Add “${f.noteTitle}” to ${add}?` : `Remove “${f.noteTitle}” from ${remove}?`
    return { title, lines: f.missing.length ? [`No folder named ${f.missing.map((m) => `“${m}”`).join(', ')} yet`] : [] }
  },
  run: async (args, env) => {
    const f = await organizeFacts(env.ctx, args)
    if (!f.noteFound) return fail('That note was not found.')
    if (f.missing.length) return fail(`No single folder matches: ${f.missing.join(', ')}. Use findFolders for the exact title or id.`)
    const noteId = String(args['noteId']).trim().toLowerCase()
    const added: { id: string; title: string }[] = []
    const removed: { id: string; title: string }[] = []
    for (const folder of f.add) {
      await env.ctx.storage.addNotesToFolder(folder.id, [noteId], 'manual')
      added.push({ id: folder.id, title: folder.title })
    }
    for (const folder of f.remove) {
      await env.ctx.storage.removeNoteFromFolder(folder.id, noteId)
      removed.push({ id: folder.id, title: folder.title })
    }
    forgetFolders()
    const note = await env.ctx.storage.getNote(noteId).catch(() => null)
    if (note) env.scanned.set(note.id, docRef(note))
    return okJson({ noteId, added, removed })
  }
}

// ---------- folder files ----------

const listFolderAttachments: LocalTool = {
  def: {
    name: 'listFolderAttachments',
    description: "Lists the files attached to a folder (documents the user added there), with their ids, names and sizes.",
    inputSchema: {
      type: 'object',
      properties: { folder_id: { type: 'string', description: 'The id of the folder.' } },
      required: ['folder_id'],
      additionalProperties: false
    }
  },
  category: 'notes',
  title: 'List folder files',
  needsApproval: false,
  readOnly: true,
  available: (a) => a.folderFiles,
  run: async (args, env) => {
    const files = (await env.ctx.attachments.list({ type: 'folder', id: String(args['folder_id']).trim() })).filter(
      (f) => f.kind === 'file' && f.status !== 'failed'
    )
    const rows = []
    for (const f of files) {
      // The digest the attachments module stores with each file.
      const c = f.has_summary ? await env.ctx.attachments.readContent(f.id, 400).catch(() => null) : null
      rows.push({ id: f.id, name: f.file_name, created_at: f.created_at, content_summary: c?.summary ?? null })
    }
    return okJson({ files: rows })
  }
}

const readFile: LocalTool = {
  def: {
    name: 'readFile',
    description: `Reads the text of a file attached to a folder. Returns at most ${CHAT_LIMITS.readMeetingsChars.toLocaleString('en-US')} characters.`,
    inputSchema: {
      type: 'object',
      properties: { file_id: { type: 'string', description: 'The id of the file, as returned by listFolderAttachments.' } },
      required: ['file_id'],
      additionalProperties: false
    }
  },
  category: 'notes',
  title: 'Read a file',
  needsApproval: false,
  readOnly: true,
  available: (a) => a.folderFiles,
  run: async (args, env) => {
    const id = String(args['file_id']).trim()
    const c = await env.ctx.attachments.readContent(id, CHAT_LIMITS.readMeetingsChars)
    if (!c) return fail('That file was not found, or it is still being processed.')
    const text = c.markdown ?? c.summary ?? ''
    return okJson({ file: { id, name: c.name, content: truncateLines(text, CHAT_LIMITS.readMeetingsChars).text } })
  }
}

export const FOLDER_TOOLS: readonly LocalTool[] = [findFolders, locateNotes, createFolder, organizeNote, listFolderAttachments, readFile]
