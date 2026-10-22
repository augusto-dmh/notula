// SPDX-License-Identifier: Apache-2.0
// main → renderer chat pushes (`chat:event`, `chat:changed`). The channel literal is written at the
// send site; the functions take no channel parameter.

import type { PushChannel } from '@shared/ipc'
import type { ChatEvent } from '@shared/types/chat'
import type { WindowsApi } from '../context'

export function pushChatEvent(windows: WindowsApi, e: ChatEvent): void {
  for (const wc of windows.targets()) wc.send('chat:event' satisfies PushChannel, e)
}

export function pushChatChanged(windows: WindowsApi, threadIds: string[]): void {
  if (threadIds.length === 0) return
  for (const wc of windows.targets()) wc.send('chat:changed' satisfies PushChannel, { threadIds })
}
