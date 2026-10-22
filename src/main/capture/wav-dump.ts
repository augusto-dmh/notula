// SPDX-License-Identifier: Apache-2.0
// Dev-only debug WAV dump: with NOTULA_DEV_DUMP_AUDIO=1 in an
// unpackaged build, every batch the batcher hands to transcription is also written
// to `<userData>/debug-audio/<time>-<note>-<source>.wav` (16 kHz, mono, s16le).

import { mkdirSync, openSync, writeSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import type { AudioSource } from '@shared/types/common'
import { log } from '../log'
import { SAMPLE_RATE } from './batcher'

const HEADER_BYTES = 44

function header(dataBytes: number): Buffer {
  const h = Buffer.alloc(HEADER_BYTES)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + dataBytes, 4)
  h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii')
  h.writeUInt32LE(16, 16) // PCM fmt chunk size
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(1, 22) // mono
  h.writeUInt32LE(SAMPLE_RATE, 24)
  h.writeUInt32LE(SAMPLE_RATE * 2, 28) // byte rate
  h.writeUInt16LE(2, 32) // block align
  h.writeUInt16LE(16, 34) // bits per sample
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(dataBytes, 40)
  return h
}

interface Track {
  fd: number
  path: string
  bytes: number
}

export class WavDump {
  private readonly tracks = new Map<AudioSource, Track>()

  private constructor(
    private readonly dir: string,
    private readonly prefix: string
  ) {}

  /** Null unless the dev flag is set in an unpackaged build. */
  static maybeCreate(opts: { userDataPath: string; isDev: boolean; noteId: string }): WavDump | null {
    if (!opts.isDev || process.env['NOTULA_DEV_DUMP_AUDIO'] !== '1') return null
    const dir = join(opts.userDataPath, 'debug-audio')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    return new WavDump(dir, `${stamp}-${opts.noteId.slice(0, 8)}`)
  }

  write(source: AudioSource, pcm: Buffer): void {
    try {
      let t = this.tracks.get(source)
      if (!t) {
        const path = join(this.dir, `${this.prefix}-${source}.wav`)
        const fd = openSync(path, 'w')
        writeSync(fd, header(0))
        t = { fd, path, bytes: 0 }
        this.tracks.set(source, t)
        log('info', 'capture:wav-dump-open', { source, path })
      }
      writeSync(t.fd, pcm)
      t.bytes += pcm.byteLength
    } catch (err) {
      log('warn', 'capture:wav-dump-write-failed', { source, err })
    }
  }

  close(): void {
    for (const [source, t] of this.tracks) {
      try {
        writeSync(t.fd, header(t.bytes), 0, HEADER_BYTES, 0)
        closeSync(t.fd)
        log('info', 'capture:wav-dump-closed', {
          source,
          path: t.path,
          bytes: t.bytes,
          seconds: t.bytes / (SAMPLE_RATE * 2)
        })
      } catch (err) {
        log('warn', 'capture:wav-dump-close-failed', { source, err })
      }
    }
    this.tracks.clear()
  }
}
