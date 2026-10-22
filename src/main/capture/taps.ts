// SPDX-License-Identifier: Apache-2.0
// Audio taps. The voiceprint tap is the only user so far. Capture's batch sink calls every
// tap synchronously with each 16 kHz s16le mono batch,
// beside `transcription.feed`. A tap must only buffer; one that throws is logged and skipped.

import type { AudioTap, AudioTapsApi } from '../context'
import { log } from '../log'

const taps = new Set<AudioTap>()
let failures = 0

/** `ctx.audioTaps`. */
export const audioTaps: AudioTapsApi = {
  register(tap) {
    taps.add(tap)
    return () => {
      taps.delete(tap)
    }
  }
}

/** Capture's batch sink only. */
export function emitAudioTaps(f: Parameters<AudioTap>[0]): void {
  for (const tap of taps) {
    try {
      tap(f)
    } catch (err) {
      // At most a few lines: a broken tap would otherwise log every 100 ms.
      if (failures++ < 5) log('error', 'capture:audio-tap-failed', { err })
    }
  }
}
