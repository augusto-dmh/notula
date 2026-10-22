// SPDX-License-Identifier: Apache-2.0
// The Labs "Draft Slack messages with AI" prefill, LLM purpose `slack-summary` on
// the user's provider: one completion, 30 s, the text between <notes> and </notes>.
// `integrations:slack-draft`. Null (off, local-only, no draft, any error) means
// the composer keeps the panel prefill.

import type { MainContext } from '../context'
import { currentProvider } from '../llm/registry'
import { MAX_TOKENS } from '../llm/types'
import { log } from '../log'
import { egressBlocked } from '../privacy'

const SYSTEM =
  'You write the Slack message the user posts to share a meeting with their team. Use <panel_text> (the meeting notes they are sharing) as the main source and the other inputs only to check facts. Open with one line that says what the meeting was and its outcome, then up to six short bullets with the decisions, key numbers and next steps with owners. Keep names, numbers, dates and terms exactly; add nothing the notes do not say. Use Slack formatting (*bold* sparingly, "-" bullets), no headings, and stay under 1,200 characters, in the language of the notes. Reply with the message alone, between <notes> and </notes>.'

export async function slackDraft(ctx: MainContext, noteId: string, panelText: string): Promise<string | null> {
  try {
    if (!(await ctx.settings.get('integrations.slack.aiDraft'))) return null
    if (await egressBlocked(ctx, { kind: 'llm' })) return null
    const inputs = await ctx.enhance.noteChatInputs(noteId, {})
    const vars = Object.entries(inputs.vars)
      .map(([k, v]) => `<${k}>\n${v}\n</${k}>`)
      .join('\n')
    const provider = await currentProvider(ctx.settings, ctx.secrets)
    const text = await provider.complete(
      { purpose: 'slack-summary', system: SYSTEM, user: `${vars}\n<panel_text>\n${panelText.slice(0, 60_000)}\n</panel_text>`, maxTokens: MAX_TOKENS['slack-summary'] },
      AbortSignal.timeout(30_000)
    )
    const m = /<notes>([\s\S]*?)<\/notes>/.exec(text)
    const draft = m?.[1]?.trim() ?? ''
    // "At most 400 output tokens" is a client-side length check (~1,600 characters), since the
    // output budget itself stays at the 2,000-token floor.
    return draft ? draft.slice(0, 1_600) : null
  } catch (err) {
    log('warn', 'integrations:slack-draft-failed', { err: err instanceof Error ? err.name : 'error' })
    return null
  }
}
