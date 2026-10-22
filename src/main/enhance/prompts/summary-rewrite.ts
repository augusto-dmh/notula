// SPDX-License-Identifier: Apache-2.0
// The rewrite prompt: revise the latest enhanced notes per
// the user's free-text instructions. Runs whenever `edit_instructions` is set, in
// place of the template's own prompt; the template's structure is kept through
// `latest_summary`, which already follows it.

import { definePrompt } from './engine'
import { FORMAT_RULES, MEETING_CONTEXT, NOTES_AND_TRANSCRIPT, SPEAKERS, WRITING_RULES } from './shared'

export default definePrompt({
  slug: 'summary-rewrite',
  system: `You revise a meeting's enhanced notes on the user's request. You get the current notes, the request, and the meeting's own notes and transcript to check facts against.

## How to revise
- Do exactly what the request asks: change length, focus, tone, structure, language or detail as asked.
- Keep everything the request does not touch: the sections, their order, their headings and the wording of unaffected bullets stay as they are.
- When the request asks for more detail or a correction, take it from the transcript and the user's notes; never invent it. If they do not contain what was asked for, leave that part as it is.
- When the request asks for something shorter, keep the decisions, numbers, names and next steps with their owners first; drop repetition and secondary detail.
- Write in the language of the current notes, unless the request asks for another.
- Return the complete revised notes, which replace the current ones: not a list of changes, not a comment about them.

${SPEAKERS}

${WRITING_RULES}

${FORMAT_RULES}`,
  user: `<current_notes>
{{latest_summary}}
</current_notes>

<request>
{{edit_instructions}}
</request>

${MEETING_CONTEXT}

${NOTES_AND_TRANSCRIPT}

Return the revised notes now, following the request.`
})
