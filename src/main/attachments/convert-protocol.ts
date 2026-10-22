// SPDX-License-Identifier: Apache-2.0
// main ↔ notula-convert messages (N-internal). Bytes in, text out.

export type ConvertKind = 'text' | 'json' | 'pdf' | 'docx' | 'xlsx'

export type ConvertRequest =
  | { id: number; op: 'pdf-pages'; bytes: Uint8Array }
  | { id: number; op: 'convert'; kind: ConvertKind; name: string; bytes: Uint8Array; sheetMaxRows: number }

export type ConvertReply =
  | { id: number; ok: true; markdown?: string; pageCount?: number }
  | { id: number; ok: false; error: string }
