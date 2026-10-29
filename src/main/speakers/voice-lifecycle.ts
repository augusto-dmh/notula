// SPDX-License-Identifier: Apache-2.0
// The voice data's lifecycle: the deletions when a voice
// switch is turned off, the sweeps at startup and every 24 h (14 days for cluster vectors,
// 365 days for voices), `ensureSelfPerson`, and the first-start legacy self conversion.
//
// - Recognize voices off: every cluster vector goes at once (they are all unnamed), with the voice
//   generation bumped on both sides. Storage refuses new cluster vectors while the switch is off,
//   and the sweep deletes any left over. Forgetting other people's voices is the renderer's
//   follow-up question, answered through `speakers:forget-all {keepSelf}`.
// - Recognize my voice off: the generation moves; "Also forget your voice?" is answered through
//   `speaker-people:forget-voice` on the self person.

import { MODEL_MANIFEST, speakerIdModelId } from '../asr/manifest'
import type { MainContext } from '../context'
import { log } from '../log'
import { pushSpeakerPeopleChanged, withVoiceBump } from './people-ipc'
import { startSpeakerSweeps } from './sweeps'
import { voiceGeneration } from './voice-gen'

/**
 * The ResNet-34 file's SHA when the shipped extractor is that same file (the alias): the
 * Labs self voice then carries over. Null otherwise.
 */
function legacyAliasModelId(): string | null {
  return MODEL_MANIFEST['speaker-id'].alias?.path === 'wespeaker_en_voxceleb_resnet34.onnx' ? speakerIdModelId() : null
}

async function onStorageReady(ctx: MainContext): Promise<void> {
  try {
    await ctx.storage.ensureSelfPerson(await ctx.settings.get('profile.name'))
    // A no-op once the legacy table is empty (it ends empty and is never written again).
    const legacy = await ctx.storage.convertLegacyVoiceprints({ aliasModelId: legacyAliasModelId() })
    if (legacy.deleted) {
      log('info', 'speakers:legacy-self-voice', { converted: legacy.converted, deleted: legacy.deleted })
      pushSpeakerPeopleChanged(ctx)
    }
  } catch (err) {
    log('warn', 'speakers:lifecycle-start-failed', { err: err instanceof Error ? err.message : String(err) })
  }
}

export function registerVoiceLifecycle(ctx: MainContext): void {
  // Storage opens before the modules register: the first start is read from its status.
  void ctx.storage.status().then((s) => {
    if (s.state === 'ready') void onStorageReady(ctx)
  })
  ctx.bus.on('storage:status', (s) => {
    if (s.state === 'ready') void onStorageReady(ctx)
  })

  ctx.bus.on('settings:changed', (e) => {
    if (e.keys.includes('profile.name')) {
      void ctx.storage.ensureSelfPerson(e.settings['profile.name']).catch((err: unknown) =>
        log('warn', 'speakers:self-name-failed', { err: err instanceof Error ? err.message : String(err) })
      )
    }
    if (e.keys.includes('speakers.voices') && !e.settings['speakers.voices']) {
      void withVoiceBump('voices-off', () => ctx.storage.deleteSpeakerClusterVectors({ all: true }))
        .then((n) => log('info', 'speakers:voices-off', { clusterVectors: n }))
        .catch((err: unknown) => log('warn', 'speakers:voices-off-failed', { err: err instanceof Error ? err.message : String(err) }))
    }
    if (e.keys.includes('speakers.selfVoice') && !e.settings['speakers.selfVoice']) voiceGeneration().bump('self-voice-off')
  })

  startSpeakerSweeps(ctx)
}
