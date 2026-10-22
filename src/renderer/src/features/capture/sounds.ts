// SPDX-License-Identifier: Apache-2.0
// Start, resume and pause tones, synthesized with WebAudio: no asset files,
// off by default (`capture.sounds`). A playback failure is logged and ignored.

type Tone = { freq: number; at: number; dur: number }

const START: Tone[] = [
  { freq: 660, at: 0, dur: 0.09 },
  { freq: 880, at: 0.1, dur: 0.12 }
]
const RESUME: Tone[] = [{ freq: 880, at: 0, dur: 0.12 }]
const PAUSE: Tone[] = [
  { freq: 880, at: 0, dur: 0.09 },
  { freq: 587, at: 0.1, dur: 0.14 }
]

let ctx: AudioContext | null = null

function play(tones: Tone[]): void {
  try {
    ctx ??= new AudioContext()
    const c = ctx
    if (c.state === 'suspended') void c.resume()
    const t0 = c.currentTime + 0.02
    for (const t of tones) {
      const osc = c.createOscillator()
      const gain = c.createGain()
      osc.type = 'sine'
      osc.frequency.value = t.freq
      gain.gain.setValueAtTime(0, t0 + t.at)
      gain.gain.linearRampToValueAtTime(0.12, t0 + t.at + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + t.at + t.dur)
      osc.connect(gain).connect(c.destination)
      osc.start(t0 + t.at)
      osc.stop(t0 + t.at + t.dur + 0.02)
    }
  } catch (err) {
    window.notula.capture.sendEvent({
      type: 'log',
      level: 'warn',
      event: 'sound-failed',
      data: { message: err instanceof Error ? err.message : String(err) }
    })
  }
}

export const sounds = {
  start: () => play(START),
  resume: () => play(RESUME),
  pause: () => play(PAUSE)
}
