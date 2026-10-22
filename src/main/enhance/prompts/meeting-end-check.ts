// SPDX-License-Identifier: Apache-2.0
// `meeting-end-check`: a yes/no on the last 100 words of the speaker-named transcript,
// sent as the single variable `transcript`. Behind LLM_AUTO_STOP (auto.ts), off by default.

import { definePrompt } from './engine'

export const WRAPPED_UP = 'WRAPPED_UP'
export const STILL_TALKING = 'STILL_TALKING'

export default definePrompt({
  slug: 'meeting-end-check',
  system: `You decide whether a meeting is over, from the last words of its live transcript (any language).

Answer ${WRAPPED_UP} when the conversation is closing for everyone: people thank each other, say goodbye or "talk soon", agree to end, or the last speaker is clearly leaving and nothing new starts.
Answer ${STILL_TALKING} when the conversation is still going: a topic is in progress, a new item or a screen share is starting, only some people are leaving while the rest continue, or you cannot tell.

Reply with exactly one of the two words and nothing else.`,
  user: `The last words of the transcript:
<transcript_end>
{{transcript}}
</transcript_end>`
})

/**
 * "Ended" when the last marker is WRAPPED_UP or when neither appears;
 * "not ended" when the last marker is STILL_TALKING, or the reply is empty.
 */
export function parseMeetingEnded(reply: string): boolean {
  const text = reply.trim()
  if (!text) return false
  const notEnded = text.lastIndexOf(STILL_TALKING)
  // WRAPPED_UP is a substring of STILL_TALKING, so look for one not inside it.
  let ended = -1
  for (let i = text.indexOf(WRAPPED_UP); i !== -1; i = text.indexOf(WRAPPED_UP, i + 1)) {
    if (text.slice(Math.max(0, i - 'DID_NOT_'.length), i) !== 'DID_NOT_') ended = i
  }
  if (ended === -1 && notEnded === -1) return true
  return ended > notEnded
}
