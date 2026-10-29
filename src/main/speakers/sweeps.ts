// SPDX-License-Identifier: Apache-2.0
// The speaker-profile sweeps: once when storage is ready, then every
// 24 h. Cluster vectors past their 14 days (and any of another model) are secure-deleted, and
// the voice of everyone not recognized in a meeting for 365 days is forgotten, its agreement
// record stamped `expired`. With Recognize voices off, every cluster vector goes (the backstop
// for a write that raced the switch). Logged as counts.

import { SPEAKER_PROFILE_LIMITS } from '@shared/types/speakers'
import { speakerIdModelId } from '../asr/manifest'
import type { MainContext } from '../context'
import { log } from '../log'
import { pushSpeakerPeopleChanged, withVoiceBump } from './people-ipc'

/**
 * One run; never throws (storage may be in recovery). Whether a voice expires is only known
 * inside the call, so every run bumps the generation on both sides of it.
 */
export async function runSpeakerSweep(ctx: MainContext): Promise<void> {
  try {
    const r = await withVoiceBump('expiry', () => ctx.storage.sweepSpeakerData({ now: new Date().toISOString(), modelId: speakerIdModelId() }))
    for (const personId of r.peopleExpired) pushSpeakerPeopleChanged(ctx, personId)
    log('info', 'speakers:sweep', { clusterVectors: r.clusterVectors, peopleExpired: r.peopleExpired.length })
  } catch (err) {
    log('warn', 'speakers:sweep-failed', { err: err instanceof Error ? err.message : String(err) })
  }
}

/** At every `ready` (storage start, a recovery that reopened) and every 24 h while the app runs. */
export function startSpeakerSweeps(ctx: MainContext): void {
  // Storage opens before the modules register: the first run is read from its status.
  void ctx.storage.status().then((s) => {
    if (s.state === 'ready') void runSpeakerSweep(ctx)
  })
  ctx.bus.on('storage:status', (s) => {
    if (s.state === 'ready') void runSpeakerSweep(ctx)
  })
  setInterval(() => void runSpeakerSweep(ctx), SPEAKER_PROFILE_LIMITS.sweepEveryMs).unref()
}
