// SPDX-License-Identifier: Apache-2.0
// The read-only scan. Walks the root recursively with async fs and reads only regular
// files, opened read-only; nothing in the root is created, renamed, locked or written.
//
// - Hidden entries (a leading `.`) and `node_modules/` are skipped silently; the root's
//   `.obsidian/` is only noted (it marks an Obsidian vault).
// - Symbolic links and junctions are listed as skipped and never followed.
// - `.md`, `.markdown` and `.txt` files (and `index.csv`) are read once: UTF-8 (BOM stripped) or UTF-16 by BOM; a
//   NUL byte marks a binary file; invalid UTF-8 is decoded with replacement characters and
//   flagged. Every other file is listed as skipped.
// - Limits: 20,000 entries, depth 16, 4 MB per file, 1 GB per scan.
// No Electron: the dev harness runs it on a fixture tree.

import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { IMPORT_LIMITS } from '@shared/types/imports-markdown'
import type { SourceFile } from './formats'

export const SCAN_COPY = {
  tooLarge: 'This folder is too large. Choose a smaller folder.',
  unreadable: 'Notula can’t read this folder.',
  overSize: `Over ${IMPORT_LIMITS.fileBytes / 1_048_576} MB`,
  link: 'Links to other folders aren’t followed',
  binary: 'Not a text file',
  notMarkdown: 'Not a Markdown file',
  attachment: 'Attachments aren’t imported yet',
  deep: 'Too deeply nested',
  drawing: 'Drawings and canvases aren’t imported',
  vanished: 'The file was moved or deleted'
} as const

/** Read as text: Markdown, `.txt` transcripts, and a Notula export's `index.csv`. */
const TEXT_EXT = /(\.(md|markdown|txt)|(^|[\\/])index\.csv)$/i
const ATTACHMENT_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|heic|heif|tiff?|avif|pdf|mp4|mov|webm|mkv|mp3|m4a|wav|ogg|flac|docx?|xlsx?|pptx?|zip)$/i
const DRAWING = /(\.canvas|\.excalidraw\.md|\.excalidraw)$/i

export interface ScannedFile extends SourceFile {
  abs: string
  /** SHA-256 of the bytes. */
  sha256: string
}

export interface ScanResult {
  root: string
  files: ScannedFile[]
  /** Listed with a reason (silent skips aren't here). */
  skipped: { rel: string; reason: string }[]
  /** Relative directory paths, forward slashes. */
  dirs: Set<string>
  /** The root holds `.obsidian/`. */
  obsidian: boolean
  bytesRead: number
}

export class ScanError extends Error {}

export interface ScanOpts {
  /** Picked files (relative to `root`); the whole tree when absent. */
  only?: string[]
  signal?: AbortSignal
  onProgress?: (read: number, total: number) => void
}

/** Forward slashes, as stored. */
export function toRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/')
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The content hash of an item: a single file's SHA-256, or for a multi-file item the hash over
 * each file's name and digest in name order. Paths stay out, so a copy elsewhere matches.
 */
export function itemHash(files: { rel: string; sha256: string }[]): string {
  if (files.length === 1) return files[0]!.sha256
  const named = files.map((f) => ({ name: f.rel.slice(f.rel.lastIndexOf('/') + 1), sha: f.sha256 }))
  const h = createHash('sha256')
  for (const f of named.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) h.update(`${f.name}\u0000${f.sha}\n`)
  return h.digest('hex')
}

/** Decoded text, or null for a binary file. */
export function decode(bytes: Uint8Array): { text: string; lossy: boolean } | null {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), lossy: false }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), lossy: false }
  const body = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes
  if (body.includes(0)) return null
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), lossy: false }
  } catch {
    return { text: new TextDecoder('utf-8').decode(body), lossy: true }
  }
}

/** Reads one file (the run reads again and re-hashes before writing), or why it can't. */
export async function readOne(root: string, rel: string): Promise<ScannedFile | 'vanished' | 'binary' | 'size'> {
  const abs = join(root, ...rel.split('/'))
  try {
    const st = await lstat(abs)
    if (!st.isFile()) return 'vanished'
    // A parent folder replaced by a link since the preview must not lead outside the root.
    const inside = relative(await realpath(root), await realpath(abs))
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) return 'vanished'
    if (st.size > IMPORT_LIMITS.fileBytes) return 'size'
    const bytes = await readFile(abs, { flag: 'r' })
    if (bytes.length > IMPORT_LIMITS.fileBytes) return 'size'
    const dec = decode(bytes)
    if (!dec) return 'binary'
    return {
      abs,
      rel,
      name: basename(abs),
      text: dec.text,
      lossy: dec.lossy,
      size: st.size,
      mtimeMs: st.mtimeMs,
      birthtimeMs: st.birthtimeMs > 0 && st.birthtimeMs <= st.mtimeMs ? st.birthtimeMs : 0,
      sha256: sha256(bytes)
    }
  } catch {
    return 'vanished'
  }
}

export async function scanFolder(root: string, opts: ScanOpts = {}): Promise<ScanResult> {
  const out: ScanResult = { root, files: [], skipped: [], dirs: new Set(), obsidian: false, bytesRead: 0 }
  const toRead: { abs: string; rel: string; size: number }[] = []
  let entries = 0

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (opts.signal?.aborted) return
    let list: import('node:fs').Dirent[]
    try {
      list = await readdir(dir, { withFileTypes: true })
    } catch {
      if (dir === root) throw new ScanError(SCAN_COPY.unreadable)
      out.skipped.push({ rel: toRel(root, dir), reason: SCAN_COPY.unreadable })
      return
    }
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const d of list) {
      if (d.name.startsWith('.')) {
        if (dir === root && d.name === '.obsidian') out.obsidian = true
        continue
      }
      if (d.name === 'node_modules') continue
      if (++entries > IMPORT_LIMITS.entries) throw new ScanError(SCAN_COPY.tooLarge)
      const abs = join(dir, d.name)
      const rel = toRel(root, abs)
      let st: import('node:fs').Stats
      try {
        st = await lstat(abs)
      } catch {
        out.skipped.push({ rel, reason: SCAN_COPY.vanished })
        continue
      }
      if (st.isSymbolicLink() || d.isSymbolicLink()) {
        out.skipped.push({ rel, reason: SCAN_COPY.link })
        continue
      }
      if (st.isDirectory()) {
        if (depth + 1 > IMPORT_LIMITS.depth) {
          out.skipped.push({ rel, reason: SCAN_COPY.deep })
          continue
        }
        out.dirs.add(rel)
        await visit(abs, depth + 1)
        continue
      }
      if (!st.isFile()) continue
      if (DRAWING.test(d.name)) out.skipped.push({ rel, reason: SCAN_COPY.drawing })
      else if (!TEXT_EXT.test(d.name)) out.skipped.push({ rel, reason: ATTACHMENT_EXT.test(d.name) ? SCAN_COPY.attachment : SCAN_COPY.notMarkdown })
      else if (st.size > IMPORT_LIMITS.fileBytes) out.skipped.push({ rel, reason: SCAN_COPY.overSize })
      else toRead.push({ abs, rel, size: st.size })
    }
  }

  if (opts.only) {
    for (const rel of opts.only) {
      if (++entries > IMPORT_LIMITS.entries) throw new ScanError(SCAN_COPY.tooLarge)
      const abs = join(root, ...rel.split('/'))
      let st: import('node:fs').Stats
      try {
        st = await lstat(abs)
      } catch {
        out.skipped.push({ rel, reason: SCAN_COPY.vanished })
        continue
      }
      if (st.isSymbolicLink()) out.skipped.push({ rel, reason: SCAN_COPY.link })
      else if (!st.isFile()) continue
      else if (DRAWING.test(rel)) out.skipped.push({ rel, reason: SCAN_COPY.drawing })
      else if (!TEXT_EXT.test(rel)) out.skipped.push({ rel, reason: ATTACHMENT_EXT.test(rel) ? SCAN_COPY.attachment : SCAN_COPY.notMarkdown })
      else if (st.size > IMPORT_LIMITS.fileBytes) out.skipped.push({ rel, reason: SCAN_COPY.overSize })
      else toRead.push({ abs, rel, size: st.size })
      const parts = rel.split('/')
      for (let i = 1; i < parts.length; i++) out.dirs.add(parts.slice(0, i).join('/'))
    }
  } else {
    await visit(root, 0)
  }

  const total = toRead.length
  opts.onProgress?.(0, total)
  for (let i = 0; i < toRead.length; i++) {
    if (opts.signal?.aborted) break
    const t = toRead[i]!
    if (out.bytesRead + t.size > IMPORT_LIMITS.scanBytes) throw new ScanError(SCAN_COPY.tooLarge)
    const f = await readOne(root, t.rel)
    if (typeof f === 'string') {
      out.skipped.push({ rel: t.rel, reason: f === 'binary' ? SCAN_COPY.binary : f === 'size' ? SCAN_COPY.overSize : SCAN_COPY.vanished })
    } else {
      out.bytesRead += f.size
      out.files.push(f)
    }
    if ((i + 1) % 25 === 0 || i + 1 === total) opts.onProgress?.(i + 1, total)
  }
  return out
}
