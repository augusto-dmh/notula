// SPDX-License-Identifier: Apache-2.0
// What an attachment is, before it is stored: the declared type from the name, the real
// type from the first bytes, and the rejection messages. Pure functions; main reads the
// bytes, nothing here does I/O.

import { extname } from 'node:path'
import { ATTACHMENT_FILE_TYPES, ATTACHMENT_LIMITS } from '@shared/types/attachments'

export const MIME = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  pdf: 'application/pdf',
  json: 'application/json',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  markdown: 'text/markdown',
  text: 'text/plain'
} as const

/** File extensions → the declared MIME type. `text/*` covers the common plain-text formats. */
const BY_EXTENSION: Record<string, string> = {
  '.png': MIME.png,
  '.jpg': MIME.jpeg,
  '.jpeg': MIME.jpeg,
  '.pdf': MIME.pdf,
  '.json': MIME.json,
  '.docx': MIME.docx,
  '.doc': MIME.doc,
  '.xlsx': MIME.xlsx,
  '.xls': MIME.xls,
  '.md': MIME.markdown,
  '.markdown': MIME.markdown,
  '.txt': MIME.text,
  '.text': MIME.text,
  '.log': MIME.text,
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'text/xml',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.ics': 'text/calendar',
  '.vtt': 'text/vtt',
  '.srt': 'text/plain',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'text/plain',
  '.py': 'text/plain',
  '.sql': 'text/plain',
  '.rtf': 'text/rtf',
  // Recognised so they can be named in the "unsupported" message.
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.svg': 'image/svg+xml',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip'
}

/** The declared type of a named file; `application/octet-stream` when unknown. */
export function mimeFromName(name: string): string {
  return BY_EXTENSION[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

/** The accepted types; `text/*` by prefix. */
export function isSupportedFileType(mime: string): boolean {
  const m = mime.toLowerCase()
  return ATTACHMENT_FILE_TYPES.includes(m) || (m.startsWith('text/') && ATTACHMENT_FILE_TYPES.includes('text/*'))
}

export type Sniffed = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'tiff' | 'heic' | 'pdf' | 'zip' | 'ole' | null

/** The real format from the first bytes. `zip` covers .docx/.xlsx; `ole` covers legacy .doc/.xls. */
export function sniff(b: Uint8Array): Sniffed {
  const at = (i: number): number => b[i] ?? -1
  const ascii = (from: number, s: string): boolean => [...s].every((c, i) => at(from + i) === c.charCodeAt(0))
  if (at(0) === 0x89 && ascii(1, 'PNG')) return 'png'
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'jpeg'
  if (ascii(0, 'GIF8')) return 'gif'
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'webp'
  if (ascii(0, 'BM')) return 'bmp'
  if ((ascii(0, 'II') && at(2) === 42 && at(3) === 0) || (ascii(0, 'MM') && at(2) === 0 && at(3) === 42)) return 'tiff'
  if (ascii(4, 'ftyp') && (ascii(8, 'heic') || ascii(8, 'heix') || ascii(8, 'mif1') || ascii(8, 'heif'))) return 'heic'
  if (ascii(0, '%PDF-')) return 'pdf'
  if (at(0) === 0x50 && at(1) === 0x4b && at(2) === 0x03 && at(3) === 0x04) return 'zip'
  if (at(0) === 0xd0 && at(1) === 0xcf && at(2) === 0x11 && at(3) === 0xe0) return 'ole'
  return null
}

const IMAGE_FORMAT_NAME: Partial<Record<NonNullable<Sniffed>, string>> = {
  gif: 'GIF',
  webp: 'WebP',
  bmp: 'BMP',
  tiff: 'TIFF',
  heic: 'HEIC'
}

/** Runs of whitespace in file names collapse to one space. */
export function cleanFileName(name: string): string {
  return name.replace(/\s+/g, ' ').trim() || 'file'
}

const MB = 1024 * 1024
const mb = (bytes: number): string => (bytes / MB).toFixed(1).replace(/\.0$/, '')

/** The rejection messages, including the one for legacy `.doc` / `.xls` files. */
export const COPY = {
  maxImages: 'Maximum of 10 attachments reached',
  unsupportedImage: 'Unsupported file type',
  uploadImageFailed: 'Couldn’t add the image. Try again.',
  tooManyFiles: `You can add up to ${ATTACHMENT_LIMITS.filesPerSelection} files at a time.`,
  unsupportedTypes: (types: string[]): string => `Unsupported file type(s): ${types.join(', ')}`,
  tooLarge: (names: string[]): string => `Too large to attach: ${names.join(', ')}. Try smaller files.`,
  totalTooLarge: (bytes: number, limit: number): string => `Files total ${mb(bytes)} MB, over the ${mb(limit)} MB limit. Remove some.`,
  tooManyPages: (names: string[]): string =>
    `PDFs can have up to ${ATTACHMENT_LIMITS.pdfMaxPages} pages. Split these and try again: ${names.join(', ')}`,
  totalPages: (pages: number, limit: number): string =>
    `These PDFs have ${pages} pages in total, over the ${limit}-page limit. Attach fewer or shorter PDFs.`,
  pdfFailed: 'Couldn’t read this PDF. It may be damaged or password-protected.',
  uploadFailed: (name: string): string => `Couldn’t upload "${name}"`,
  legacyDoc: 'File rejected: Legacy .doc files are not supported. Save as .docx and try again.',
  legacyXls: 'File rejected: Legacy .xls files are not supported. Save as .xlsx and try again.',
  wrongImageFormat: (name: string, format: string, declared: string): string =>
    `“${name}” is in ${format} format, not ${declared}. Change its extension to match, then attach it again.`
} as const

/** A note image's real type: PNG or JPEG by its bytes, else null. */
export function noteImageType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | null {
  const s = sniff(bytes)
  return s === 'png' ? MIME.png : s === 'jpeg' ? MIME.jpeg : null
}

/** The name of an unsupported image format hiding behind a PNG/JPEG name, or null. */
export function disguisedImageFormat(bytes: Uint8Array): string | null {
  const s = sniff(bytes)
  return s ? (IMAGE_FORMAT_NAME[s] ?? null) : null
}

/** The legacy-format rejection, by declared type or by an OLE container under a modern name. */
export function legacyRejection(mime: string, bytes: Uint8Array | null): string | null {
  if (mime === MIME.doc) return COPY.legacyDoc
  if (mime === MIME.xls) return COPY.legacyXls
  if (bytes && sniff(bytes) === 'ole') {
    if (mime === MIME.docx) return COPY.legacyDoc
    if (mime === MIME.xlsx) return COPY.legacyXls
  }
  return null
}

/** The size estimate of an existing image: width × height × 0.1024 bytes. */
export function estimatedImageBytes(width: number, height: number): number {
  return Math.round(width * height * 0.1024)
}

/** `token_estimate` = the markdown length / 4, rounded up. */
export function tokensOf(markdown: string): number {
  return Math.ceil(markdown.length / 4)
}
