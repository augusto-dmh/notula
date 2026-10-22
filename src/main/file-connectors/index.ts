// SPDX-License-Identifier: Apache-2.0
// File connectors: their IPC, the Dropbox plug-in and the chat tools. A Labs extra, off by
// default.
//
// - Google Drive and OneDrive ride the `files-read` grant on the user's calendar account;
//   Dropbox is its own OAuth app (dropbox.ts). Read-only scopes only.
// - Tools are offered only while their connector is connected (no access card), and never in
//   local-only mode, which also refuses every call.
// - Logs carry the connector, the call kind and counts; never names, queries, contents or tokens.

import { ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes } from '@shared/ipc'
import type { CalendarSource } from '@shared/types/calendar'
import { FILE_CONNECTOR_LIMITS, type FileConnectorKey, type FileConnectorStatus, type FileReadResult, type FileSearchResult } from '@shared/types/file-connectors'
import type { ChatToolSpec } from '../chat/tool-api'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { egressBlocked } from '../privacy'
import { dropboxLabel, dropboxPlugin, dropboxToken } from './dropbox'
import { docsGet, driveRead, driveSearch, dropboxRead, dropboxSearch, FILE_COPY, FileError, oneDriveRead, oneDriveSearch } from './providers'

const KEYS: readonly FileConnectorKey[] = ['google_drive', 'onedrive', 'dropbox']
export const CONNECTOR_NAMES: Record<FileConnectorKey, string> = { google_drive: 'Google Drive', onedrive: 'OneDrive', dropbox: 'Dropbox' }
const DOCS_SEARCH = 'findDriveDocs'
const DOCS_READ = 'readDriveDoc'
/** Connector-action tool names: `files_search_<key>` / `files_read_<key>` (the envelope's `connectorTool` is `files.search` / `files.read`). */
export const actionTool = (key: FileConnectorKey, action: 'search' | 'read'): string => `files_${action}_${key}`

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const bad = (m: string): Error => expected(notulaError('invalid-input', m))

export function registerFileConnectors(ctx: MainContext): void {
  ctx.integrationPlugins.register(dropboxPlugin())

  const sources = async (): Promise<CalendarSource[]> =>
    ((await ctx.storage.listCalendarSources().catch(() => [])) as CalendarSource[]).filter((s) => s.kind === 'google' || s.kind === 'microsoft')

  async function status(): Promise<FileConnectorStatus[]> {
    const all = await sources()
    const forKind = (kind: 'google' | 'microsoft', connector: FileConnectorKey): FileConnectorStatus => {
      const list = all.filter((s) => s.kind === kind)
      if (!list.length) return { connector, state: 'needs-calendar', accountLabel: null, sourceId: null }
      const s = list.find((x) => x.grants.includes('files-read'))
      if (!s) return { connector, state: 'not-connected', accountLabel: list[0]?.accountEmail ?? null, sourceId: list[0]?.id ?? null }
      const broken = s.status === 'error' && (s.errorType === 'missing_token' || s.errorType === 'access_denied')
      return { connector, state: broken ? 'reconnect' : 'connected', accountLabel: s.accountEmail, sourceId: s.id }
    }
    const dbx = await dropboxLabel(ctx)
    return [forKind('google', 'google_drive'), forKind('microsoft', 'onedrive'), { connector: 'dropbox', state: dbx.connected ? 'connected' : 'not-connected', accountLabel: dbx.label, sourceId: null }]
  }

  async function grantToken(kind: 'google' | 'microsoft'): Promise<string> {
    const s = (await sources()).find((x) => x.kind === kind && x.grants.includes('files-read'))
    if (!s) throw new FileError('missing_scopes', FILE_COPY.needFiles)
    try {
      return await ctx.calendar.accessToken(s.id, 'files-read')
    } catch {
      throw new FileError('missing_token', FILE_COPY.reconnect)
    }
  }

  const guard = async (): Promise<void> => {
    if (await egressBlocked(ctx, { kind: 'integration' })) throw new FileError('local_only', FILE_COPY.localOnly)
  }

  async function search(connector: FileConnectorKey, query: string, limit: number): Promise<FileSearchResult[]> {
    await guard()
    const n = Math.max(1, Math.min(FILE_CONNECTOR_LIMITS.searchMax, Math.floor(limit) || FILE_CONNECTOR_LIMITS.searchDefault))
    const q = query.trim().slice(0, 1_000)
    if (!q) return []
    let out: FileSearchResult[]
    if (connector === 'google_drive') {
      const r = await driveSearch(ctx, await grantToken('google'), q, n)
      out = r.files.map((f) => ({ id: f.id, name: f.name, url: f.webViewLink, mimeType: f.mimeType || null, modifiedAt: f.modifiedTime, ...(f.owners[0] ? { owner: f.owners[0].displayName || f.owners[0].emailAddress } : {}) }))
    } else if (connector === 'onedrive') out = await oneDriveSearch(ctx, await grantToken('microsoft'), q, n)
    else out = await dropboxSearch(ctx, await dropboxToken(ctx), q, n)
    log('info', 'file-connectors:searched', { connector, results: out.length })
    return out
  }

  async function read(connector: FileConnectorKey, id: string): Promise<FileReadResult> {
    await guard()
    if (!/^[A-Za-z0-9:_!.-]{1,512}$/.test(id)) throw new FileError('not_found', FILE_COPY.notFound)
    const r =
      connector === 'google_drive'
        ? await driveRead(ctx, await grantToken('google'), id)
        : connector === 'onedrive'
          ? await oneDriveRead(ctx, await grantToken('microsoft'), id)
          : await dropboxRead(ctx, await dropboxToken(ctx), id)
    log('info', 'file-connectors:read', { connector, chars: r.text.length, truncated: r.truncated })
    return { id: r.id, name: r.name, url: r.url, text: r.text, truncated: r.truncated }
  }

  const asIpc = (err: unknown): Error => (err instanceof FileError ? expected(notulaError('provider-error', err.message)) : err instanceof Error ? err : new Error('file connector failed'))
  const needKey = (v: unknown): FileConnectorKey => {
    if (!KEYS.includes(v as FileConnectorKey)) throw bad('Unknown connector')
    return v as FileConnectorKey
  }

  // ---------- IPC ----------

  ipcMain.handle('connectors:list-files-status' satisfies InvokeChannel, (): Promise<InvokeRes<'connectors:list-files-status'>> => status())

  ipcMain.handle('connectors:search-files' satisfies InvokeChannel, async (_e, req: InvokeReq<'connectors:search-files'>): Promise<InvokeRes<'connectors:search-files'>> => {
    const r = obj(req)
    try {
      return await search(needKey(r['connector']), typeof r['query'] === 'string' ? r['query'] : '', Number(r['limit']))
    } catch (err) {
      throw asIpc(err)
    }
  })

  ipcMain.handle('connectors:read-file' satisfies InvokeChannel, async (_e, req: InvokeReq<'connectors:read-file'>): Promise<InvokeRes<'connectors:read-file'>> => {
    const r = obj(req)
    try {
      return await read(needKey(r['connector']), typeof r['id'] === 'string' ? r['id'] : '')
    } catch (err) {
      throw asIpc(err)
    }
  })

  // ---------- chat tools ----------

  const docId = (v: string): string | null => {
    const m = /\/document\/d\/([A-Za-z0-9_-]{10,200})/.exec(v)
    if (m?.[1]) return m[1]
    return /^[A-Za-z0-9_-]{10,200}$/.test(v) ? v : null
  }

  ctx.chat.registerToolProvider({
    id: 'file-connectors',
    async tools(): Promise<ChatToolSpec[]> {
      if (!(await ctx.settings.get('connectors.files.enabled'))) return []
      if (await egressBlocked(ctx, { kind: 'integration' })) return []
      const connected = (await status()).filter((s) => s.state === 'connected').map((s) => s.connector)
      const out: ChatToolSpec[] = []
      if (connected.includes('google_drive')) {
        out.push(
          {
            def: {
              name: DOCS_SEARCH,
              description: 'Finds Google Docs by title in the user’s Google Drive.',
              inputSchema: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: 'Text to look for in the document’s title, such as a word or phrase from it.' },
                  pageToken: { type: 'string', description: 'Copy nextPageToken exactly.' }
                },
                required: ['title'],
                additionalProperties: false
              }
            },
            category: 'search',
            needsApproval: false,
            readOnly: true,
            title: 'Google Docs'
          },
          {
            def: {
              name: DOCS_READ,
              description: 'Reads a Google Doc by its URL or id.',
              inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false }
            },
            category: 'search',
            needsApproval: false,
            readOnly: true,
            title: 'Google Docs'
          }
        )
      }
      for (const key of connected) {
        const name = CONNECTOR_NAMES[key]
        out.push(
          {
            def: {
              name: actionTool(key, 'search'),
              description: `Searches the user’s ${name} for files by name. Returns ids to read.`,
              inputSchema: {
                type: 'object',
                properties: { query: { type: 'string' }, limit: { type: 'number', description: 'Up to 25, default 10.' } },
                required: ['query'],
                additionalProperties: false
              }
            },
            category: 'search',
            needsApproval: false,
            readOnly: true,
            title: name
          },
          {
            def: {
              name: actionTool(key, 'read'),
              description: `Reads one ${name} file’s text by id (from a search). Long files are shortened.`,
              inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }
            },
            category: 'search',
            needsApproval: false,
            readOnly: true,
            title: name
          }
        )
      }
      return out
    },
    async run(name, args) {
      try {
        if (name === DOCS_SEARCH) {
          const title = typeof args['title'] === 'string' ? args['title'].trim() : ''
          if (!title || title.length > 200) return { content: 'Give a document title of 1 to 200 characters.', isError: true }
          const pageToken = typeof args['pageToken'] === 'string' && args['pageToken'].length <= 4_096 ? args['pageToken'] : undefined
          await guard()
          const r = await driveSearch(ctx, await grantToken('google'), title, FILE_CONNECTOR_LIMITS.searchDefault, { docsOnly: true, ...(pageToken ? { pageToken } : {}) })
          const documents = r.files.map((f) => ({ documentId: f.id, title: f.name, url: f.webViewLink, modifiedTime: f.modifiedTime, viewedByMeTime: f.viewedByMeTime, owners: f.owners, canEdit: f.canEdit }))
          const result = { documents, ...(r.nextPageToken ? { nextPageToken: r.nextPageToken } : {}), incompleteSearch: false }
          return { content: JSON.stringify(result), data: { count: documents.length }, isError: false }
        }
        if (name === DOCS_READ) {
          const url = typeof args['url'] === 'string' ? args['url'].slice(0, 2_048) : ''
          const id = docId(url)
          if (!id) return { content: 'That isn’t a Google Docs link or id.', isError: true }
          await guard()
          const doc = await docsGet(ctx, await grantToken('google'), id)
          const capped = doc.text.length > FILE_CONNECTOR_LIMITS.readChars
          const text = capped ? doc.text.slice(0, FILE_CONNECTOR_LIMITS.readChars) : doc.text
          const link = `https://docs.google.com/document/d/${id}/edit`
          log('info', 'file-connectors:read', { connector: 'google_drive', chars: text.length, truncated: capped })
          return { content: JSON.stringify({ url: link, title: doc.title, text, truncated: capped }), data: { title: doc.title, url: link, text: text.slice(0, 4_000), truncated: capped || text.length > 4_000 }, isError: false }
        }
        const m = /^files_(search|read)_(google_drive|onedrive|dropbox)$/.exec(name)
        if (m) {
          const key = m[2] as FileConnectorKey
          const envelope = { connectorTool: `files.${m[1]}`, connectorKey: key, connectorLabel: CONNECTOR_NAMES[key] }
          if (m[1] === 'search') {
            const files = await search(key, String(args['query'] ?? ''), Number(args['limit']) || FILE_CONNECTOR_LIMITS.searchDefault)
            return { content: JSON.stringify({ ...envelope, result: { files } }), data: { ...envelope, count: files.length }, isError: false }
          }
          const file = await read(key, String(args['id'] ?? ''))
          return { content: JSON.stringify({ ...envelope, result: file }), data: { ...envelope, name: file.name, url: file.url, truncated: file.truncated }, isError: false }
        }
        return { content: `Unknown tool ${name}.`, isError: true }
      } catch (err) {
        return { content: err instanceof FileError ? err.message : err instanceof Error ? err.message.replace(/^[a-z-]+: /, '') : FILE_COPY.other, isError: true }
      }
    }
  })
}
