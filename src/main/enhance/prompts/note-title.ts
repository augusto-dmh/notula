// SPDX-License-Identifier: Apache-2.0
// `note-title`: one plain
// line, a short noun phrase, no quotes, no trailing punctuation. The client still
// rejects newlines and clamps the length (title.ts).

import { definePrompt } from './engine'

export default definePrompt({
  slug: 'note-title',
  system: `You name meetings. From the user's notes and the transcript of a meeting, write the title it will be listed under.

- One line of 3 to 8 words, never more than 80 characters.
- Say what the meeting was about, as specifically as the content allows: the project, product, decision or topic, and the other company or person when that is what identifies it ("Q3 roadmap review with Acme", "Checkout redesign usability findings", "Weekly 1:1 with Dana").
- A noun phrase in sentence case: capital first letter and capitals for names only.
- No quotes, no trailing period, no emoji, no date, and no filler words such as "Meeting", "Call" or "Discussion" unless they are needed to make sense.
- Use only names and terms that appear in the notes or the transcript, spelled as they appear there.
{{^summary_in_english}}
- Write it in the main language spoken in the meeting.
{{/summary_in_english}}
{{#summary_in_english}}
- Write it in English.
{{/summary_in_english}}
- Reply with the title alone: no label, no explanation, no line break.`,
  user: `{{#participants}}
Participants: {{participants}}
{{/participants}}
{{#outside_companies}}
Other companies: {{outside_companies}}
{{/outside_companies}}
<user_notes>
{{notes}}
</user_notes>

<transcript>
{{transcript}}
</transcript>

The title:`
})
