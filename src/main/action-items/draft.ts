// SPDX-License-Identifier: Apache-2.0
// Next-step drafts: the account an email or Slack action item needs before chat can draft it,
// and the first chat message of its thread. The message is built here, without a model call;
// the chat turn it starts does the writing, with the meeting as context.

import type { ActionItem, ActionItemChannel } from '@shared/types/action-items'
import type { CalendarSource } from '@shared/types/calendar'
import type { MainContext } from '../context'

/** Email needs mail on and an account that may send; Slack needs the integration set up. */
export async function draftConnected(ctx: MainContext, channel: ActionItemChannel): Promise<boolean> {
  if (channel === 'email') {
    if (!(await ctx.settings.get('mail.enabled'))) return false
    const sources = (await ctx.storage.listCalendarSources().catch(() => [])) as CalendarSource[]
    return sources.some((s) => (s.kind === 'google' || s.kind === 'microsoft') && s.grants.includes('mail-send'))
  }
  const status = await ctx.integrations.status('slack').catch(() => null)
  return !!status && status.state !== 'not_configured'
}

/** The user's request that opens the draft thread. */
export function draftSeed(item: Pick<ActionItem, 'intent' | 'detail'>, channel: ActionItemChannel): string {
  const task = [
    channel === 'email'
      ? 'Write the email this action item from the meeting calls for.'
      : 'Write the Slack message this action item from the meeting calls for.',
    `Action item: ${item.intent}`,
    ...(item.detail ? [`Context: ${item.detail}`] : [])
  ]
  const how = [
    'Take the facts from the meeting, and keep it a draft for me to read and change before anything goes out.',
    ...(channel === 'slack' ? ['Give me the message itself, ready to paste into Slack.'] : [])
  ]
  return [task.join('\n'), how.join('\n')].join('\n\n')
}
