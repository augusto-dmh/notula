// SPDX-License-Identifier: Apache-2.0
// Frame helpers for screen-share snapshots: the stored JPEG,
// the analysis copy, the 64 × 36 grayscale fingerprint, the black/empty test and the
// change rule. Pure functions over Electron's `nativeImage`.

import type { NativeImage } from 'electron'
import { SCREEN_SNAPSHOT_LIMITS as L } from '@shared/types/snapshots'

export interface Fingerprint {
  width: number
  height: number
  luma: Uint8Array
  mean: number
}

/** Scales so the longer side is at most `maxSide`; never upscales. */
export function fit(image: NativeImage, maxSide: number): NativeImage {
  const { width, height } = image.getSize()
  const longer = Math.max(width, height)
  if (longer <= maxSide || longer === 0) return image
  const k = maxSide / longer
  return image.resize({ width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), quality: 'best' })
}

export function fingerprint(image: NativeImage): Fingerprint {
  const { width, height } = image.getSize()
  const small = image.resize({ width: L.fingerprint.width, height: L.fingerprint.height, quality: 'good' })
  const bmp = small.toBitmap()
  const n = L.fingerprint.width * L.fingerprint.height
  const luma = new Uint8Array(n)
  let sum = 0
  // toBitmap is BGRA on every platform Electron supports.
  for (let i = 0; i < n && i * 4 + 2 < bmp.length; i++) {
    const b = bmp[i * 4] as number
    const g = bmp[i * 4 + 1] as number
    const r = bmp[i * 4 + 2] as number
    const y = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)
    luma[i] = y
    sum += y
  }
  return { width, height, luma, mean: sum / n }
}

/** An empty image, or an all-black one (mean luma below 2), is "not visible". */
export function invisible(image: NativeImage, fp: Fingerprint | null): boolean {
  if (image.isEmpty()) return true
  const { width, height } = image.getSize()
  if (width < 2 || height < 2) return true
  return fp !== null && fp.mean < L.blackLuma
}

/** Changed when the size differs by > 5 %, the mean |Δluma| ≥ 0.5, or ≥ 0.2 % of samples differ by ≥ 4. */
export function changed(prev: Fingerprint | null, next: Fingerprint): boolean {
  if (!prev) return true
  const dw = Math.abs(prev.width - next.width) / Math.max(1, prev.width)
  const dh = Math.abs(prev.height - next.height) / Math.max(1, prev.height)
  if (dw > 0.05 || dh > 0.05) return true
  let total = 0
  let big = 0
  const n = Math.min(prev.luma.length, next.luma.length)
  for (let i = 0; i < n; i++) {
    const d = Math.abs((prev.luma[i] as number) - (next.luma[i] as number))
    total += d
    if (d >= 4) big++
  }
  return total / Math.max(1, n) >= 0.5 || big / Math.max(1, n) >= 0.002
}
