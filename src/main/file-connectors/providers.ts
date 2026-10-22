// SPDX-License-Identifier: Apache-2.0
// File connector calls: Google Drive (with Google Docs),
// OneDrive and Dropbox, read-only, main only. Downloads are parsed in memory and never written to
// disk or cached. Nothing here logs a file name, a query, a body or a token.

import { FILE_CONNECTOR_LIMITS, type FileReadResult, type FileSearchResult } from '@shared/types/file-connectors'
import type { MainContext } from '../context'
import { exchange, insufficientScope, providerHttp, readCapped, type Exchange } from '../calendar-write/http'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as unknown[]).map(obj) : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export const FILE_COPY = {
  unreadable: 'This file type can’t be read by Notula.',
  localOnly: 'File connectors are off while Local-only mode is on.',
  reconnect: 'Reconnect to continue.',
  needFiles: 'Notula needs permission to read your files. Turn it on in Settings ▸ Connectors.',
  network: 'Couldn’t reach the file service. Check your connection and try again.',
  notFound: 'That file isn’t available any more.',
  other: 'Couldn’t read from the file service. Try again.'
} as const

export class FileError extends Error {
  constructor(
    readonly code: 'local_only' | 'missing_token' | 'missing_scopes' | 'network' | 'not_found' | 'provider',
    message: string
  ) {
    super(message)
  }
}

function raise(x: Exclude<Exchange, { ok: true }>): never {
  if (x.kind === 'local-only') throw new FileError('local_only', FILE_COPY.localOnly)
  if (x.kind === 'network' || x.kind === 'uncertain') throw new FileError('network', FILE_COPY.network)
  if (x.status === 401) throw new FileError('missing_token', FILE_COPY.reconnect)
  if (insufficientScope(x)) throw new FileError('missing_scopes', FILE_COPY.needFiles)
  if (x.status === 404) throw new FileError('not_found', FILE_COPY.notFound)
  throw new FileError('provider', FILE_COPY.other)
}

const auth = (token: string, extra: Record<string, string> = {}): Record<string, string> => ({ authorization: `Bearer ${token}`, ...extra })

/** Text kinds read as they are; PDF and Office go through the attachment converters. */
const PLAIN = /^(text\/(plain|markdown|csv|x-markdown)|application\/json)$/
const NAMED_PLAIN = /\.(txt|md|markdown|csv|json)$/i

/** Bytes → text through `convertBytes`, in memory. */
export async function bytesToText(ctx: MainContext, name: string, mimeType: string, bytes: Buffer): Promise<string> {
  if (PLAIN.test(mimeType) || NAMED_PLAIN.test(name)) return bytes.toString('utf8')
  const r = await ctx.attachments.convertBytes({ name, mimeType, bytes })
  return r.markdown ?? FILE_COPY.unreadable
}

export function capText(text: string): { text: string; truncated: boolean } {
  return text.length > FILE_CONNECTOR_LIMITS.readChars ? { text: text.slice(0, FILE_CONNECTOR_LIMITS.readChars), truncated: true } : { text, truncated: false }
}

// ---------- Google Drive and Docs ----------

const DOC_MIME = 'application/vnd.google-apps.document'
const quoteQ = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  modifiedTime: string | null
  viewedByMeTime: string | null
  webViewLink: string | null
  owners: { displayName: string; emailAddress: string }[]
  canEdit: boolean
}

function driveFile(f: Obj): DriveFile {
  return {
    id: str(f['id']),
    name: str(f['name']),
    mimeType: str(f['mimeType']),
    modifiedTime: str(f['modifiedTime']) || null,
    viewedByMeTime: str(f['viewedByMeTime']) || null,
    webViewLink: str(f['webViewLink']) || null,
    owners: arr(f['owners']).map((o) => ({ displayName: str(o['displayName']), emailAddress: str(o['emailAddress']) })),
    canEdit: obj(f['capabilities'])['canEdit'] === true
  }
}

export async function driveSearch(ctx: MainContext, token: string, text: string, limit: number, opts: { docsOnly?: boolean; pageToken?: string } = {}): Promise<{ files: DriveFile[]; nextPageToken: string | null }> {
  const http = providerHttp(ctx, 'integration', 'file-connectors')
  const q = [`name contains '${quoteQ(text)}'`, 'trashed = false', ...(opts.docsOnly ? [`mimeType = '${DOC_MIME}'`] : [])].join(' and ')
  const x = await exchange(() =>
    http.fetch('https://www.googleapis.com/drive/v3/files', {
      query: {
        q,
        orderBy: 'modifiedTime desc',
        pageSize: String(Math.max(1, Math.min(FILE_CONNECTOR_LIMITS.searchMax, limit))),
        fields: 'files(id,name,mimeType,modifiedTime,viewedByMeTime,webViewLink,owners(displayName,emailAddress),capabilities(canEdit)),nextPageToken',
        corpora: 'user',
        ...(opts.pageToken ? { pageToken: opts.pageToken } : {})
      },
      headers: auth(token, { accept: 'application/json' })
    })
  )
  if (!x.ok) raise(x)
  return { files: arr(x.body['files']).map(driveFile), nextPageToken: str(x.body['nextPageToken']) || null }
}

/** A Docs document's text in reading order (every tab, tables row by row). */
export function flattenDoc(doc: Obj): string {
  const out: string[] = []
  const content = (items: Obj[]): void => {
    for (const el of items) {
      const p = obj(el['paragraph'])
      if (el['paragraph']) {
        const line = arr(p['elements']).map((e) => str(obj(e['textRun'])['content'])).join('')
        const style = str(obj(p['paragraphStyle'])['namedStyleType'])
        const bullet = p['bullet'] ? '- ' : ''
        const heading = /^HEADING_(\d)$/.exec(style)
        out.push(heading ? `${'#'.repeat(Number(heading[1]))} ${line.trim()}` : style === 'TITLE' ? `# ${line.trim()}` : `${bullet}${line.replace(/\n$/, '')}`)
      } else if (el['table']) {
        for (const row of arr(obj(el['table'])['tableRows'])) {
          out.push(arr(row['tableCells']).map((c) => { const before = out.length; content(arr(c['content'])); return out.splice(before).join(' ').trim() }).join(' | '))
        }
      }
    }
  }
  const tabs = (list: Obj[]): void => {
    for (const t of list) {
      const title = str(obj(t['tabProperties'])['title'])
      if (list.length > 1 && title) out.push(`## ${title}`)
      content(arr(obj(obj(t['documentTab'])['body'])['content']))
      tabs(arr(t['childTabs']))
    }
  }
  if (Array.isArray(doc['tabs'])) tabs(arr(doc['tabs']))
  else content(arr(obj(doc['body'])['content']))
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export async function docsGet(ctx: MainContext, token: string, id: string): Promise<{ title: string; text: string }> {
  const http = providerHttp(ctx, 'integration', 'file-connectors')
  const x = await exchange(() =>
    http.fetch('https://docs.googleapis.com/v1/documents/{id}', { params: { id }, query: { includeTabsContent: 'true' }, headers: auth(token, { accept: 'application/json' }) })
  )
  if (!x.ok) raise(x)
  return { title: str(x.body['title']), text: flattenDoc(x.body) }
}

export async function driveRead(ctx: MainContext, token: string, id: string): Promise<FileReadResult & { file: DriveFile }> {
  const http = providerHttp(ctx, 'integration', 'file-connectors')
  const meta = await exchange(() =>
    http.fetch('https://www.googleapis.com/drive/v3/files/{id}', {
      params: { id },
      query: { fields: 'id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName,emailAddress),capabilities(canEdit)' },
      headers: auth(token, { accept: 'application/json' })
    })
  )
  if (!meta.ok) raise(meta)
  const file = driveFile(meta.body)
  const base = { id: file.id, name: file.name, url: file.webViewLink, file }
  if (file.mimeType === DOC_MIME) return { ...base, ...capText((await docsGet(ctx, token, id)).text) }
  if (file.mimeType === 'application/vnd.google-apps.spreadsheet' || file.mimeType === 'application/vnd.google-apps.presentation') {
    const res = await http.fetch('https://www.googleapis.com/drive/v3/files/{id}/export', {
      params: { id },
      query: { mimeType: file.mimeType.endsWith('spreadsheet') ? 'text/csv' : 'text/plain' },
      headers: auth(token)
    }).catch(() => null)
    if (!res?.ok) {
      await res?.body?.cancel().catch(() => undefined)
      return { ...base, text: FILE_COPY.unreadable, truncated: false }
    }
    const bytes = await readCapped(res, FILE_CONNECTOR_LIMITS.exportMaxBytes)
    return { ...base, ...(bytes ? capText(bytes.toString('utf8')) : { text: FILE_COPY.unreadable, truncated: false }) }
  }
  if (file.mimeType.startsWith('application/vnd.google-apps.') || Number(str(meta.body['size'])) > FILE_CONNECTOR_LIMITS.fileMaxBytes) return { ...base, text: FILE_COPY.unreadable, truncated: false }
  const res = await http.fetch('https://www.googleapis.com/drive/v3/files/{id}', { params: { id }, query: { alt: 'media' }, headers: auth(token) }).catch(() => null)
  if (!res?.ok) {
    await res?.body?.cancel().catch(() => undefined)
    throw new FileError('network', FILE_COPY.network)
  }
  const bytes = await readCapped(res, FILE_CONNECTOR_LIMITS.fileMaxBytes)
  if (!bytes) return { ...base, text: FILE_COPY.unreadable, truncated: false }
  return { ...base, ...capText(await bytesToText(ctx, file.name, file.mimeType, bytes)) }
}

// ---------- OneDrive ----------

function oneDriveResult(f: Obj): FileSearchResult {
  const parent = str(obj(f['parentReference'])['path']).replace(/^\/drive\/root:?/, '') || '/'
  return {
    id: str(f['id']),
    name: str(f['name']),
    url: str(f['webUrl']) || null,
    mimeType: str(obj(f['file'])['mimeType']) || null,
    modifiedAt: str(f['lastModifiedDateTime']) || null,
    path: parent
  }
}

export async function oneDriveSearch(ctx: MainContext, token: string, text: string, limit: number): Promise<FileSearchResult[]> {
  const http = providerHttp(ctx, 'integration', 'file-connectors')
  const x = await exchange(() =>
    http.fetch("https://graph.microsoft.com/v1.0/me/drive/root/search(q='{q}')", {
      params: { q: text.replace(/'/g, "''").slice(0, 500) },
      query: { $top: String(Math.max(1, Math.min(FILE_CONNECTOR_LIMITS.searchMax, limit))), $select: 'id,name,webUrl,file,lastModifiedDateTime,parentReference' },
      headers: auth(token, { accept: 'application/json' })
    })
  )
  if (!x.ok) raise(x)
  return arr(x.body['value'])
    .filter((f) => f['file'])
    .map(oneDriveResult)
}

export async function oneDriveRead(ctx: MainContext, token: string, id: string): Promise<FileReadResult> {
  const http = providerHttp(ctx, 'integration', 'file-connectors')
  const meta = await exchange(() =>
    http.fetch('https://graph.microsoft.com/v1.0/me/drive/items/{id}', { params: { id }, query: { $select: 'id,name,webUrl,file,size' }, headers: auth(token, { accept: 'application/json' }) })
  )
  if (!meta.ok) raise(meta)
  const name = str(meta.body['name'])
  const mime = str(obj(meta.body['file'])['mimeType'])
  const base = { id: str(meta.body['id']) || id, name, url: str(meta.body['webUrl']) || null }
  if (!meta.body['file'] || Number(meta.body['size']) > FILE_CONNECTOR_LIMITS.fileMaxBytes) return { ...base, text: FILE_COPY.unreadable, truncated: false }
  // The content call answers with a short-lived pre-authenticated URL: followed at once, without the token.
  let res = await http.fetch('https://graph.microsoft.com/v1.0/me/drive/items/{id}/content', { params: { id }, headers: auth(token), redirect: 'manual' }).catch(() => null)
  const location = res && res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
  if (location && /^https:\/\//.test(location)) {
    await res?.body?.cancel().catch(() => undefined)
    res = await http.fetchUrl(location, {}).catch(() => null)
  }
  if (!res?.ok) {
    await res?.body?.cancel().catch(() => undefined)
    throw new FileError('network', FILE_COPY.network)
  }
  const bytes = await readCapped(res, FILE_CONNECTOR_LIMITS.fileMaxBytes)
  if (!bytes) return { ...base, text: FILE_COPY.unreadable, truncated: false }
  return { ...base, ...capText(await bytesToText(ctx, name, mime, bytes)) }
}

// ---------- Dropbox ----------

/** `Dropbox-API-Arg` must be ASCII: everything else as `\uXXXX`. */
const apiArg = (v: unknown): string => JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

function dropboxLink(pathDisplay: string): string | null {
  if (!pathDisplay) return null
  const i = pathDisplay.lastIndexOf('/')
  const dir = pathDisplay.slice(0, i)
  return `https://www.dropbox.com/home${encodeURI(dir)}?preview=${encodeURIComponent(pathDisplay.slice(i + 1))}`
}

export async function dropboxSearch(ctx: MainContext, token: string, text: string, limit: number): Promise<FileSearchResult[]> {
  const http = providerHttp(ctx, 'integration', 'file-connectors')
  const x = await exchange(() =>
    http.fetch('https://api.dropboxapi.com/2/files/search_v2', {
      method: 'POST',
      headers: auth(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ query: text.slice(0, 1_000), options: { max_results: Math.max(1, Math.min(FILE_CONNECTOR_LIMITS.searchMax, limit)), file_status: 'active' } })
    })
  )
  if (!x.ok) raise(x)
  return arr(x.body['matches'])
    .map((m) => obj(obj(m['metadata'])['metadata']))
    .filter((f) => f['.tag'] === 'file')
    .map((f) => ({
      id: str(f['id']),
      name: str(f['name']),
      url: dropboxLink(str(f['path_display'])),
      mimeType: null,
      modifiedAt: str(f['server_modified']) || null,
      path: str(f['path_display'])
    }))
}

export async function dropboxRead(ctx: MainContext, token: string, id: string): Promise<FileReadResult> {
  const http = providerHttp(ctx, 'integration', 'file-connectors')
  const path = id.startsWith('id:') ? id : `id:${id}`
  let res = await http.fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: auth(token, { 'dropbox-api-arg': apiArg({ path }) }),
    timeoutMs: 60_000
  }).catch(() => null)
  if (!res) throw new FileError('network', FILE_COPY.network)
  if (res.status === 409) {
    // Paper docs and other non-downloadable files: export when the file offers a format.
    await res.body?.cancel().catch(() => undefined)
    res = await http.fetch('https://content.dropboxapi.com/2/files/export', {
      method: 'POST',
      headers: auth(token, { 'dropbox-api-arg': apiArg({ path }) }),
      timeoutMs: 60_000
    }).catch(() => null)
    if (!res?.ok) {
      await res?.body?.cancel().catch(() => undefined)
      return { id, name: '', url: null, text: FILE_COPY.unreadable, truncated: false }
    }
  }
  if (res.status === 401) throw new FileError('missing_token', FILE_COPY.reconnect)
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined)
    throw new FileError(res.status === 404 ? 'not_found' : 'provider', res.status === 404 ? FILE_COPY.notFound : FILE_COPY.other)
  }
  let meta: Obj = {}
  try {
    meta = obj(JSON.parse(res.headers.get('dropbox-api-result') ?? '{}'))
  } catch {
    meta = {}
  }
  const exported = obj(meta['export_metadata'])
  const name = str(exported['name']) || str(meta['name'])
  const base = { id: str(meta['id']) || id, name, url: dropboxLink(str(meta['path_display'])) }
  const bytes = await readCapped(res, FILE_CONNECTOR_LIMITS.fileMaxBytes)
  if (!bytes) return { ...base, text: FILE_COPY.unreadable, truncated: false }
  return { ...base, ...capText(await bytesToText(ctx, name, '', bytes)) }
}
