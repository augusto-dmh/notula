// SPDX-License-Identifier: Apache-2.0
// The notula-convert utility process, built to
// out/main/convert.js: chat and folder files to markdown.
// Bytes in, text out: no disk, no network, no keys. Main forks it on demand with a 1 GB
// heap, kills it after 60 s idle and gives each file 60 s.
//
// - text/*: UTF-8, invalid bytes replaced;
// - JSON: pretty-printed in a fenced `json` block;
// - PDF (unpdf): each page's text under a `Page <n>` heading;
// - .docx (mammoth): its HTML turned into markdown by html-markdown.ts;
// - .xlsx (read-excel-file): each sheet as a table under its name, at most 1,000 rows,
//   then `(<n> more rows)`.

import mammoth from 'mammoth'
import readXlsxFile from 'read-excel-file/node'
import { extractText, getDocumentProxy } from 'unpdf'
import type { ConvertKind, ConvertReply, ConvertRequest } from './convert-protocol'
import { htmlToMarkdown } from './html-markdown'

function utf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^﻿/, '')
}

function json(bytes: Uint8Array): string {
  const text = utf8(bytes)
  let body = text
  try {
    body = JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    // Not valid JSON: the text as it is, still fenced.
  }
  return `\`\`\`json\n${body.replace(/```/g, '`​``')}\n\`\`\``
}

async function pdfDocument(bytes: Uint8Array): ReturnType<typeof getDocumentProxy> {
  // pdf.js takes ownership of the buffer it is given: hand it a copy.
  return getDocumentProxy(new Uint8Array(bytes))
}

/** The document's worker-side resources; unpdf's types do not declare `destroy`. */
async function release(doc: unknown): Promise<void> {
  await (doc as { destroy?(): Promise<void> }).destroy?.().catch(() => undefined)
}

async function pdf(bytes: Uint8Array): Promise<{ markdown: string; pageCount: number }> {
  const doc = await pdfDocument(bytes)
  try {
    const { totalPages, text } = await extractText(doc, { mergePages: false })
    const pages = (Array.isArray(text) ? text : [text]).map((t, i) => `## Page ${i + 1}\n\n${String(t).trim()}`)
    return { markdown: pages.join('\n\n'), pageCount: totalPages }
  } finally {
    await release(doc)
  }
}

async function pdfPages(bytes: Uint8Array): Promise<number> {
  const doc = await pdfDocument(bytes)
  try {
    return doc.numPages
  } finally {
    await release(doc)
  }
}

async function docx(bytes: Uint8Array): Promise<string> {
  const { value } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) }, { externalFileAccess: false })
  return htmlToMarkdown(value)
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = v instanceof Date ? (Number.isNaN(v.getTime()) ? '' : v.toISOString().replace(/T00:00:00\.000Z$/, '')) : String(v)
  return s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim()
}

async function xlsx(bytes: Uint8Array, maxRows: number): Promise<string> {
  const sheets = await readXlsxFile(Buffer.from(bytes))
  const parts: string[] = []
  for (const { sheet, data } of sheets) {
    const rows = data.filter((r) => r.some((c) => cell(c) !== ''))
    if (rows.length === 0) {
      parts.push(`## ${sheet}\n\n(empty sheet)`)
      continue
    }
    const kept = rows.slice(0, maxRows)
    const width = Math.max(...kept.map((r) => r.length), 1)
    const line = (r: unknown[]): string => `| ${Array.from({ length: width }, (_, i) => cell(r[i])).join(' | ')} |`
    const table = [line(kept[0] as unknown[]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...kept.slice(1).map((r) => line(r))]
    const more = rows.length - kept.length
    parts.push(`## ${sheet}\n\n${table.join('\n')}${more > 0 ? `\n\n(${more} more rows)` : ''}`)
  }
  return parts.join('\n\n')
}

async function convert(kind: ConvertKind, bytes: Uint8Array, sheetMaxRows: number): Promise<{ markdown: string; pageCount?: number }> {
  switch (kind) {
    case 'text':
      return { markdown: utf8(bytes) }
    case 'json':
      return { markdown: json(bytes) }
    case 'pdf':
      return pdf(bytes)
    case 'docx':
      return { markdown: await docx(bytes) }
    case 'xlsx':
      return { markdown: await xlsx(bytes, sheetMaxRows) }
  }
}

function reason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.split('\n')[0]?.slice(0, 300) || 'The file could not be read.'
}

process.parentPort.on('message', (e: { data: ConvertRequest }) => {
  const req = e.data
  const reply = (r: ConvertReply): void => process.parentPort.postMessage(r)
  void (async () => {
    try {
      if (req.op === 'pdf-pages') {
        reply({ id: req.id, ok: true, pageCount: await pdfPages(req.bytes) })
      } else {
        const out = await convert(req.kind, req.bytes, req.sheetMaxRows)
        reply({ id: req.id, ok: true, markdown: out.markdown, ...(out.pageCount !== undefined ? { pageCount: out.pageCount } : {}) })
      }
    } catch (err) {
      reply({ id: req.id, ok: false, error: reason(err) })
    }
  })()
})
