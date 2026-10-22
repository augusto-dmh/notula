// SPDX-License-Identifier: Apache-2.0
// Image resizing in main (`nativeImage` exists only in main and renderers). A
// note image fits within 2,000 × 2,000 px, a chat image within 1,568 × 1,568 px;
// the format is kept. An image already small enough is stored as it came.

import { nativeImage } from 'electron'

export interface PreparedImage {
  bytes: Buffer
  mimeType: 'image/png' | 'image/jpeg'
  width: number
  height: number
  resized: boolean
}

const JPEG_QUALITY = 90

/** Decodes, fits within `maxSide` and re-encodes in the same format. Throws when undecodable. */
export function prepareImage(bytes: Buffer, mimeType: 'image/png' | 'image/jpeg', maxSide: number, opts?: { reencode?: boolean }): PreparedImage {
  const img = nativeImage.createFromBuffer(bytes)
  if (img.isEmpty()) throw new Error('the image could not be decoded')
  const { width, height } = img.getSize()
  if (!width || !height) throw new Error('the image has no size')
  const longest = Math.max(width, height)
  if (longest <= maxSide && !opts?.reencode) return { bytes, mimeType, width, height, resized: false }
  const scale = Math.min(1, maxSide / longest)
  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))
  const out = scale < 1 ? img.resize({ width: w, height: h, quality: 'best' }) : img
  const encoded = mimeType === 'image/png' ? out.toPNG() : out.toJPEG(JPEG_QUALITY)
  if (encoded.length === 0) throw new Error('the image could not be encoded')
  const size = out.getSize()
  return { bytes: encoded, mimeType, width: size.width, height: size.height, resized: scale < 1 }
}
