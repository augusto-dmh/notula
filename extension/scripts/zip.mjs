// SPDX-License-Identifier: Apache-2.0
// A minimal, reproducible zip writer on node:zlib (no dependency): sorted entries, one fixed
// timestamp, deflate when it helps. Enough for store uploads.
import { crc32, deflateRawSync } from 'node:zlib'

// 2026-01-01 00:00 in MS-DOS format, so the same files always give the same zip.
const DOS_TIME = 0
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1

/** @param {{ name: string, data: Buffer }[]} files */
export function zip(files) {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const locals = []
  const centrals = []
  let offset = 0
  for (const f of sorted) {
    const name = Buffer.from(f.name.replace(/\\/g, '/'), 'utf8')
    const deflated = deflateRawSync(f.data, { level: 9 })
    const useDeflate = deflated.length < f.data.length
    const body = useDeflate ? deflated : f.data
    const crc = crc32(f.data) >>> 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(f.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(useDeflate ? 8 : 0, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(f.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(sorted.length, 8)
  end.writeUInt16LE(sorted.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

/** Lists a zip's entry names, for the build's own checks. */
export function zipNames(buf) {
  const names = []
  const endAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const count = buf.readUInt16LE(endAt + 10)
  let pos = buf.readUInt32LE(endAt + 16)
  for (let i = 0; i < count; i++) {
    const len = buf.readUInt16LE(pos + 28)
    const extra = buf.readUInt16LE(pos + 30)
    const comment = buf.readUInt16LE(pos + 32)
    names.push(buf.toString('utf8', pos + 46, pos + 46 + len))
    pos += 46 + len + extra + comment
  }
  return names
}
