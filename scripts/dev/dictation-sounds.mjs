// SPDX-License-Identifier: Apache-2.0
// Dev-only: synthesizes the voice typing sounds (short sine tones with soft envelopes) into the
// given folder. Run: node scripts/dev/dictation-sounds.mjs src/renderer/src/features/dictation/sounds
import { writeFileSync, mkdirSync } from 'node:fs'
const RATE = 22050
function wav(samples) {
  const data = Buffer.alloc(samples.length * 2)
  samples.forEach((v, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2))
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24)
  h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}
// One note: frequency glide f0→f1 over ms, attack 6 ms, exponential decay.
function note(f0, f1, ms, gain = 0.32) {
  const n = Math.round((RATE * ms) / 1000)
  const out = new Float32Array(n)
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / n
    const f = f0 + (f1 - f0) * t
    phase += (2 * Math.PI * f) / RATE
    const env = Math.min(1, i / (RATE * 0.006)) * Math.exp(-4 * t) * (1 - t) ** 0.5
    out[i] = gain * env * (Math.sin(phase) + 0.18 * Math.sin(2 * phase))
  }
  return out
}
const gap = (ms) => new Float32Array(Math.round((RATE * ms) / 1000))
const join = (...parts) => { const n = parts.reduce((a, p) => a + p.length, 0); const o = new Float32Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length } return o }
const dir = process.argv[2]
mkdirSync(dir, { recursive: true })
writeFileSync(`${dir}/start.wav`, wav(note(620, 830, 130)))
writeFileSync(`${dir}/lock.wav`, wav(join(note(830, 830, 70, 0.28), gap(25), note(1110, 1110, 90, 0.28))))
writeFileSync(`${dir}/finish.wav`, wav(note(830, 560, 150)))
writeFileSync(`${dir}/notice.wav`, wav(join(note(470, 470, 90, 0.26), gap(40), note(470, 440, 110, 0.22))))
