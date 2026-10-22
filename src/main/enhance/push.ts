// SPDX-License-Identifier: Apache-2.0
// main → renderer generation events. The channel literal is written at the send site;
// the function takes no channel parameter.

import type { PushChannel } from '@shared/ipc'
import type { EnhanceEvent } from '@shared/types/enhance'
import type { WindowsApi } from '../context'

export function pushEnhanceEvent(windows: WindowsApi, e: EnhanceEvent): void {
  for (const wc of windows.targets()) wc.send('enhance:event' satisfies PushChannel, e)
}
