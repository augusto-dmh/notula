// SPDX-License-Identifier: Apache-2.0
// The prompts, by slug. Every variable they use is a prompt input, a template
// variable or `edit_instructions` (engine.ts checks it).

import type { CompiledPrompt } from './engine'
import didMeetingEnd from './meeting-end-check'
import standardNotes from './standard-notes'
import meetingTitle from './note-title'
import summaryRewrite from './summary-rewrite'
import customTemplateNotes from './custom-template-notes'

const PROMPTS = new Map<string, CompiledPrompt>(
  [standardNotes, customTemplateNotes, meetingTitle, didMeetingEnd, summaryRewrite].map((p) => [
    p.slug,
    p
  ])
)

/** Summary prompts a template may run on (custom slugs pass through to this lookup). */
export function summaryPrompt(slug: string): CompiledPrompt | null {
  if (slug === meetingTitle.slug || slug === didMeetingEnd.slug || slug === summaryRewrite.slug) return null
  return PROMPTS.get(slug) ?? null
}

export { didMeetingEnd, meetingTitle, summaryRewrite }
export { parseMeetingEnded } from './meeting-end-check'
export type { PromptVariables } from './engine'
