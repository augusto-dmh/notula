// SPDX-License-Identifier: Apache-2.0
// The six app icon colours, drawn at runtime with
// plain bitmap maths: a rounded tile in the colour, holding a notepad page with three lines. No
// image files ship for it.

import { nativeImage, type NativeImage } from 'electron'
import type { AppIconValue } from '@shared/types/app-icon'

type Rgb = readonly [number, number, number]

interface Palette {
  tile: Rgb
  /** A thin ring inside the tile edge, so the light tile still reads on a light taskbar. */
  ring?: Rgb
  page: Rgb
  line: Rgb
}

const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]

export const APP_ICON_TINTS: Record<AppIconValue, Palette> = {
  black: { tile: hex('#1f1f23'), page: hex('#ffffff'), line: hex('#1f1f23') },
  white: { tile: hex('#ffffff'), ring: hex('#d6d6dc'), page: hex('#26262b'), line: hex('#ffffff') },
  blue: { tile: hex('#2f6bff'), page: hex('#ffffff'), line: hex('#2f6bff') },
  yellow: { tile: hex('#f5b800'), page: hex('#ffffff'), line: hex('#d99e00') },
  red: { tile: hex('#e5484d'), page: hex('#ffffff'), line: hex('#e5484d') },
  pink: { tile: hex('#ec6cb9'), page: hex('#ffffff'), line: hex('#ec6cb9') }
}

/** Signed distance from a point to a rounded rectangle (negative inside). */
function roundRect(px: number, py: number, x0: number, y0: number, x1: number, y1: number, r: number): number {
  const qx = Math.abs(px - (x0 + x1) / 2) - ((x1 - x0) / 2 - r)
  const qy = Math.abs(py - (y0 + y1) / 2) - ((y1 - y0) / 2 - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}

const coverage = (d: number): number => Math.min(1, Math.max(0, 0.5 - d))

interface Shape {
  /** Distance in pixels at this size. */
  dist(x: number, y: number): number
  color: Rgb
}

/** Renders the icon at `size` px as premultiplied BGRA, the layout `nativeImage.createFromBitmap` takes. */
export function renderIcon(value: AppIconValue, size = 256): Buffer {
  const p = APP_ICON_TINTS[value]
  const k = size / 256
  const rr =
    (x0: number, y0: number, x1: number, y1: number, r: number) =>
    (x: number, y: number): number =>
      roundRect(x, y, x0 * k, y0 * k, x1 * k, y1 * k, r * k)
  const shapes: Shape[] = []
  if (p.ring) {
    shapes.push({ dist: rr(16, 16, 240, 240, 56), color: p.ring })
    shapes.push({ dist: rr(22, 22, 234, 234, 50), color: p.tile })
  } else {
    shapes.push({ dist: rr(16, 16, 240, 240, 56), color: p.tile })
  }
  shapes.push({ dist: rr(74, 56, 182, 200, 20), color: p.page })
  shapes.push({ dist: rr(96, 94, 160, 108, 7), color: p.line })
  shapes.push({ dist: rr(96, 122, 160, 136, 7), color: p.line })
  shapes.push({ dist: rr(96, 150, 140, 164, 7), color: p.line })

  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5
      const cy = y + 0.5
      // Straight-alpha "over", bottom to top.
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (const s of shapes) {
        const c = coverage(s.dist(cx, cy))
        if (c <= 0) continue
        const na = c + a * (1 - c)
        r = (s.color[0] * c + r * a * (1 - c)) / na
        g = (s.color[1] * c + g * a * (1 - c)) / na
        b = (s.color[2] * c + b * a * (1 - c)) / na
        a = na
      }
      const i = (y * size + x) * 4
      out[i] = Math.round(b * a)
      out[i + 1] = Math.round(g * a)
      out[i + 2] = Math.round(r * a)
      out[i + 3] = Math.round(a * 255)
    }
  }
  return out
}

const cache = new Map<AppIconValue, NativeImage>()

export function iconImage(value: AppIconValue): NativeImage {
  let img = cache.get(value)
  if (!img) {
    const size = 256
    img = nativeImage.createFromBitmap(renderIcon(value, size), { width: size, height: size })
    cache.set(value, img)
  }
  return img
}
