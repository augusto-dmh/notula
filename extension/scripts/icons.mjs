// SPDX-License-Identifier: Apache-2.0
// Renders the extension's icons from the app icon (resources/icon/icon-512.png): 16, 32, 48 and
// 128 px for the manifest, and the 300 px store logo Edge asks for. Run once when the app
// icon changes (`npm --prefix extension run icons`); the outputs are committed.
// Zero dependencies: a small PNG reader (8-bit RGBA, non-interlaced) and writer on node:zlib, and
// an area-average downscale in premultiplied alpha.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync, inflateSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const source = join(root, '..', 'resources', 'icon', 'icon-512.png')

function readPng(file) {
  const buf = readFileSync(file)
  let pos = 8
  let width = 0
  let height = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error('icons: expected 8-bit RGBA, non-interlaced')
    } else if (type === 'IDAT') idat.push(data)
    pos += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const out = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[y * stride + x - 4] : 0
      const b = y > 0 ? out[(y - 1) * stride + x] : 0
      const c = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[y * stride + x] = v & 0xff
    }
  }
  return { width, height, data: out }
}

function resize(img, size) {
  const out = Buffer.alloc(size * size * 4)
  const scale = img.width / size
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let w = 0
      const x0 = x * scale
      const x1 = (x + 1) * scale
      const y0 = y * scale
      const y1 = (y + 1) * scale
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0)
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0)
          const i = (sy * img.width + sx) * 4
          const alpha = img.data[i + 3] / 255
          const k = wx * wy
          r += img.data[i] * alpha * k
          g += img.data[i + 1] * alpha * k
          b += img.data[i + 2] * alpha * k
          a += alpha * k
          w += k
        }
      }
      const o = (y * size + x) * 4
      out[o] = a ? Math.round(r / a) : 0
      out[o + 1] = a ? Math.round(g / a) : 0
      out[o + 2] = a ? Math.round(b / a) : 0
      out[o + 3] = Math.round((a / w) * 255)
    }
  }
  return { width: size, height: size, data: out }
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([len, body, crc])
}

function writePng(file, img) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(img.width, 0)
  ihdr.writeUInt32BE(img.height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const stride = img.width * 4
  const raw = Buffer.alloc((stride + 1) * img.height)
  for (let y = 0; y < img.height; y++) img.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, png)
}

const img = readPng(source)
for (const size of [16, 32, 48, 128]) writePng(join(root, 'icons', `icon-${size}.png`), resize(img, size))
writePng(join(root, 'store', 'assets', 'logo-300.png'), resize(img, 300))
console.log('icons: wrote icons/icon-{16,32,48,128}.png and store/assets/logo-300.png')
