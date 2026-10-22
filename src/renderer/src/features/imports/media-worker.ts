// SPDX-License-Identifier: Apache-2.0
// The #/media-worker decoder. A hidden, sandboxed
// window: it receives an imported file's bytes from main over a MessagePort and returns 16 kHz
// mono s16le PCM in 1 s batches. Nothing is written, fetched or kept.
//
// - MP3 frames and ADTS AAC are parsed here and decoded with WebCodecs `AudioDecoder` (Chromium's
//   built-in `mp3` and `mp4a.40.x` codecs); M4A is demuxed by mp4box; WAV is parsed directly.
// - The file streams in pieces; the decoder queue and the un-acknowledged batches are bounded, so
//   memory stays far below 256 MB whatever the file size. Main acknowledges a batch once the engine
//   is less than 30 s behind.
// - Down-mixed to mono, low-pass filtered and resampled to 16 kHz.
// - A codec WebCodecs lacks is reported as `unsupported` (main may take the cloud path); anything
//   else unreadable as `decode` ("Notula could not read this audio file.").

import { createFile, MP4BoxBuffer, type ISOFile, type Movie, type Sample } from 'mp4box'
import type { MainToMedia, MediaFormat, MediaToMain } from './media-protocol'

const TARGET_RATE = 16_000
const BATCH_SAMPLES = 16_000
/** Batches decoded ahead of main's acknowledgements. */
const WINDOW = 4
const MAX_DECODE_QUEUE = 24

class DecodeError extends Error {
  constructor(
    readonly code: 'unsupported' | 'decode',
    message: string
  ) {
    super(message)
  }
}

// ---------- resampling ----------

/** Streaming low-pass (31-tap windowed sinc) and linear resampling to 16 kHz. */
class Resampler {
  private readonly taps: Float32Array
  private history: Float32Array
  private buf: number[] = []
  private pos = 0
  private readonly step: number

  constructor(private readonly rate: number) {
    this.step = rate / TARGET_RATE
    const n = 31
    const fc = Math.min(0.5, (0.45 * TARGET_RATE) / rate)
    const taps = new Float32Array(n)
    let sum = 0
    for (let i = 0; i < n; i++) {
      const m = i - (n - 1) / 2
      const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m)
      const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1))
      taps[i] = sinc * w
      sum += taps[i] as number
    }
    for (let i = 0; i < n; i++) taps[i] = (taps[i] as number) / sum
    this.taps = taps
    this.history = new Float32Array(n - 1)
  }

  push(input: Float32Array): Float32Array {
    if (this.rate === TARGET_RATE) return input
    const n = this.taps.length
    const all = new Float32Array(this.history.length + input.length)
    all.set(this.history)
    all.set(input, this.history.length)
    for (let i = 0; i + n <= all.length; i++) {
      let acc = 0
      for (let k = 0; k < n; k++) acc += (all[i + k] as number) * (this.taps[k] as number)
      this.buf.push(acc)
    }
    this.history = all.slice(all.length - (n - 1))
    const out: number[] = []
    while (this.pos + 1 < this.buf.length) {
      const i = Math.floor(this.pos)
      const f = this.pos - i
      out.push((this.buf[i] as number) * (1 - f) + (this.buf[i + 1] as number) * f)
      this.pos += this.step
    }
    const used = Math.floor(this.pos)
    if (used > 0) {
      this.buf = this.buf.slice(used)
      this.pos -= used
    }
    return Float32Array.from(out)
  }
}

// ---------- demuxers ----------

interface Sink {
  configure(config: AudioDecoderConfig): Promise<void>
  chunk(c: EncodedAudioChunk): void
  pcm(mono: Float32Array, rate: number): void
}

interface Demuxer {
  /** Bytes at `offset`; `eof` with the file's last piece. */
  push(bytes: Uint8Array, offset: number, eof: boolean): Promise<void>
  /** The next file offset needed, or null when nothing more is. */
  next(): number | null
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.length) return b
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

/** Skips an ID3v2 tag at the start of MP3 and AAC files. */
function id3Length(b: Uint8Array): number | null {
  if (b.length < 10) return null
  if (b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0
  const size = (((b[6] as number) & 0x7f) << 21) | (((b[7] as number) & 0x7f) << 14) | (((b[8] as number) & 0x7f) << 7) | ((b[9] as number) & 0x7f)
  return 10 + size + (((b[5] as number) & 0x10) !== 0 ? 10 : 0)
}

const MP3_BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
const MP3_BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
const MP3_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }

/** Sequential frame parsing for MP3 (Layer III) and ADTS AAC. */
class FrameDemuxer implements Demuxer {
  private rest: Uint8Array = new Uint8Array(0)
  private offset = 0
  private skip: number | null = null
  private configured = false
  private samples = 0
  private rate = 0
  private done = false

  constructor(
    private readonly kind: 'mp3' | 'aac',
    private readonly sink: Sink
  ) {}

  next(): number | null {
    return this.done ? null : this.offset
  }

  async push(bytes: Uint8Array, offset: number, eof: boolean): Promise<void> {
    this.offset = offset + bytes.length
    let b = concat(this.rest, bytes)
    if (this.skip === null) {
      const len = id3Length(b)
      if (len === null && !eof) {
        this.rest = b
        return
      }
      this.skip = len ?? 0
    }
    if (this.skip > 0) {
      const n = Math.min(this.skip, b.length)
      b = b.subarray(n)
      this.skip -= n
    }
    let i = 0
    while (i + 10 <= b.length) {
      const f = this.kind === 'mp3' ? this.mp3Frame(b, i) : this.adtsFrame(b, i)
      if (!f) {
        i++
        continue
      }
      if (i + f.length > b.length) break
      if (!this.configured) {
        this.configured = true
        this.rate = f.config.sampleRate
        await this.sink.configure(f.config)
      }
      const data = b.slice(i + f.header, i + f.length)
      this.sink.chunk(new EncodedAudioChunk({ type: 'key', timestamp: Math.round((this.samples * 1e6) / this.rate), data }))
      this.samples += f.samples
      i += f.length
    }
    this.rest = b.slice(i)
    if (eof) {
      this.done = true
      if (!this.configured) throw new DecodeError('decode', this.kind === 'mp3' ? 'no MP3 frames found' : 'no ADTS frames found')
    }
  }

  private mp3Frame(b: Uint8Array, i: number): { length: number; header: number; samples: number; config: AudioDecoderConfig } | null {
    const b0 = b[i] as number
    const b1 = b[i + 1] as number
    const b2 = b[i + 2] as number
    const b3 = b[i + 3] as number
    if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null
    const version = (b1 >> 3) & 3
    const layer = (b1 >> 1) & 3
    if (version === 1 || layer !== 1) return null
    const br = (version === 3 ? MP3_BITRATES_V1 : MP3_BITRATES_V2)[b2 >> 4] ?? 0
    const sr = MP3_RATES[version]?.[(b2 >> 2) & 3]
    if (!br || !sr) return null
    const pad = (b2 >> 1) & 1
    const length = version === 3 ? Math.floor((144_000 * br) / sr) + pad : Math.floor((72_000 * br) / sr) + pad
    if (length < 24) return null
    const channels = b3 >> 6 === 3 ? 1 : 2
    return { length, header: 0, samples: version === 3 ? 1152 : 576, config: { codec: 'mp3', sampleRate: sr, numberOfChannels: channels } }
  }

  private adtsFrame(b: Uint8Array, i: number): { length: number; header: number; samples: number; config: AudioDecoderConfig } | null {
    const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]
    const b1 = b[i + 1] as number
    const b2 = b[i + 2] as number
    const b3 = b[i + 3] as number
    if (b[i] !== 0xff || (b1 & 0xf6) !== 0xf0) return null
    const header = (b1 & 1) === 1 ? 7 : 9
    const objectType = ((b2 >> 6) & 3) + 1
    const srIndex = (b2 >> 2) & 0xf
    const channels = ((b2 & 1) << 2) | (b3 >> 6)
    const length = ((b3 & 3) << 11) | ((b[i + 4] as number) << 3) | ((b[i + 5] as number) >> 5)
    const sr = AAC_RATES[srIndex]
    if (!sr || length <= header) return null
    const asc = new Uint8Array([(objectType << 3) | (srIndex >> 1), ((srIndex & 1) << 7) | ((channels || 2) << 3)])
    return {
      length,
      header,
      samples: 1024,
      config: { codec: `mp4a.40.${objectType}`, sampleRate: sr, numberOfChannels: channels || 2, description: asc }
    }
  }
}

/** RIFF/WAVE: PCM 8/16/24/32-bit integer or 32-bit float, any channel count. */
class WavDemuxer implements Demuxer {
  private rest: Uint8Array = new Uint8Array(0)
  private offset = 0
  private format: { tag: number; channels: number; rate: number; bits: number } | null = null
  private dataLeft: number | null = null
  private done = false

  constructor(private readonly sink: Sink) {}

  next(): number | null {
    return this.done ? null : this.offset
  }

  async push(bytes: Uint8Array, offset: number, eof: boolean): Promise<void> {
    this.offset = offset + bytes.length
    let b = concat(this.rest, bytes)
    let i = 0
    if (offset === 0 && this.rest.length === 0) {
      if (b.length < 12) {
        if (eof) throw new DecodeError('decode', 'not a WAV file')
        this.rest = b
        return
      }
      const tag = String.fromCharCode(...b.subarray(0, 4)) + String.fromCharCode(...b.subarray(8, 12))
      if (tag !== 'RIFFWAVE') throw new DecodeError('decode', 'not a RIFF/WAVE file')
      i = 12
    }
    const view = (): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength)
    while (i < b.length) {
      if (this.dataLeft !== null && this.format) {
        const frame = this.format.channels * (this.format.bits / 8)
        const avail = Math.min(b.length - i, this.dataLeft)
        const usable = avail - (avail % frame)
        if (usable <= 0) break
        this.pcm(b.subarray(i, i + usable))
        i += usable
        this.dataLeft -= usable
        if (this.dataLeft <= 0) this.dataLeft = null
        continue
      }
      if (i + 8 > b.length) break
      const id = String.fromCharCode(...b.subarray(i, i + 4))
      const size = view().getUint32(i + 4, true)
      if (id === 'data') {
        if (!this.format) throw new DecodeError('decode', 'WAV data before its format')
        i += 8
        // A streaming writer may leave the size at 0 or 0xFFFFFFFF: read to the end.
        this.dataLeft = size === 0 || size === 0xffffffff ? Number.MAX_SAFE_INTEGER : size
        continue
      }
      if (i + 8 + size > b.length) break
      if (id === 'fmt ') {
        const v = view()
        let tag = v.getUint16(i + 8, true)
        const channels = v.getUint16(i + 10, true)
        const rate = v.getUint32(i + 12, true)
        const bits = v.getUint16(i + 22, true)
        if (tag === 0xfffe && size >= 40) tag = v.getUint16(i + 32, true)
        if (!(tag === 1 && [8, 16, 24, 32].includes(bits)) && !(tag === 3 && bits === 32)) {
          throw new DecodeError('unsupported', `WAV format ${tag}/${bits}-bit is not supported`)
        }
        if (!channels || !rate) throw new DecodeError('decode', 'invalid WAV format')
        this.format = { tag, channels, rate, bits }
      }
      i += 8 + size + (size % 2)
    }
    this.rest = b.slice(i)
    if (eof) {
      this.done = true
      if (!this.format) throw new DecodeError('decode', 'no WAV format chunk')
    }
  }

  private pcm(bytes: Uint8Array): void {
    const f = this.format as { tag: number; channels: number; rate: number; bits: number }
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const width = f.bits / 8
    const frames = bytes.length / (width * f.channels)
    const mono = new Float32Array(frames)
    for (let n = 0; n < frames; n++) {
      let sum = 0
      for (let c = 0; c < f.channels; c++) {
        const at = (n * f.channels + c) * width
        let s: number
        if (f.tag === 3) s = v.getFloat32(at, true)
        else if (f.bits === 16) s = v.getInt16(at, true) / 32768
        else if (f.bits === 8) s = ((v.getUint8(at) as number) - 128) / 128
        else if (f.bits === 24) {
          const x = (v.getUint8(at) | (v.getUint8(at + 1) << 8) | (v.getInt8(at + 2) << 16)) as number
          s = x / 8388608
        } else s = v.getInt32(at, true) / 2147483648
        sum += s
      }
      mono[n] = sum / f.channels
    }
    this.sink.pcm(mono, f.rate)
  }
}

/** M4A / MP4 audio through mp4box; it asks for the byte ranges it needs (moov may come last). */
class Mp4Demuxer implements Demuxer {
  private readonly file: ISOFile
  private nextOffset: number | null = 0
  private started = false
  private trackId = -1
  private configurePromise: Promise<void> | null = null
  private failure: DecodeError | null = null
  private ended = false

  constructor(private readonly sink: Sink) {
    this.file = createFile()
    this.file.onError = (_m: string, message: string) => {
      this.failure = new DecodeError('decode', message)
    }
    this.file.onReady = (info: Movie) => this.onReady(info)
    this.file.onSamples = (id: number, _user: unknown, samples: Sample[]) => {
      for (const s of samples) {
        if (!s.data) continue
        this.sink.chunk(
          new EncodedAudioChunk({
            type: 'key',
            timestamp: Math.round((s.cts * 1e6) / s.timescale),
            duration: Math.round((s.duration * 1e6) / s.timescale),
            data: s.data
          })
        )
      }
      const last = samples[samples.length - 1]
      if (last) this.file.releaseUsedSamples(id, last.number + 1)
    }
  }

  private onReady(info: Movie): void {
    const track = info.audioTracks[0]
    if (!track?.audio) {
      this.failure = new DecodeError('decode', 'no audio track')
      return
    }
    this.trackId = track.id
    let description: Uint8Array | undefined
    try {
      const entry = this.file.getTrackById(track.id).mdia.minf.stbl.stsd.entries[0] as unknown as { esds?: { esd?: { findDescriptor(t: number): { findDescriptor(t: number): { data: Uint8Array } | undefined } | undefined } } }
      description = entry.esds?.esd?.findDescriptor(4)?.findDescriptor(5)?.data
    } catch {
      description = undefined
    }
    this.configurePromise = this.sink.configure({
      codec: track.codec.startsWith('mp4a') ? track.codec : track.codec,
      sampleRate: track.audio.sample_rate,
      numberOfChannels: track.audio.channel_count,
      ...(description ? { description } : {})
    })
    this.file.setExtractionOptions(track.id, null, { nbSamples: 64 })
  }

  next(): number | null {
    return this.ended ? null : this.nextOffset
  }

  async push(bytes: Uint8Array, offset: number, eof: boolean): Promise<void> {
    const ab = MP4BoxBuffer.fromArrayBuffer(bytes.slice().buffer, offset)
    const next = this.file.appendBuffer(ab, eof)
    if (this.failure) throw this.failure
    if (this.configurePromise && !this.started) {
      await this.configurePromise
      this.started = true
      this.file.start()
      // After the movie box, extraction starts again from the first sample's data.
      const seek = this.file.seek(0, true)
      this.nextOffset = seek.offset
      return
    }
    if (eof && this.started) {
      this.file.flush()
      this.ended = true
      return
    }
    if (eof && !this.started) throw new DecodeError('decode', 'no movie box found')
    this.nextOffset = typeof next === 'number' && next > offset ? next : offset + bytes.length
  }

  get track(): number {
    return this.trackId
  }
}

// ---------- one job ----------

class Job {
  private seq = 0
  private unacked = 0
  private waiting = false
  private eofSeen = false
  private finished = false
  private decoder: AudioDecoder | null = null
  private resampler: Resampler | null = null
  private batch = new Float32Array(BATCH_SAMPLES)
  private fill = 0
  private outSamples = 0
  private readonly demux: Demuxer
  private error: DecodeError | null = null
  private readonly outbox: Uint8Array[] = []
  /** Decoding is over; `done` goes once the outbox is empty. */
  private draining = false

  constructor(
    readonly id: string,
    format: MediaFormat,
    private readonly total: number,
    private readonly send: (m: MediaToMain) => void
  ) {
    const sink: Sink = {
      configure: (c) => this.configure(c),
      chunk: (c) => {
        try {
          this.decoder?.decode(c)
        } catch (err) {
          this.fail(new DecodeError('decode', err instanceof Error ? err.message : String(err)))
        }
      },
      pcm: (mono, rate) => this.pcm(mono, rate)
    }
    this.demux = format === 'wav' ? new WavDemuxer(sink) : format === 'm4a' ? new Mp4Demuxer(sink) : new FrameDemuxer(format, sink)
  }

  private async configure(config: AudioDecoderConfig): Promise<void> {
    let supported = false
    try {
      supported = (await AudioDecoder.isConfigSupported(config)).supported === true
    } catch {
      supported = false
    }
    if (!supported) throw new DecodeError('unsupported', `this computer cannot decode ${config.codec}`)
    this.decoder = new AudioDecoder({
      output: (data) => this.output(data),
      error: (e) => this.fail(new DecodeError('decode', e.message))
    })
    this.decoder.addEventListener('dequeue', () => this.maybeWant())
    this.decoder.configure(config)
  }

  private output(data: AudioData): void {
    try {
      const frames = data.numberOfFrames
      const channels = data.numberOfChannels
      const mono = new Float32Array(frames)
      const plane = new Float32Array(frames)
      for (let c = 0; c < channels; c++) {
        data.copyTo(plane, { planeIndex: c, format: 'f32-planar' })
        for (let i = 0; i < frames; i++) mono[i] = (mono[i] as number) + (plane[i] as number) / channels
      }
      this.pcm(mono, data.sampleRate)
    } finally {
      data.close()
    }
  }

  private pcm(mono: Float32Array, rate: number): void {
    if (this.finished) return
    this.resampler ??= new Resampler(rate)
    const out = this.resampler.push(mono)
    let i = 0
    while (i < out.length) {
      const n = Math.min(out.length - i, BATCH_SAMPLES - this.fill)
      this.batch.set(out.subarray(i, i + n), this.fill)
      this.fill += n
      i += n
      if (this.fill === BATCH_SAMPLES) this.emit()
    }
  }

  private emit(): void {
    if (!this.fill) return
    const pcm = new Uint8Array(this.fill * 2)
    const v = new DataView(pcm.buffer)
    for (let i = 0; i < this.fill; i++) {
      const s = Math.max(-1, Math.min(1, this.batch[i] as number))
      v.setInt16(i * 2, Math.round(s * 32767), true)
    }
    this.outSamples += this.fill
    this.fill = 0
    // Batches leave only inside the window; the rest wait here for main's acknowledgements.
    this.outbox.push(pcm)
    this.flushOutbox()
  }

  private flushOutbox(): void {
    while (this.outbox.length && this.unacked < WINDOW) {
      this.unacked++
      this.send({ type: 'pcm', jobId: this.id, seq: this.seq++, pcm: this.outbox.shift() as Uint8Array })
    }
    if (this.draining && !this.outbox.length) {
      this.draining = false
      this.send({ type: 'done', jobId: this.id, ms: Math.round((this.outSamples * 1000) / TARGET_RATE) })
    }
  }

  start(): void {
    this.maybeWant()
  }

  ack(): void {
    this.unacked = Math.max(0, this.unacked - 1)
    this.flushOutbox()
    this.maybeWant()
  }

  private maybeWant(): void {
    if (this.finished || this.waiting || this.eofSeen || this.error) return
    // More file only once the decoded audio has gone out (memory stays bounded by one piece).
    if (this.outbox.length || this.unacked >= WINDOW || (this.decoder?.decodeQueueSize ?? 0) >= MAX_DECODE_QUEUE) return
    const offset = this.demux.next()
    if (offset === null || offset >= this.total) return
    this.waiting = true
    this.send({ type: 'want', jobId: this.id, offset })
  }

  async data(offset: number, bytes: Uint8Array, eof: boolean): Promise<void> {
    this.waiting = false
    if (this.finished) return
    try {
      await this.demux.push(bytes, offset, eof)
      const next = this.demux.next()
      if (next === null || (eof && next >= this.total)) {
        this.eofSeen = true
        await this.finish()
        return
      }
      this.maybeWant()
    } catch (err) {
      this.fail(err instanceof DecodeError ? err : new DecodeError('decode', err instanceof Error ? err.message : String(err)))
    }
  }

  private async finish(): Promise<void> {
    try {
      if (this.decoder && this.decoder.state === 'configured') await this.decoder.flush()
    } catch (err) {
      this.fail(new DecodeError('decode', err instanceof Error ? err.message : String(err)))
      return
    }
    if (this.error) return
    // The last partial batch; `done` follows once every batch has gone out.
    this.emit()
    this.finished = true
    this.close()
    if (this.outSamples === 0) {
      this.send({ type: 'error', jobId: this.id, code: 'decode', message: 'no audio was decoded' })
      return
    }
    this.draining = true
    this.flushOutbox()
  }

  fail(err: DecodeError): void {
    if (this.finished) return
    this.finished = true
    this.error = err
    this.close()
    this.send({ type: 'error', jobId: this.id, code: err.code, message: err.message })
  }

  close(): void {
    try {
      if (this.decoder && this.decoder.state !== 'closed') this.decoder.close()
    } catch {
      // Already closed.
    }
  }
}

// ---------- the port ----------

let port: MessagePort | null = null
const jobs = new Map<string, Job>()

function send(m: MediaToMain): void {
  // Copied, not transferred: the main-process port end carries only ports as transferables.
  port?.postMessage(m)
}

function onMessage(m: MainToMedia): void {
  if (!m || typeof m !== 'object') return
  switch (m.type) {
    case 'start': {
      jobs.get(m.jobId)?.fail(new DecodeError('decode', 'restarted'))
      const job = new Job(m.jobId, m.format, m.totalBytes, (out) => {
        if (out.type === 'done' || out.type === 'error') jobs.delete(m.jobId)
        send(out)
      })
      jobs.set(m.jobId, job)
      job.start()
      return
    }
    case 'data':
      void jobs.get(m.jobId)?.data(m.offset, m.bytes, m.eof)
      return
    case 'ack':
      jobs.get(m.jobId)?.ack()
      return
    case 'cancel': {
      const job = jobs.get(m.jobId)
      jobs.delete(m.jobId)
      job?.close()
      return
    }
  }
}

/** Starts listening for the port main transfers (`imports:media-port`; the preload forwards it). */
export function startMediaWorker(): () => void {
  const onWindowMessage = (e: MessageEvent): void => {
    if ((e.data as { type?: unknown } | null)?.type !== 'notula:media-port' || !e.ports[0]) return
    port?.close()
    port = e.ports[0]
    port.onmessage = (ev) => onMessage(ev.data as MainToMedia)
    port.postMessage({ type: 'hello' } satisfies MediaToMain)
  }
  window.addEventListener('message', onWindowMessage)
  return () => window.removeEventListener('message', onWindowMessage)
}
