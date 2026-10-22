// SPDX-License-Identifier: Apache-2.0
// SHA-256 checks of model files. Node
// built-ins only, so main and both workers share it.

import { createHash } from 'node:crypto'
import { closeSync, createReadStream, openSync, readSync, statSync } from 'node:fs'
import type { VerifiedFile } from './protocol'

const READ_CHUNK = 4 * 1024 * 1024

/** The file's SHA-256, read synchronously (the workers verify before loading). */
export function sha256FileSync(path: string): string {
  const hash = createHash('sha256')
  const buf = Buffer.allocUnsafe(READ_CHUNK)
  const fd = openSync(path, 'r')
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, READ_CHUNK, null)
      if (n <= 0) break
      hash.update(buf.subarray(0, n))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

/** The file's SHA-256, streamed (main, so it never blocks). */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const s = createReadStream(path, { highWaterMark: READ_CHUNK })
    s.on('data', (d) => hash.update(d))
    s.on('error', reject)
    s.on('end', () => resolve(hash.digest('hex')))
  })
}

/** Null when every file has its pinned size and hash; otherwise what is wrong. */
export function verifyFilesSync(files: readonly VerifiedFile[]): string | null {
  for (const f of files) {
    let size: number
    try {
      size = statSync(f.path).size
    } catch {
      return `missing model file ${baseName(f.path)}`
    }
    if (size !== f.bytes) return `model file ${baseName(f.path)} has ${size} bytes, expected ${f.bytes}`
    const got = sha256FileSync(f.path)
    if (got !== f.sha256) return `integrity check failed for ${baseName(f.path)}: expected ${f.sha256}, got ${got}`
  }
  return null
}

export function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}
