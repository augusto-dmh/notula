// SPDX-License-Identifier: Apache-2.0
// The voice generation: one in-memory counter, bumped by every change
// that can make a computed voice decision wrong. The job and relabel read it before computing;
// their queued writes carry it, and a write whose generation moved is recomputed or dropped.

import { log } from '../log'

/** What bumped it. Logged as a code, never with any voice data. */
export type VoiceGenReason =
  | 'forget'
  | 'forget-all'
  | 'expiry'
  | 'remove-sample'
  | 'merge'
  | 'voices-off'
  | 'self-voice-off'
  | 'auto-recognize-off'

export interface VoiceGeneration {
  current(): number
  /** Returns the new generation. */
  bump(reason: VoiceGenReason): number
}

let generation = 0

const counter: VoiceGeneration = {
  current: () => generation,
  bump: (reason) => {
    generation += 1
    log('info', 'speakers:voice-generation', { generation, reason })
    return generation
  }
}

export function voiceGeneration(): VoiceGeneration {
  return counter
}
