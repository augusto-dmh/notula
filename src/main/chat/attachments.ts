// SPDX-License-Identifier: Apache-2.0
// Chat files: files
// and images the user added to a chat reach the model with the message. An image goes
// as an image block when the provider accepts images; otherwise, and for every
// other file, its text (or the attachments module's digest of an image) goes into the user turn.

import type { AttachmentInfo } from '@shared/types/attachments'
import type { AttachmentRef } from '@shared/types/chat'
import type { MainContext } from '../context'
import type { LlmImage } from '../llm/types'
import { log } from '../log'
import { truncateLines } from './text'

/** Per file and in total, the characters of file text one message carries. */
const FILE_CHARS = 8_000
const TOTAL_CHARS = 24_000
const IMAGE_TYPES: readonly LlmImage['mimeType'][] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

export function isModelImage(mimeType: string): mimeType is LlmImage['mimeType'] {
  return (IMAGE_TYPES as readonly string[]).includes(mimeType)
}

/**
 * The chat files of a send, re-parented to the thread (files added before a chat's first
 * send carry the request id as their parent). Rejects when storage can't read them.
 */
export async function adoptAttachments(ctx: MainContext, threadId: string, ids: string[]): Promise<AttachmentRef[]> {
  if (ids.length === 0) return []
  const infos = await ctx.storage.listAttachments({ ids })
  const refs: AttachmentRef[] = []
  for (const id of ids) {
    const a = infos.find((x) => x.id === id)
    if (!a || a.parent_type !== 'chat_thread') continue
    if (a.parent_id !== threadId) await ctx.storage.updateAttachment(a.id, { parent_id: threadId })
    refs.push({ id: a.id, name: a.file_name, mimeType: a.mime_type })
  }
  return refs
}

export function attachmentRefs(v: unknown): AttachmentRef[] {
  return (Array.isArray(v) ? v : []).filter(
    (r): r is AttachmentRef => !!r && typeof r === 'object' && typeof (r as AttachmentRef).id === 'string' && typeof (r as AttachmentRef).name === 'string'
  )
}

export interface AttachmentInputs {
  /** Appended to the user turn: the files' text and the image lines. */
  text: string
  images: LlmImage[]
}

/** What the model gets for the files of one message. */
export async function attachmentInputs(ctx: MainContext, refs: AttachmentRef[], acceptsImages: boolean): Promise<AttachmentInputs> {
  if (refs.length === 0) return { text: '', images: [] }
  let infos: AttachmentInfo[] = []
  try {
    infos = await ctx.storage.listAttachments({ ids: refs.map((r) => r.id) })
  } catch (err) {
    log('warn', 'chat:attachments-unavailable', { err })
  }
  const parts: string[] = []
  const images: LlmImage[] = []
  let used = 0
  for (const ref of refs) {
    const info = infos.find((i) => i.id === ref.id)
    const name = info?.file_name ?? ref.name
    if (!info || info.status === 'failed') {
      parts.push(`[The file “${name}” is not available.]`)
      continue
    }
    if (info.status === 'processing') {
      parts.push(`[The file “${name}” is still being processed.]`)
      continue
    }
    if (info.kind === 'image' && acceptsImages && isModelImage(info.mime_type)) {
      const bytes = await ctx.attachments.readBytes(info.id).catch(() => null)
      if (bytes && isModelImage(bytes.mimeType)) {
        images.push({ mimeType: bytes.mimeType, data: bytes.bytes })
        parts.push(`[Image attached: “${name}”.]`)
        continue
      }
    }
    const room = Math.min(FILE_CHARS, TOTAL_CHARS - used)
    if (room < 200) {
      parts.push(`[The file “${name}” did not fit in this message.]`)
      continue
    }
    const content = await ctx.attachments.readContent(info.id, room).catch(() => null)
    const body = info.kind === 'image' ? (content?.summary ?? content?.markdown) : (content?.markdown ?? content?.summary)
    if (!body?.trim()) {
      parts.push(
        info.kind === 'image'
          ? `[An image “${name}” is attached, but this model can't read images and no description is available.]`
          : `[The file “${name}” has no readable text.]`
      )
      continue
    }
    const cut = truncateLines(body.trim(), room).text
    used += cut.length
    parts.push(`${info.kind === 'image' ? 'Description of the attached image' : 'Attached file'} “${name}”:\n"""\n${cut}\n"""`)
  }
  return { text: parts.join('\n\n'), images }
}
