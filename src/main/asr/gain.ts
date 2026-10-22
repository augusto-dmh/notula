// SPDX-License-Identifier: Apache-2.0
// Gain normalization before a local decode. Pure, like vad.ts, so
// scripts/dev/vad-check.ts can run it.
//
// Quiet but clean audio (system audio played at peak 0.007, measured) passes the adaptive
// gate, but the models are trained on speech at normal levels. Each segment or partial is
// scaled so its peak reaches 0.5, with the gain capped at ×100. Audio already at or above
// that peak is left as is (never attenuated), and exact-zero audio is never scaled.

export const TARGET_PEAK = 0.5
export const MAX_GAIN = 100

/** The samples to decode and the gain applied (1 = the input itself, unchanged). */
export function normalizeGain(samples: Float32Array): { samples: Float32Array; gain: number } {
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i] as number)
    if (v > peak) peak = v
  }
  if (peak === 0) return { samples, gain: 1 }
  const gain = Math.min(MAX_GAIN, TARGET_PEAK / peak)
  if (gain <= 1) return { samples, gain: 1 }
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) out[i] = (samples[i] as number) * gain
  return { samples: out, gain }
}
