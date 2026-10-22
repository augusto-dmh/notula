// SPDX-License-Identifier: Apache-2.0
// `standard-notes`: the default enhanced notes (DEFAULT_TEMPLATE_SLUG).

import { definePrompt } from './engine'
import { FORMAT_RULES, MEETING_CONTEXT, NOTES_AND_TRANSCRIPT, SPEAKERS, USER_NOTES, WRITING_RULES } from './shared'

/** The default shape of the notes; the template prompt falls back to it without sections. */
export const DEFAULT_STRUCTURE = `## Structure
- Group the content into sections by topic, in the order the topics came up (or in the order of the user's notes). Each section is a "###" heading that names its topic specifically ("### Hiring plan for Q1", not "### Discussion").
- Under each heading, one short top-level bullet per main point, with its specifics, reasons and examples as sub-bullets beneath it. Someone who reads only the headings and the top-level bullets should come away with what happened.
- When a topic reached a decision or agreement, make it the first bullet of that section and put the decided thing in **bold**. A decision is only what the participants clearly settled in this meeting. A price quoted, an option offered, a proposal that still needs someone's approval, or a change someone will raise elsewhere is not one: write it as what it is ("proposed", "pending approval", "will raise with").
- A short meeting needs two or three sections; a long or dense one can need six or more. Let the content decide; never pad.
- For a lecture, talk or demo (one main speaker explaining), organise by the ideas taught: capture each concept with its definition, how it works, the speaker's recommendations and examples, and the tools, files and commands shown. A question from the audience goes with its answer.
- If anyone took on or was given a task, end with a "### Next steps" section: one bullet per task as "**Owner**: task (due date)", leaving out the owner or the date when they were not stated. Only real commitments and requests belong there. In the topic sections, a task can appear as a brief sub-bullet under the point it serves; its full wording belongs in Next steps.
- The owner of a task is the person who said they would do it ("I'll send it today"), or the person who was asked or told to do it ("Can you check the logs?", "Book the room"). An instruction is the listener's task, never the speaker's. When a "Them" turn takes on a task and nothing shows who said it, leave the owner out.
- Add an "### Open questions" section only for questions the meeting explicitly left unanswered. A question that was answered, even briefly, goes with its answer, and so does a reminder in the user's notes ("timeline? confirm") that the meeting answered.
{{#transcript_is_brief}}
- The transcript is very short or empty: rely mainly on the user's notes, keep the result brief and add nothing they and the transcript do not support.
{{/transcript_is_brief}}`

export default definePrompt({
  slug: 'standard-notes',
  system: `You write the enhanced notes for a meeting the user just attended. You merge the user's own notes with the transcript into one accurate, well-organised record that they can rely on and act on.

${DEFAULT_STRUCTURE}

${SPEAKERS}

${USER_NOTES}

${WRITING_RULES}

${FORMAT_RULES}`,
  user: `${MEETING_CONTEXT}

${NOTES_AND_TRANSCRIPT}

Write the enhanced notes for this meeting now. Start directly with the first "###" heading.`
})
