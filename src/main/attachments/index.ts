// SPDX-License-Identifier: Apache-2.0
// registerAttachments(): note images and chat or folder files: resizing in main,
// conversion in notula-convert, the encrypted store (NTA1 blobs with per-file keys) in
// notula-storage; the `attachments:*` IPC. Returns `ctx.attachments`.
//
// - The renderer sends paths (from `files.pathForFile`) or pasted image bytes; main reads
//   the file, checks it, and hands the bytes to storage, which seals them (NTA1) before
//   anything reaches the disk. Plaintext leaves main only to storage (encrypt), to
//   notula-convert (convert) and to the user's own LLM provider (digests), and to disk
//   only through "Save as…", the user's explicit export.
// - Chat and folder files are stored `processing`, converted in the background, then
//   `ready` or `failed`; folder files and oversized chat files get a digest.
// - A `processing` row nobody is working on (the app quit mid-conversion) is picked up
//   again the next time its list is read.
// Handlers are registered with literal channels only.

import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import { app, clipboard, ClipboardItem, dialog, ipcMain, nativeImage } from 'electron'
import { notulaError, parseError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes, PushChannel } from '@shared/ipc'
import {
  ATTACHMENT_LIMITS,
  type AddFilesResult,
  type AddImagesResult,
  type AttachmentInfo,
  type AttachmentInput,
  type AttachmentParentType,
  type AttachmentRejection
} from '@shared/types/attachments'
import { ATTACHMENT_URL_PREFIX, type AttachedLink, type NoteAttachment } from '@shared/types/notes'
import type { AttachmentsApi, MainContext } from '../context'
import { expected } from '../ipc-expected'
import { currentProvider } from '../llm/registry'
import type { LlmImage } from '../llm/types'
import { log } from '../log'
import { convertToMarkdown, pdfPageCount, stopConvertProcess } from './convert'
import type { ConvertKind } from './convert-protocol'
import { digestAttachment } from './digest'
import {
  cleanFileName,
  COPY,
  disguisedImageFormat,
  estimatedImageBytes,
  isSupportedFileType,
  legacyRejection,
  MIME,
  mimeFromName,
  noteImageType,
  sniff,
  tokensOf
} from './files'
import { prepareImage } from './images'

/** A chat file above this many tokens also gets a digest the chat can use instead. */
const CHAT_DIGEST_TOKENS = 25_000
const MAX_PATH = 4_096
const MAX_LINKS = 200

/** A file the renderer named, before its bytes are read. */
interface Candidate {
  name: string
  mime: string
  size: number
  load(): Promise<Buffer>
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function idOf(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v || v.length > 200) throw expected(notulaError('invalid-input', `${what} is required.`))
  return v
}

/** A dropped or picked path, or pasted bytes. Paths must be absolute files; nothing else is read. */
async function candidate(input: AttachmentInput): Promise<Candidate | AttachmentRejection> {
  if (!isObject(input)) return { name: 'file', message: COPY.uploadImageFailed }
  if ('path' in input) {
    const path = input.path
    if (typeof path !== 'string' || !path || path.length > MAX_PATH || !isAbsolute(path)) return { name: 'file', message: 'That file could not be read.' }
    const name = cleanFileName(basename(path))
    try {
      const st = await stat(path)
      if (!st.isFile()) return { name, message: 'That is not a file.' }
      return { name, mime: mimeFromName(name), size: st.size, load: () => readFile(path) }
    } catch {
      return { name, message: 'That file could not be read.' }
    }
  }
  const name = cleanFileName(typeof input.name === 'string' && input.name ? input.name.slice(0, 500) : 'image')
  if (!(input.bytes instanceof Uint8Array)) return { name, message: 'That file could not be read.' }
  const bytes = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength)
  const declared = typeof input.mimeType === 'string' && input.mimeType ? input.mimeType.toLowerCase() : mimeFromName(name)
  return { name, mime: declared, size: bytes.byteLength, load: async () => bytes }
}

function convertKind(mime: string): ConvertKind {
  if (mime === MIME.pdf) return 'pdf'
  if (mime === MIME.docx) return 'docx'
  if (mime === MIME.xlsx) return 'xlsx'
  if (mime === MIME.json) return 'json'
  return 'text'
}

function extensionFor(mime: 'image/png' | 'image/jpeg'): string {
  return mime === 'image/png' ? 'png' : 'jpg'
}

function noteRecord(info: AttachmentInfo): NoteAttachment {
  return {
    id: info.id,
    type: 'image',
    url: `${ATTACHMENT_URL_PREFIX}${info.id}`,
    width: info.width ?? 0,
    height: info.height ?? 0,
    mime_type: info.mime_type,
    byte_size: info.byte_size,
    ...(info.screen_capture_info ? { screen_capture_info: info.screen_capture_info } : {})
  }
}

function attachedLinks(v: unknown): AttachedLink[] {
  if (!Array.isArray(v) || v.length > MAX_LINKS) throw expected(notulaError('invalid-input', 'links must be a list.'))
  return v.map((l) => {
    if (!isObject(l)) throw expected(notulaError('invalid-input', 'A link is invalid.'))
    const { url, label, status } = l
    if (typeof url !== 'string' || !/^https:\/\//i.test(url) || url.length > 2_048) throw expected(notulaError('invalid-input', 'A link is invalid.'))
    if (typeof label !== 'string' || label.length > 500) throw expected(notulaError('invalid-input', 'A link label is invalid.'))
    if (status !== 'added' && status !== 'dismissed') throw expected(notulaError('invalid-input', 'A link status is invalid.'))
    return { url, label, status }
  })
}

export function registerAttachments(ctx: MainContext): AttachmentsApi {
  const { storage } = ctx
  /** Attachment ids being converted or digested right now. */
  const working = new Set<string>()

  const push = (parentType: AttachmentParentType, parentId: string): void => {
    for (const wc of ctx.windows.targets()) wc.send('attachments:changed' satisfies PushChannel, { parentType, parentId })
  }

  app.on('will-quit', () => stopConvertProcess())

  // ---------- note images ----------

  async function storeNoteImage(
    noteId: string,
    image: { bytes: Buffer; mimeType: 'image/png' | 'image/jpeg'; fileName: string },
    opts: { id?: string; screenShareContext?: NoteAttachment['screen_capture_info'] | null; counted: boolean; maxSide: number }
  ): Promise<AttachmentInfo> {
    const prepared = prepareImage(image.bytes, image.mimeType, opts.maxSide)
    return storage.createAttachment({
      ...(opts.id ? { id: opts.id } : {}),
      parent_type: 'note',
      parent_id: noteId,
      kind: 'image',
      file_name: image.fileName,
      mime_type: prepared.mimeType,
      width: prepared.width,
      height: prepared.height,
      status: 'ready',
      screen_capture_info: opts.screenShareContext ?? null,
      counted: opts.counted,
      bytes: prepared.bytes
    })
  }

  async function addImages(raw: unknown): Promise<AddImagesResult> {
    if (!isObject(raw)) throw expected(notulaError('invalid-input', 'request must be an object.'))
    const noteId = idOf(raw['noteId'], 'noteId')
    const files = Array.isArray(raw['files']) ? (raw['files'] as AttachmentInput[]) : null
    if (!files) throw expected(notulaError('invalid-input', 'files must be a list.'))
    const note = await storage.getNote(noteId)
    if (!note) throw expected(notulaError('not-found', 'That note does not exist.'))

    const rejected: AttachmentRejection[] = []
    const accepted: Candidate[] = []
    for (const input of files.slice(0, ATTACHMENT_LIMITS.filesPerSelection)) {
      const c = await candidate(input)
      if (!('load' in c)) {
        rejected.push(c)
        continue
      }
      // Only PNG and JPEG, by name or pasted type here and by bytes below.
      if (c.mime !== MIME.png && c.mime !== MIME.jpeg) rejected.push({ name: c.name, message: COPY.unsupportedImage })
      else accepted.push(c)
    }
    if (files.length > ATTACHMENT_LIMITS.filesPerSelection) rejected.push({ name: '', message: COPY.tooManyFiles })

    // The shared size check: existing images at their estimated size.
    const tooLarge = accepted.filter((c) => c.size > ATTACHMENT_LIMITS.fileMaxBytes)
    if (tooLarge.length) rejected.push({ name: tooLarge.map((c) => c.name).join(', '), message: COPY.tooLarge(tooLarge.map((c) => c.name)) })
    let batch = accepted.filter((c) => c.size <= ATTACHMENT_LIMITS.fileMaxBytes)
    const existing = note.attachments.reduce((n, a) => n + estimatedImageBytes(a.width, a.height), 0)
    const total = existing + batch.reduce((n, c) => n + c.size, 0)
    if (batch.length && total > ATTACHMENT_LIMITS.chatTotalBytes) {
      rejected.push({ name: batch.map((c) => c.name).join(', '), message: COPY.totalTooLarge(total, ATTACHMENT_LIMITS.chatTotalBytes) })
      batch = []
    }

    let full = false
    let added = 0
    for (const c of batch) {
      if (full) {
        rejected.push({ name: c.name, message: COPY.maxImages })
        continue
      }
      try {
        const bytes = await c.load()
        const type = noteImageType(bytes)
        if (!type) {
          rejected.push({ name: c.name, message: COPY.unsupportedImage })
          continue
        }
        await storeNoteImage(noteId, { bytes, mimeType: type, fileName: c.name }, { counted: true, maxSide: ATTACHMENT_LIMITS.noteImageMaxSide })
        added++
      } catch (err) {
        const e = parseError(err)
        if (e.message === COPY.maxImages) {
          full = true
          rejected.push({ name: c.name, message: COPY.maxImages })
        } else {
          log('warn', 'attachments:image-failed', { noteId, code: e.code })
          rejected.push({ name: c.name, message: COPY.uploadImageFailed })
        }
      }
    }
    if (added) push('note', noteId)
    const after = await storage.getNote(noteId)
    log('info', 'attachments:images-added', { noteId, added, rejected: rejected.length })
    return { attachments: after?.attachments ?? [], rejected }
  }

  // ---------- chat and folder files ----------

  async function process(info: AttachmentInfo, bytes: Buffer | null): Promise<void> {
    if (working.has(info.id)) return
    working.add(info.id)
    const update = async (patch: Parameters<typeof storage.updateAttachment>[1]): Promise<AttachmentInfo> => {
      const next = await storage.updateAttachment(info.id, patch)
      push(info.parent_type, info.parent_id)
      return next
    }
    try {
      let plain = bytes
      if (!plain) {
        const read = await storage.readAttachment(info.id)
        if (!read) {
          await update({ status: 'failed', error: 'The file could not be read.' })
          return
        }
        plain = Buffer.from(read.bytes.buffer, read.bytes.byteOffset, read.bytes.byteLength)
      }
      if (info.kind === 'image') {
        await update({ status: 'ready', error: null })
        const provider = await currentProvider(ctx.settings, ctx.secrets)
        const takesImages = await provider.acceptsImages().catch(() => false)
        if (info.parent_type === 'folder' || !takesImages) {
          const image: LlmImage = { mimeType: info.mime_type === MIME.png ? 'image/png' : 'image/jpeg', data: plain }
          const summary = await digestAttachment(ctx, { id: info.id, name: info.file_name, mimeType: info.mime_type, image })
          if (summary) await update({ content_summary: summary })
        }
        return
      }
      const result = await convertToMarkdown(convertKind(info.mime_type), info.file_name, plain)
      if (!result.ok) {
        log('info', 'attachments:convert-failed', { id: info.id, mime: info.mime_type })
        await update({ status: 'failed', error: result.error })
        return
      }
      if (!result.markdown.trim()) {
        await update({ status: 'failed', error: 'This file has no readable text.' })
        return
      }
      const tokens = tokensOf(result.markdown)
      await update({
        status: 'ready',
        error: null,
        content_markdown: result.markdown,
        token_estimate: tokens,
        ...(result.pageCount !== null ? { page_count: result.pageCount } : {})
      })
      log('info', 'attachments:converted', { id: info.id, tokens })
      if (info.parent_type === 'folder' || tokens > CHAT_DIGEST_TOKENS) {
        const summary = await digestAttachment(ctx, { id: info.id, name: info.file_name, mimeType: info.mime_type, markdown: result.markdown })
        if (summary) await update({ content_summary: summary })
      }
    } catch (err) {
      log('error', 'attachments:process-failed', { id: info.id, err: parseError(err) })
      await storage.updateAttachment(info.id, { status: 'failed', error: 'The file could not be read.' }).catch(() => undefined)
      push(info.parent_type, info.parent_id)
    } finally {
      working.delete(info.id)
    }
  }

  async function listFor(parentType: AttachmentParentType, parentId: string): Promise<AttachmentInfo[]> {
    const rows = await storage.listAttachments({ parentType, parentId })
    for (const r of rows) {
      if (r.status === 'processing' && !working.has(r.id)) {
        log('info', 'attachments:resume-processing', { id: r.id })
        void process(r, null)
      }
    }
    return rows
  }

  async function addFiles(raw: unknown): Promise<AddFilesResult> {
    if (!isObject(raw)) throw expected(notulaError('invalid-input', 'request must be an object.'))
    const parentType = raw['parentType']
    if (parentType !== 'chat_thread' && parentType !== 'folder') throw expected(notulaError('invalid-input', 'parentType is invalid.'))
    const parentId = idOf(raw['parentId'], 'parentId')
    const files = Array.isArray(raw['files']) ? (raw['files'] as AttachmentInput[]) : null
    if (!files) throw expected(notulaError('invalid-input', 'files must be a list.'))
    const rejected: AttachmentRejection[] = []
    if (files.length > ATTACHMENT_LIMITS.filesPerSelection) return { accepted: [], rejected: [{ name: '', message: COPY.tooManyFiles }] }

    // Batch checks: types, then per-file size, then the total.
    const all: Candidate[] = []
    for (const input of files) {
      const c = await candidate(input)
      if ('load' in c) all.push(c)
      else rejected.push(c)
    }
    let ok: Candidate[] = []
    const unsupported: string[] = []
    for (const c of all) {
      const legacy = legacyRejection(c.mime, null)
      if (legacy) rejected.push({ name: c.name, message: legacy })
      else if (!isSupportedFileType(c.mime)) unsupported.push(c.mime === 'application/octet-stream' ? extname(c.name).toLowerCase() || c.name : c.mime)
      else ok.push(c)
    }
    if (unsupported.length) {
      const names = all.filter((c) => !isSupportedFileType(c.mime) && !legacyRejection(c.mime, null)).map((c) => c.name)
      rejected.push({ name: names.join(', '), message: COPY.unsupportedTypes([...new Set(unsupported)]) })
    }
    const big = ok.filter((c) => c.size > ATTACHMENT_LIMITS.fileMaxBytes)
    if (big.length) {
      rejected.push({ name: big.map((c) => c.name).join(', '), message: COPY.tooLarge(big.map((c) => c.name)) })
      ok = ok.filter((c) => c.size <= ATTACHMENT_LIMITS.fileMaxBytes)
    }
    const existing = (await storage.listAttachments({ parentType, parentId })).filter((a) => a.status !== 'failed')
    // Folders use the chat limits until their own constants are known.
    const total = existing.reduce((n, a) => n + a.byte_size, 0) + ok.reduce((n, c) => n + c.size, 0)
    if (ok.length && total > ATTACHMENT_LIMITS.chatTotalBytes) {
      rejected.push({ name: ok.map((c) => c.name).join(', '), message: COPY.totalTooLarge(total, ATTACHMENT_LIMITS.chatTotalBytes) })
      ok = []
    }

    // Per-file checks on the bytes.
    const ready: { c: Candidate; bytes: Buffer; mime: string; width: number | null; height: number | null; pages: number | null }[] = []
    const overPages: string[] = []
    for (const c of ok) {
      let bytes: Buffer
      try {
        bytes = await c.load()
      } catch {
        rejected.push({ name: c.name, message: COPY.uploadFailed(c.name) })
        continue
      }
      const legacy = legacyRejection(c.mime, bytes)
      if (legacy) {
        rejected.push({ name: c.name, message: legacy })
        continue
      }
      if (c.mime === MIME.png || c.mime === MIME.jpeg) {
        const real = noteImageType(bytes)
        if (!real) {
          const format = disguisedImageFormat(bytes)
          rejected.push({ name: c.name, message: format ? COPY.wrongImageFormat(c.name, format, c.mime) : COPY.uploadFailed(c.name) })
          continue
        }
        try {
          // Larger than 1,568 px, or bytes that do not match the declared type: fit and re-encode.
          const prepared = prepareImage(bytes, real, ATTACHMENT_LIMITS.chatImageMaxSide, { reencode: real !== c.mime })
          ready.push({ c, bytes: prepared.bytes, mime: prepared.mimeType, width: prepared.width, height: prepared.height, pages: null })
        } catch {
          rejected.push({ name: c.name, message: COPY.uploadFailed(c.name) })
        }
        continue
      }
      if (c.mime === MIME.pdf) {
        const counted = sniff(bytes) === 'pdf' ? await pdfPageCount(bytes) : ({ ok: false, error: 'not a PDF' } as const)
        if (!counted.ok) {
          rejected.push({ name: c.name, message: COPY.pdfFailed })
          continue
        }
        if (counted.pages > ATTACHMENT_LIMITS.pdfMaxPages) {
          overPages.push(c.name)
          continue
        }
        ready.push({ c, bytes, mime: c.mime, width: null, height: null, pages: counted.pages })
        continue
      }
      ready.push({ c, bytes, mime: c.mime, width: null, height: null, pages: null })
    }
    if (overPages.length) rejected.push({ name: overPages.join(', '), message: COPY.tooManyPages(overPages) })
    let batch = ready
    if (parentType === 'chat_thread') {
      const pages = existing.reduce((n, a) => n + (a.mime_type === MIME.pdf ? (a.page_count ?? 0) : 0), 0) + batch.reduce((n, r) => n + (r.pages ?? 0), 0)
      if (pages > ATTACHMENT_LIMITS.chatTotalPdfPages && batch.some((r) => r.pages !== null)) {
        const pdfs = batch.filter((r) => r.pages !== null)
        rejected.push({ name: pdfs.map((r) => r.c.name).join(', '), message: COPY.totalPages(pages, ATTACHMENT_LIMITS.chatTotalPdfPages) })
        batch = batch.filter((r) => r.pages === null)
      }
    }

    const accepted: AttachmentInfo[] = []
    const stored: { info: AttachmentInfo; bytes: Buffer }[] = []
    for (const r of batch) {
      try {
        const info = await storage.createAttachment({
          parent_type: parentType,
          parent_id: parentId,
          kind: r.mime === MIME.png || r.mime === MIME.jpeg ? 'image' : 'file',
          file_name: r.c.name,
          mime_type: r.mime,
          width: r.width,
          height: r.height,
          page_count: r.pages,
          status: 'processing',
          counted: false,
          bytes: r.bytes
        })
        accepted.push(info)
        stored.push({ info, bytes: r.bytes })
      } catch (err) {
        log('warn', 'attachments:file-store-failed', { parentType, code: parseError(err).code })
        rejected.push({ name: r.c.name, message: COPY.uploadFailed(r.c.name) })
      }
    }
    if (accepted.length) push(parentType, parentId)
    log('info', 'attachments:files-added', { parentType, accepted: accepted.length, rejected: rejected.length })
    for (const s of stored) void process(s.info, s.bytes)
    return { accepted, rejected }
  }

  // ---------- shared ----------

  async function remove(attachmentId: string): Promise<void> {
    const [info] = await storage.listAttachments({ ids: [attachmentId] })
    await storage.deleteAttachment(attachmentId)
    if (info) push(info.parent_type, info.parent_id)
  }

  async function readBytes(attachmentId: string): Promise<{ mimeType: string; bytes: Buffer } | null> {
    const r = await storage.readAttachment(attachmentId)
    return r ? { mimeType: r.mimeType, bytes: Buffer.from(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength) } : null
  }

  // ---------- IPC ----------

  ipcMain.handle(
    'attachments:add-images' satisfies InvokeChannel,
    (_e, req: InvokeReq<'attachments:add-images'>): Promise<InvokeRes<'attachments:add-images'>> => addImages(req)
  )

  ipcMain.handle(
    'attachments:add-files' satisfies InvokeChannel,
    (_e, req: InvokeReq<'attachments:add-files'>): Promise<InvokeRes<'attachments:add-files'>> => addFiles(req)
  )

  ipcMain.handle(
    'attachments:list' satisfies InvokeChannel,
    (_e, req: InvokeReq<'attachments:list'>): Promise<InvokeRes<'attachments:list'>> => {
      const r: Record<string, unknown> = isObject(req) ? req : {}
      const parentType = r['parentType']
      if (parentType !== 'note' && parentType !== 'chat_thread' && parentType !== 'folder') {
        throw expected(notulaError('invalid-input', 'parentType is invalid.'))
      }
      return listFor(parentType, idOf(r['parentId'], 'parentId'))
    }
  )

  ipcMain.handle(
    'attachments:remove' satisfies InvokeChannel,
    (_e, req: InvokeReq<'attachments:remove'>): Promise<void> => remove(idOf(isObject(req) ? req['attachmentId'] : null, 'attachmentId'))
  )

  // Images only: the strip, the viewer and chat thumbnails show them. File contents reach a
  // model through main (`ctx.attachments.readContent`), never the renderer.
  ipcMain.handle(
    'attachments:read' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'attachments:read'>): Promise<InvokeRes<'attachments:read'>> => {
      const attachmentId = idOf(isObject(req) ? req['attachmentId'] : null, 'attachmentId')
      const [info] = await storage.listAttachments({ ids: [attachmentId] }).catch(() => [])
      if (!info || info.kind !== 'image') return { status: 'unavailable' }
      const r = await readBytes(attachmentId).catch(() => null)
      return r ? { status: 'ok', mimeType: r.mimeType, bytes: r.bytes } : { status: 'unavailable' }
    }
  )

  ipcMain.handle(
    'attachments:copy-image' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'attachments:copy-image'>): Promise<void> => {
      const r = await readBytes(idOf(isObject(req) ? req['attachmentId'] : null, 'attachmentId'))
      const image = r ? nativeImage.createFromBuffer(r.bytes) : null
      if (!image || image.isEmpty()) throw expected(notulaError('not-found', 'Couldn’t copy the image. It may have been deleted.'))
      // PNG on the clipboard whatever the stored format: every app pastes it.
      const png = new Uint8Array(image.toPNG())
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })])
    }
  )

  ipcMain.handle(
    'attachments:save-as' satisfies InvokeChannel,
    async (e, req: InvokeReq<'attachments:save-as'>): Promise<InvokeRes<'attachments:save-as'>> => {
      const attachmentId = idOf(isObject(req) ? req['attachmentId'] : null, 'attachmentId')
      const [info] = await storage.listAttachments({ ids: [attachmentId] })
      const r = info ? await readBytes(attachmentId) : null
      if (!info || !r) throw expected(notulaError('not-found', 'Couldn’t save the image. It may have been deleted.'))
      const owner = ctx.windows.main()
      const options = { defaultPath: info.file_name, title: 'Save as' }
      const picked = owner && owner.webContents.id === e.sender.id ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
      if (picked.canceled || !picked.filePath) return { saved: false }
      // The one place an attachment is written in the clear: the file the user chose.
      await writeFile(picked.filePath, r.bytes)
      log('info', 'attachments:saved-as', { id: attachmentId })
      return { saved: true }
    }
  )

  ipcMain.handle(
    'attached-links:update' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'attached-links:update'>): Promise<void> => {
      const r: Record<string, unknown> = isObject(req) ? req : {}
      const noteId = idOf(r['noteId'], 'noteId')
      const links = attachedLinks(r['links'])
      // `saved_links` is main-only: only main calls setAttachedLinks, and
      // notes/validate.ts rebuilds every renderer patch from known keys, so no renderer can set it.
      await storage.setAttachedLinks(noteId, links)
      log('info', 'attached-links:updated', { noteId, links: links.length })
    }
  )

  // ---------- ctx.attachments ----------
  return {
    /** The file connectors parse downloads in memory, with the same limits and rejections. */
    async convertBytes(f) {
      const name = cleanFileName(f.name.slice(0, 500))
      const mime = (f.mimeType || mimeFromName(name)).toLowerCase()
      const legacy = legacyRejection(mime, f.bytes)
      if (legacy) return { markdown: null, error: legacy }
      if (f.bytes.byteLength > ATTACHMENT_LIMITS.fileMaxBytes) return { markdown: null, error: COPY.tooLarge([name]) }
      if (!isSupportedFileType(mime)) return { markdown: null, error: COPY.unsupportedTypes([mime]) }
      const r = await convertToMarkdown(convertKind(mime), name, f.bytes)
      return r.ok ? { markdown: r.markdown, error: null } : { markdown: null, error: r.error }
    },
    async addNoteImage(noteId, image, opts) {
      const real = noteImageType(image.bytes)
      if (!real) throw notulaError('invalid-input', COPY.unsupportedImage)
      const info = await storeNoteImage(
        noteId,
        { bytes: image.bytes, mimeType: real, fileName: image.fileName ?? `image.${extensionFor(real)}` },
        {
          ...(opts?.id ? { id: opts.id } : {}),
          screenShareContext: opts?.screenShareContext ?? null,
          counted: opts?.countTowardLimit ?? true,
          maxSide: opts?.maxSide ?? ATTACHMENT_LIMITS.noteImageMaxSide
        }
      )
      push('note', noteId)
      return noteRecord(info)
    },
    async setScreenShareContext(attachmentId, screenShareContext) {
      const info = await storage.updateAttachment(attachmentId, { screen_capture_info: screenShareContext })
      push(info.parent_type, info.parent_id)
    },
    remove,
    list: (parent) => listFor(parent.type, parent.id),
    readBytes,
    async readContent(attachmentId, maxChars) {
      const c = await storage.attachmentContent(attachmentId)
      if (!c) return null
      const cut = (s: string | null): string | null =>
        s !== null && maxChars !== undefined && maxChars >= 0 && s.length > maxChars ? s.slice(0, maxChars) : s
      return { name: c.file_name, markdown: cut(c.content_markdown), summary: c.content_summary }
    }
  }
}
