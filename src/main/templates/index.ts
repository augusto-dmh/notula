// SPDX-License-Identifier: Apache-2.0
// registerTemplates(): the `templates:*` IPC, the built-in catalog merged with stored
// templates, and the per-note temporary template. Handlers are registered with literal channels
// only. Writes never target a built-in and never store `is_builtin`.

import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes, PushChannel, SendChannel, SendPayload } from '@shared/ipc'
import type { NoteTemplate, NoteTemplateCreate, NoteTemplatePatch, TemplateIcon, TemplateSection } from '@shared/types/templates'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { builtinTemplate, builtinTemplates, isBuiltinTemplateId } from './catalog'
import { setNoteTemplate } from './pending'

export { clearNoteTemplate, noteTemplate } from './pending'

const MAX_TITLE = 200
const MAX_DESCRIPTION = 20_000
const MAX_SECTIONS = 50
const MAX_HEADING = 300
const MAX_SECTION_DESCRIPTION = 5_000
const MAX_CATEGORY = 100
const MAX_ID = 100
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ICON_NAME = /^[a-z0-9-]{1,40}$/
const ICON_COLOR = /^[a-z0-9-]{1,24}$/
const EMOJI_HEXCODE = /^[0-9A-F]{2,8}(?:-[0-9A-F]{2,8})*$/

function bad(message: string): Error {
  return expected(notulaError('invalid-input', message))
}

function text(v: unknown, name: string, max: number): string {
  if (typeof v !== 'string' || v.length > max) throw bad(`${name} is invalid.`)
  return v
}

function sections(v: unknown): TemplateSection[] {
  if (!Array.isArray(v) || v.length > MAX_SECTIONS) throw bad('sections is invalid.')
  return v.map((raw, i) => {
    const s = (raw ?? {}) as Partial<Record<keyof TemplateSection, unknown>>
    const id = typeof s.id === 'string' && s.id && s.id.length <= MAX_ID ? s.id : randomUUID()
    return {
      id,
      heading: text(s.heading ?? '', `sections[${i}].heading`, MAX_HEADING),
      section_hint: text(s.section_hint ?? '', `sections[${i}].section_hint`, MAX_SECTION_DESCRIPTION)
    }
  })
}

function icon(v: unknown): TemplateIcon | null {
  if (v === null || v === undefined) return null
  const i = v as Record<string, unknown>
  if (i['type'] === 'icon' && typeof i['value'] === 'string' && ICON_NAME.test(i['value'])) {
    const color = typeof i['color'] === 'string' && ICON_COLOR.test(i['color']) ? i['color'] : 'gray'
    return { type: 'icon', value: i['value'], color }
  }
  if (
    i['type'] === 'emoji' &&
    typeof i['value'] === 'string' &&
    i['value'].length > 0 &&
    i['value'].length <= 16 &&
    typeof i['hexcode'] === 'string' &&
    EMOJI_HEXCODE.test(i['hexcode'])
  ) {
    return { type: 'emoji', value: i['value'], hexcode: i['hexcode'] }
  }
  throw bad('icon is invalid.')
}

function templateId(v: unknown): string {
  if (typeof v !== 'string' || !v || v.length > MAX_ID) throw bad('id is required.')
  return v
}

function parseCreate(raw: unknown): NoteTemplateCreate {
  const r = (raw ?? {}) as Partial<Record<keyof NoteTemplateCreate, unknown>>
  let id: string | undefined
  if (r.id !== undefined && r.id !== null) {
    if (typeof r.id !== 'string' || !UUID.test(r.id)) throw bad('id is invalid.')
    if (isBuiltinTemplateId(r.id)) throw bad('Built-in templates can’t be changed.')
    id = r.id.toLowerCase()
  }
  const category = r.category === null || r.category === undefined ? null : text(r.category, 'category', MAX_CATEGORY)
  const copiedFrom = r.copied_from === null || r.copied_from === undefined ? null : templateId(r.copied_from)
  return {
    ...(id ? { id } : {}),
    title: text(r.title ?? '', 'title', MAX_TITLE),
    description: text(r.description ?? '', 'description', MAX_DESCRIPTION),
    sections: sections(r.sections ?? []),
    category,
    icon: icon(r.icon),
    copied_from: copiedFrom
  }
}

function parsePatch(raw: unknown): NoteTemplatePatch {
  if (!raw || typeof raw !== 'object') throw bad('patch is required.')
  const p = raw as Record<string, unknown>
  const out: NoteTemplatePatch = {}
  if (p['title'] !== undefined) out.title = text(p['title'], 'title', MAX_TITLE)
  if (p['description'] !== undefined) out.description = text(p['description'], 'description', MAX_DESCRIPTION)
  if (p['sections'] !== undefined) out.sections = sections(p['sections'])
  if (p['icon'] !== undefined) out.icon = icon(p['icon'])
  return out
}

/** Every template the user can see: their own rows (by title), then the built-ins. */
export async function listAllTemplates(ctx: MainContext): Promise<NoteTemplate[]> {
  return [...(await ctx.storage.listTemplates()), ...builtinTemplates()]
}

/** A built-in or a stored template by id (a deleted row still resolves: panels keep its slug). */
export async function findTemplate(ctx: MainContext, id: string): Promise<NoteTemplate | null> {
  return builtinTemplate(id) ?? (await ctx.storage.getTemplate(id.toLowerCase()))
}

export function registerTemplates(ctx: MainContext): void {
  ipcMain.handle('templates:list' satisfies InvokeChannel, (): Promise<InvokeRes<'templates:list'>> => listAllTemplates(ctx))

  ipcMain.handle(
    'templates:create' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'templates:create'>): Promise<InvokeRes<'templates:create'>> => {
      const t = await ctx.storage.createTemplate(parseCreate(req))
      log('info', 'templates:created', { id: t.id, copiedFrom: t.copied_from })
      return t
    }
  )

  ipcMain.handle(
    'templates:update' satisfies InvokeChannel,
    (_e, req: InvokeReq<'templates:update'>): Promise<InvokeRes<'templates:update'>> => {
      const id = templateId(req?.id)
      if (isBuiltinTemplateId(id)) throw bad('Built-in templates can’t be changed.')
      return ctx.storage.updateTemplate(id, parsePatch(req?.patch))
    }
  )

  ipcMain.handle('templates:delete' satisfies InvokeChannel, async (_e, req: InvokeReq<'templates:delete'>): Promise<void> => {
    const id = templateId(req?.id)
    if (isBuiltinTemplateId(id)) throw bad('Built-in templates can’t be deleted.')
    await ctx.storage.updateTemplate(id, { deleted_at: new Date().toISOString() })
    log('info', 'templates:deleted', { id })
  })

  ipcMain.on('templates:set-note-template' satisfies SendChannel, (_e, raw: SendPayload<'templates:set-note-template'>) => {
    const noteId = raw?.noteId
    const id = raw?.templateId
    if (typeof noteId !== 'string' || !noteId || noteId.length > MAX_ID) return
    if (id !== null && (typeof id !== 'string' || !id || id.length > MAX_ID)) return
    setNoteTemplate(noteId, id)
    log('debug', 'templates:note-template', { noteId, templateId: id })
  })

  ctx.bus.on('storage:changed', (change) => {
    if (!change.tables.includes('note_templates')) return
    const payload = { ids: change.ids }
    for (const wc of ctx.windows.targets()) wc.send('templates:changed' satisfies PushChannel, payload)
  })
}
