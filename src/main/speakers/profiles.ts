// SPDX-License-Identifier: Apache-2.0
// registerSpeakerProfiles(): speaker profiles, wired once from
// src/main/index.ts. Each part registers itself; their order here is fixed.

import { app } from 'electron'
import type { MainContext } from '../context'
import { registerSpeakerJob } from './job'
import { registerSpeakerNotice } from './notice'
import { registerSpeakerPeople } from './people-ipc'
import { registerSpeakerStatus } from './status'
import { registerVoiceLifecycle } from './voice-lifecycle'

export function registerSpeakerProfiles(ctx: MainContext): void {
  registerSpeakerPeople(ctx)
  registerVoiceLifecycle(ctx)
  registerSpeakerJob(ctx)
  registerSpeakerNotice(ctx)
  registerSpeakerStatus(ctx)
  // The bench feed, dev builds only. Loaded on demand so the main bundle doesn't carry it, and a
  // release build (`--mode release`) folds the test to false, so the feed isn't bundled at all.
  if (import.meta.env.MODE !== 'release' && !app.isPackaged && process.env['NOTULA_DEV_SPEAKER_BENCH'] === '1') {
    void import('./bench-feed').then((m) => m.maybeRunSpeakerBench(ctx))
  }
}
