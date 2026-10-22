// SPDX-License-Identifier: Apache-2.0
// The release channel: `update:set-channel`.
//
// `updates.channel` (main-only) changes only here. `beta` is refused with
// `no-beta-feed` when the build has no beta feed URL, and with `no-feed` when the build checks
// no feed at all (dev builds, unsigned macOS builds). `stable` is always accepted. The updater
// follows the setting: it re-points electron-updater, drops a downloaded update from the
// other channel and checks at once. While "Nothing leaves this machine" is on the choice is
// still saved, and takes effect when checks resume. The channel is never reported.

import { ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes } from '@shared/ipc'
import type { UpdateChannel } from '@shared/types/app'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { getUpdateState } from '../updater/state'

export function channelRefusal(channel: UpdateChannel): 'no-beta-feed' | 'no-feed' | null {
  if (channel !== 'beta') return null
  if (__NOTULA_UPDATE_FEED_URL_BETA__ === '') return 'no-beta-feed'
  if (getUpdateState().feed === 'none') return 'no-feed'
  return null
}

export async function setChannel(ctx: MainContext, req: unknown): Promise<InvokeRes<'update:set-channel'>> {
  const channel = typeof req === 'object' && req !== null ? (req as { channel?: unknown }).channel : undefined
  if (channel !== 'stable' && channel !== 'beta') throw expected(notulaError('invalid-input', 'channel is invalid.'))
  const reason = channelRefusal(channel)
  if (reason) {
    log('debug', 'update:channel-refused', { channel, reason })
    return { ok: false, reason }
  }
  if ((await ctx.settings.get('updates.channel')) !== channel) await ctx.settings.set('updates.channel', channel)
  return { ok: true, reason: null }
}

export function registerReleaseChannel(ctx: MainContext): void {
  ipcMain.handle(
    'update:set-channel' satisfies InvokeChannel,
    (_e, req: InvokeReq<'update:set-channel'>): Promise<InvokeRes<'update:set-channel'>> => setChannel(ctx, req)
  )
}
