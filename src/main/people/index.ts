// SPDX-License-Identifier: Apache-2.0
// registerPeople(): the people list and person pages, and the `people:*` IPC.
//
// The maps live in the storage worker (people-repo.ts); a read rebuilds them when
// the notes changed. Main asks for that read after note changes, on the leading edge and
// at most once a minute, and pushes `people:changed` after every
// rebuild, after a folder's notes change (the folder tabs) and after a change to what the
// rows depend on per query ("my emails", the webmail list).

import { ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes, PushChannel } from '@shared/ipc'
import { PEOPLE_LIMITS, type PeopleFilter } from '@shared/types/people'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'

const MAX_QUERY = 200
const MAX_ID = 200
/** Note changes within this window coalesce into one rebuild request (inside the 5 s idle wait). */
const SETTLE_MS = 1_000
const NOTE_TABLES = ['documents', 'calendar_events']

function bad(message: string): Error {
  return expected(notulaError('invalid-input', message))
}

/** `PeopleQuery` / `CompaniesQuery`, whitelisted. */
export function listQuery(raw: unknown): { filter: PeopleFilter; folderId?: string; query?: string } {
  const r = (raw ?? {}) as Record<string, unknown>
  const filter = r['filter'] ?? 'all'
  if (filter !== 'all' && filter !== 'met') throw bad('filter must be all or met.')
  const out: { filter: PeopleFilter; folderId?: string; query?: string } = { filter }
  if (r['folderId'] !== undefined && r['folderId'] !== null) {
    if (typeof r['folderId'] !== 'string' || !r['folderId'] || r['folderId'].length > MAX_ID) throw bad('folderId is invalid.')
    out.folderId = r['folderId']
  }
  if (r['query'] !== undefined && r['query'] !== null) {
    if (typeof r['query'] !== 'string' || r['query'].length > MAX_QUERY) throw bad('query is invalid.')
    if (r['query'].trim()) out.query = r['query'].trim()
  }
  return out
}

export async function myEmails(ctx: MainContext): Promise<string[]> {
  return ctx.calendar.myEmails().catch(() => [])
}

export function pushPeopleChanged(ctx: MainContext): void {
  for (const wc of ctx.windows.targets()) wc.send('people:changed' satisfies PushChannel)
}

export function registerPeople(ctx: MainContext): void {
  ipcMain.handle(
    'people:list' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'people:list'>): Promise<InvokeRes<'people:list'>> =>
      ctx.storage.listPeople({ ...listQuery(req), myEmails: await myEmails(ctx) })
  )

  ipcMain.handle('people:get' satisfies InvokeChannel, async (_e, req: InvokeReq<'people:get'>): Promise<InvokeRes<'people:get'>> => {
    const email = (req as { email?: unknown } | null)?.email
    if (typeof email !== 'string' || !email.trim() || email.length > 320) throw bad('email is invalid.')
    return ctx.storage.getPerson(email.trim().toLowerCase(), await myEmails(ctx))
  })

  // ---------- rebuilds ----------

  let lastAsk = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const ask = async (): Promise<void> => {
    timer = null
    lastAsk = Date.now()
    try {
      // Any read refreshes the maps when the notes changed; an empty email matches no one.
      await ctx.storage.getPerson('', [])
    } catch (err) {
      log('debug', 'people:rebuild-skipped', { err: err instanceof Error ? err.message : String(err) })
    }
  }
  const schedule = (): void => {
    if (timer) return
    timer = setTimeout(() => void ask(), Math.max(SETTLE_MS, lastAsk + PEOPLE_LIMITS.rebuildMinMs - Date.now()))
  }

  let folderTimer: ReturnType<typeof setTimeout> | null = null
  ctx.bus.on('storage:changed', (change) => {
    if (change.tables.includes('people_maps')) pushPeopleChanged(ctx)
    if (change.tables.some((t) => NOTE_TABLES.includes(t))) schedule()
    if (change.tables.includes('folder_notes') && !folderTimer) {
      folderTimer = setTimeout(() => {
        folderTimer = null
        pushPeopleChanged(ctx)
      }, SETTLE_MS)
    }
  })
  ctx.bus.on('storage:status', (s) => {
    if (s.state === 'ready') schedule()
  })
  ctx.bus.on('settings:changed', (e) => {
    if (e.keys.some((k) => k === 'people.genericEmailDomains' || k === 'profile.email')) pushPeopleChanged(ctx)
  })
  // "My emails" come from the calendar accounts too (isSelf, the folder tab's own domain).
  ctx.bus.on('calendar:changed', () => pushPeopleChanged(ctx))
  // Startup: the first build.
  schedule()
}
