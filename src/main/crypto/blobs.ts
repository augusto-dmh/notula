// SPDX-License-Identifier: Apache-2.0
// Encrypted blobs with per-file keys. Node `crypto` only. Used by the storage worker
// (attachments) and by main (recordings, failed dictation audio). No plaintext ever reaches
// disk through this module.
//
// NTA1, single shot (attachments):
//   `NTA1` · version 0x01 · nonce (12) · AES-256-GCM ciphertext · tag (16)
//   AAD = the 5 header bytes (`NTA1` · version). The content key is random per file and
//   is stored wrapped with the attachments master key (`wrapKey`: 60 bytes = nonce ·
//   wrapped key · tag, AAD = `notula-attachment-key/1`).
//
// NAU1, framed stream (meeting recordings `.naud`, failed dictation audio):
//   a 31-byte header: `NAU1` · version 0x01 · codec 0x01 (pcm_s16le) · sample rate u32 LE
//   (16,000) · channels u8 (1) · max frame plaintext u32 LE (65,536) · id (16 raw UUID bytes);
//   then frames: nonce (12) · ciphertext length u32 LE · ciphertext · tag (16), with
//   AAD = id (16) · frame index u32 LE · last-frame flag u8. The key is random per file
//   and stored raw in its database row. A file without a last frame reads as incomplete;
//   its complete frames stay readable with `allowTruncated`.
//
// Deleting a row destroys its key (crypto-shredding): the file is unreadable even if
// its deletion fails.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { open, unlink, type FileHandle } from 'node:fs/promises'

export const KEY_BYTES = 32

const NONCE_BYTES = 12
const TAG_BYTES = 16

/** Any failure to authenticate or parse a blob: tampering, truncation (when not allowed), a wrong key. */
export class BlobIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BlobIntegrityError'
  }
}

export function randomKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

function assertKey(key: Buffer, what: string): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new TypeError(`${what} must be ${KEY_BYTES} bytes`)
}

function seal(plain: Buffer, key: Buffer, aad: Buffer): { nonce: Buffer; ciphertext: Buffer; tag: Buffer } {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES })
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
  return { nonce, ciphertext, tag: cipher.getAuthTag() }
}

/** null when the tag does not verify. */
function unseal(nonce: Buffer, ciphertext: Buffer, tag: Buffer, key: Buffer, aad: Buffer): Buffer | null {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES })
    decipher.setAAD(aad)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    return null
  }
}

// ---------- NTA1 (attachments) ----------

const NTA1_MAGIC = Buffer.from('NTA1', 'ascii')
const NTA1_VERSION = 0x01
const NTA1_HEADER = Buffer.concat([NTA1_MAGIC, Buffer.from([NTA1_VERSION])])
const WRAP_AAD = Buffer.from('notula-attachment-key/1', 'ascii')
const WRAPPED_KEY_BYTES = NONCE_BYTES + KEY_BYTES + TAG_BYTES

/** Encrypts one whole file with its content key. */
export function sealAttachment(plain: Buffer, contentKey: Buffer): Buffer {
  assertKey(contentKey, 'contentKey')
  const { nonce, ciphertext, tag } = seal(plain, contentKey, NTA1_HEADER)
  return Buffer.concat([NTA1_HEADER, nonce, ciphertext, tag])
}

/** Decrypts and authenticates an NTA1 file. Throws BlobIntegrityError. */
export function openAttachment(file: Buffer, contentKey: Buffer): Buffer {
  assertKey(contentKey, 'contentKey')
  if (file.length < NTA1_HEADER.length + NONCE_BYTES + TAG_BYTES) throw new BlobIntegrityError('attachment file is too short')
  if (!file.subarray(0, NTA1_HEADER.length).equals(NTA1_HEADER)) throw new BlobIntegrityError('not an NTA1 v1 file')
  const nonce = file.subarray(NTA1_HEADER.length, NTA1_HEADER.length + NONCE_BYTES)
  const ciphertext = file.subarray(NTA1_HEADER.length + NONCE_BYTES, file.length - TAG_BYTES)
  const tag = file.subarray(file.length - TAG_BYTES)
  const plain = unseal(nonce, ciphertext, tag, contentKey, NTA1_HEADER)
  if (!plain) throw new BlobIntegrityError('attachment failed authentication')
  return plain
}

/** Wraps a content key with the master key: 60 bytes (nonce · wrapped key · tag). */
export function wrapKey(contentKey: Buffer, masterKey: Buffer): Buffer {
  assertKey(contentKey, 'contentKey')
  assertKey(masterKey, 'masterKey')
  const { nonce, ciphertext, tag } = seal(contentKey, masterKey, WRAP_AAD)
  return Buffer.concat([nonce, ciphertext, tag])
}

/** Throws BlobIntegrityError. */
export function unwrapKey(wrapped: Buffer, masterKey: Buffer): Buffer {
  assertKey(masterKey, 'masterKey')
  if (!Buffer.isBuffer(wrapped) || wrapped.length !== WRAPPED_KEY_BYTES) throw new BlobIntegrityError('wrapped key has the wrong size')
  const key = unseal(
    wrapped.subarray(0, NONCE_BYTES),
    wrapped.subarray(NONCE_BYTES, NONCE_BYTES + KEY_BYTES),
    wrapped.subarray(NONCE_BYTES + KEY_BYTES),
    masterKey,
    WRAP_AAD
  )
  if (!key) throw new BlobIntegrityError('wrapped key failed authentication')
  return key
}

// ---------- NAU1 (framed audio) ----------

const NAU1_MAGIC = Buffer.from('NAU1', 'ascii')
const NAU1_VERSION = 0x01
const CODEC_PCM_S16LE = 0x01
const SAMPLE_RATE = 16_000
const CHANNELS = 1
const MAX_FRAME_PLAIN = 65_536
const NAU1_HEADER_BYTES = 31
const FRAME_LEAD = NONCE_BYTES + 4
const FLUSH_EVERY_MS = 1_000
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i

export interface FramedOptions {
  path: string
  key: Buffer
  /** A UUID: the file's row id, bound into every frame. */
  id: string
}

function idBytes(id: string): Buffer {
  if (!UUID.test(id)) throw new TypeError('id must be a UUID')
  return Buffer.from(id.replaceAll('-', ''), 'hex')
}

function frameAad(id: Buffer, index: number, last: boolean): Buffer {
  const aad = Buffer.alloc(16 + 4 + 1)
  id.copy(aad, 0)
  aad.writeUInt32LE(index, 16)
  aad.writeUInt8(last ? 1 : 0, 20)
  return aad
}

function nau1Header(id: Buffer): Buffer {
  const h = Buffer.alloc(NAU1_HEADER_BYTES)
  NAU1_MAGIC.copy(h, 0)
  h.writeUInt8(NAU1_VERSION, 4)
  h.writeUInt8(CODEC_PCM_S16LE, 5)
  h.writeUInt32LE(SAMPLE_RATE, 6)
  h.writeUInt8(CHANNELS, 10)
  h.writeUInt32LE(MAX_FRAME_PLAIN, 11)
  id.copy(h, 15)
  return h
}

/**
 * Streams 16 kHz s16le mono PCM into an NAU1 file. A frame is written when 64 KiB of
 * plaintext is buffered and at least once per second, so a crash loses at most about
 * 1 s. Writes are serialized; after a write error `append` drops data and `flush`,
 * `close` reject with that error.
 */
export class FramedWriter {
  private pending: Buffer[] = []
  private pendingBytes = 0
  private index = 0
  private fileBytes = NAU1_HEADER_BYTES
  private plainBytes = 0
  private chain: Promise<void> = Promise.resolve()
  private error: unknown = null
  private closed = false
  private readonly timer: NodeJS.Timeout

  private constructor(
    private readonly handle: FileHandle,
    private readonly opts: FramedOptions,
    private readonly id: Buffer
  ) {
    this.timer = setInterval(() => {
      if (this.pendingBytes > 0 && !this.closed) this.emit(this.take(this.pendingBytes), false)
    }, FLUSH_EVERY_MS)
    this.timer.unref()
  }

  /** Creates the file (never overwrites one) and writes the header. */
  static async create(o: FramedOptions): Promise<FramedWriter> {
    assertKey(o.key, 'key')
    const id = idBytes(o.id)
    const handle = await open(o.path, 'wx')
    try {
      await handle.write(nau1Header(id), 0, NAU1_HEADER_BYTES, 0)
    } catch (err) {
      await handle.close().catch(() => undefined)
      await unlink(o.path).catch(() => undefined)
      throw err
    }
    return new FramedWriter(handle, o, id)
  }

  append(pcm: Buffer): void {
    if (this.closed) throw new Error('FramedWriter is closed')
    if (this.error || pcm.length === 0) return
    this.pending.push(pcm)
    this.pendingBytes += pcm.length
    while (this.pendingBytes >= MAX_FRAME_PLAIN) this.emit(this.take(MAX_FRAME_PLAIN), false)
  }

  /** Writes whatever is buffered as a frame, then waits for every write so far. */
  async flush(): Promise<void> {
    if (!this.closed && this.pendingBytes > 0) this.emit(this.take(this.pendingBytes), false)
    await this.chain
    if (this.error) throw this.error
  }

  /** Writes the last frame (possibly empty) and closes the file. */
  async close(): Promise<{ fileBytes: number; plainBytes: number }> {
    if (this.closed) throw new Error('FramedWriter is closed')
    clearInterval(this.timer)
    if (!this.error) this.emit(this.take(this.pendingBytes), true)
    this.closed = true
    await this.chain
    try {
      if (!this.error) await this.handle.datasync()
    } finally {
      await this.handle.close()
    }
    if (this.error) throw this.error
    return { fileBytes: this.fileBytes, plainBytes: this.plainBytes }
  }

  /** Stops, closes and removes the file. */
  async abort(): Promise<void> {
    clearInterval(this.timer)
    this.closed = true
    this.pending = []
    this.pendingBytes = 0
    await this.chain.catch(() => undefined)
    await this.handle.close().catch(() => undefined)
    await unlink(this.opts.path).catch(() => undefined)
  }

  private take(n: number): Buffer {
    const all = this.pending.length === 1 ? this.pending[0]! : Buffer.concat(this.pending)
    const out = all.subarray(0, n)
    const rest = all.subarray(n)
    this.pending = rest.length > 0 ? [rest] : []
    this.pendingBytes = rest.length
    return out
  }

  private emit(plain: Buffer, last: boolean): void {
    const index = this.index++
    const { nonce, ciphertext, tag } = seal(plain, this.opts.key, frameAad(this.id, index, last))
    const len = Buffer.alloc(4)
    len.writeUInt32LE(ciphertext.length, 0)
    const frame = Buffer.concat([nonce, len, ciphertext, tag])
    const position = this.fileBytes
    this.fileBytes += frame.length
    this.plainBytes += plain.length
    this.chain = this.chain.then(async () => {
      if (this.error) return
      try {
        await this.handle.write(frame, 0, frame.length, position)
      } catch (err) {
        this.error = err
      }
    })
  }
}

interface FramedHeader {
  sampleRate: number
  channels: number
}

async function readExactly(h: FileHandle, length: number, position: number): Promise<Buffer> {
  const buf = Buffer.alloc(length)
  let got = 0
  while (got < length) {
    const { bytesRead } = await h.read(buf, got, length - got, position + got)
    if (bytesRead === 0) break
    got += bytesRead
  }
  return got === length ? buf : buf.subarray(0, got)
}

async function* frames(
  o: FramedOptions & { allowTruncated: boolean },
  onHeader?: (h: FramedHeader) => void
): AsyncGenerator<Buffer> {
  assertKey(o.key, 'key')
  const id = idBytes(o.id)
  const h = await open(o.path, 'r')
  try {
    const size = (await h.stat()).size
    const header = await readExactly(h, NAU1_HEADER_BYTES, 0)
    if (header.length < NAU1_HEADER_BYTES) throw new BlobIntegrityError('audio file is too short')
    if (!header.subarray(0, 4).equals(NAU1_MAGIC) || header.readUInt8(4) !== NAU1_VERSION) {
      throw new BlobIntegrityError('not an NAU1 v1 file')
    }
    if (header.readUInt8(5) !== CODEC_PCM_S16LE) throw new BlobIntegrityError('unknown audio codec')
    const maxFrame = header.readUInt32LE(11)
    if (maxFrame === 0 || maxFrame > MAX_FRAME_PLAIN) throw new BlobIntegrityError('invalid frame size')
    if (!header.subarray(15, 31).equals(id)) throw new BlobIntegrityError('audio file belongs to another recording')
    onHeader?.({ sampleRate: header.readUInt32LE(6), channels: header.readUInt8(10) })

    let position = NAU1_HEADER_BYTES
    for (let index = 0; ; index++) {
      if (position === size) {
        if (o.allowTruncated) return
        throw new BlobIntegrityError('audio file is incomplete')
      }
      const lead = await readExactly(h, FRAME_LEAD, position)
      const ctLength = lead.length === FRAME_LEAD ? lead.readUInt32LE(NONCE_BYTES) : 0
      if (ctLength > maxFrame) throw new BlobIntegrityError('frame is larger than the header allows')
      const total = FRAME_LEAD + ctLength + TAG_BYTES
      if (lead.length < FRAME_LEAD || position + total > size) {
        if (o.allowTruncated) return
        throw new BlobIntegrityError('audio file is truncated')
      }
      const body = await readExactly(h, ctLength + TAG_BYTES, position + FRAME_LEAD)
      const nonce = lead.subarray(0, NONCE_BYTES)
      const ciphertext = body.subarray(0, ctLength)
      const tag = body.subarray(ctLength)
      position += total
      const atEnd = position === size
      // Only a frame followed by the end of the file may carry the last flag.
      let plain = atEnd ? unseal(nonce, ciphertext, tag, o.key, frameAad(id, index, true)) : null
      if (plain) {
        yield plain
        return
      }
      plain = unseal(nonce, ciphertext, tag, o.key, frameAad(id, index, false))
      if (!plain) throw new BlobIntegrityError(`frame ${index} failed authentication`)
      yield plain
    }
  } finally {
    await h.close()
  }
}

/** The plaintext PCM, frame by frame. Throws BlobIntegrityError. */
export function readFramed(o: FramedOptions & { allowTruncated: boolean }): AsyncGenerator<Buffer> {
  return frames(o)
}

/** Writes a 16-bit PCM RIFF/WAVE file (never overwriting one). Resolves with its size in bytes. */
export async function framedToWav(o: FramedOptions & { allowTruncated: boolean }, outPath: string): Promise<{ bytes: number }> {
  let format: FramedHeader = { sampleRate: SAMPLE_RATE, channels: CHANNELS }
  const out = await open(outPath, 'wx')
  let dataBytes = 0
  let ok = false
  try {
    await out.write(Buffer.alloc(44), 0, 44, 0)
    for await (const pcm of frames(o, (h) => (format = h))) {
      await out.write(pcm, 0, pcm.length, 44 + dataBytes)
      dataBytes += pcm.length
      if (dataBytes > 0xffffffff - 36) throw new Error('recording is too long for a WAV file')
    }
    const header = Buffer.alloc(44)
    header.write('RIFF', 0, 'ascii')
    header.writeUInt32LE(36 + dataBytes, 4)
    header.write('WAVE', 8, 'ascii')
    header.write('fmt ', 12, 'ascii')
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(format.channels, 22)
    header.writeUInt32LE(format.sampleRate, 24)
    header.writeUInt32LE(format.sampleRate * format.channels * 2, 28)
    header.writeUInt16LE(format.channels * 2, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36, 'ascii')
    header.writeUInt32LE(dataBytes, 40)
    await out.write(header, 0, 44, 0)
    ok = true
  } finally {
    await out.close()
    if (!ok) await unlink(outPath).catch(() => undefined)
  }
  return { bytes: 44 + dataBytes }
}
