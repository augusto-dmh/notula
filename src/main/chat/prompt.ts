// SPDX-License-Identifier: Apache-2.0
// The chat prompt contract, for library chat and note chat.
//
// The system prompt is built once per answer and stays byte-identical across its tool
// rounds: the rules, the user and the moment, then the context the engine
// assembled, with the citation key of every item.

import { cutCodePoints, oneLine } from './text'

export interface PromptMoment {
  now: Date
  timeZone: string
  userName: string
}

export interface NotePromptFacts {
  title: string
  /** What the user is looking at; null on the transcript tab. */
  target: 'summary' | 'notes' | null
  editTools: boolean
  rewriteTool: boolean
  selection: boolean
  quickEdit: boolean
  live: boolean
  noteId: string
}

export interface SystemPromptInput {
  moment: PromptMoment
  tools: boolean
  detailed: boolean
  note: NotePromptFacts | null
  /** The place header, documents and transcript, already fitted to the budget. */
  context: string
  /** The user's recipes, loadable with loadRecipe. */
  skills?: { slug: string; description: string }[]
  /** The answer may ask the user questions and propose changes that wait for approval. */
  approvals?: boolean
  /** checkAvailability is offered, so the scheduling rules apply. */
  scheduling?: boolean
}

export function momentNow(userName: string): PromptMoment {
  return { now: new Date(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', userName: userName.trim() }
}

function when(m: PromptMoment): string {
  const date = m.now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const time = m.now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return `It is ${date}, ${time} (${m.timeZone})`
}

export function systemPrompt(p: SystemPromptInput): string {
  const out: string[] = []
  out.push(
    "You are the assistant inside Notula, the user's meeting notes app. You answer questions about their meetings from their notes, summaries and transcripts, " +
      'and help them act on them: drafting, organising and editing.'
  )
  out.push(when(p.moment) + (p.moment.userName ? `. The user is ${p.moment.userName}.` : ''))

  const rules = [
    'Answer from the context below and from tool results. When they do not contain the answer, say so plainly instead of guessing.',
    'Lead with the answer, then the supporting detail. Match the length to the question.',
    "Keep names, numbers, dates, file names and commands exactly as the sources have them, and make clear what someone said versus what you infer.",
    'Reply in the language the user writes in.',
    p.tools
      ? 'Use the tools to search meetings, transcripts, people, folders and the calendar whenever the context does not already answer the question. Search before you say that something is not in the notes.'
      : 'Answer only from the context below: no search is available in this conversation.',
    'Write Markdown: short paragraphs and bullet lists, headings only in long answers.'
  ]
  if (p.detailed) rules.push('The user asked for a detailed answer: be thorough, cover every relevant meeting and include the specifics.')
  out.push(`How to answer:\n${rules.map((r) => `- ${r}`).join('\n')}`)

  out.push(
    'Citing sources:\n' +
      'Every item of the context and of a tool result carries a key in square brackets: [<note id>] for a note or its summary, [<note id>-<n>] for passage n of its transcript. ' +
      'After each statement that comes from a source, add that key in square brackets, the most specific one available (the transcript passage when you used it). ' +
      'Put several keys in one bracket, separated by commas. Never invent a key, and add none to a line that uses no source.'
  )

  if (p.tools && p.approvals) {
    out.push(
      'Asking and proposing:\n' +
        "Tools that change the user's data (folders, filing notes, event notes) wait for the user's approval, so call them with your best proposal rather than asking for permission in text first. " +
        'When a request is ambiguous in a way that changes the result, ask with askUser and a few short options instead of guessing. ' +
        "Never say a change was made until the tool result confirms it; when the user declines, accept that and do not retry it."
    )
  }
  if (p.tools && p.scheduling) {
    out.push(
      'Scheduling:\n' +
        [
          "Before you offer meeting times that involve anyone besides the user, look up everyone's free time with checkAvailability.",
          'Offer only slots that the check shows as open for every person whose calendar it could see.',
          "When someone's calendar can't be seen, say so, offer times that suit the user, and don't suggest that the other person is free then.",
          'Never propose a time that no tool result supports.',
          "Open one person's calendar with readPersonCalendar only when the user wants detail about that person's day.",
          "Answer an invitation or cancel an event only when the user asked for it. Call the tool straight away: its approval card is where the user confirms, so don't ask in text first."
        ]
          .map((r) => `- ${r}`)
          .join('\n')
    )
  }
  if (p.tools && p.skills?.length) {
    out.push(
      "The user's saved recipes. When a request matches one, load its instructions with loadRecipe and follow them:\n" +
        p.skills.map((r) => `- ${r.slug}${r.description ? `: ${oneLine(r.description).slice(0, 140)}` : ''}`).join('\n')
    )
  }
  if (p.note) out.push(noteSection(p.note, p.tools))
  out.push(`<context>\n${p.context.trim() || "(Nothing in the user's notes matched this question.)"}\n</context>`)
  return out.join('\n\n')
}

function noteSection(n: NotePromptFacts, tools: boolean): string {
  const lines = [
    `The user is in the note of the meeting "${oneLine(n.title)}"${n.live ? ', which is still being transcribed' : ''}` +
      '. Questions without another subject are about this meeting.'
  ]
  if (n.target) {
    lines.push(
      `They are looking at ${n.target === 'summary' ? 'the AI summary of this meeting' : 'their own notes for this meeting'}` +
        '; "this" or "the note" means that document.'
    )
  }
  if (tools && n.editTools) {
    lines.push(
      'You can edit that document with editNote: findText must be copied exactly from the document, and newText replaces it. ' +
        "Make the change when the user asks for one, rather than pasting the edited document into your answer."
    )
    if (n.rewriteTool) lines.push('For a change to the whole summary (shorter, another language, another structure), use rewriteNote with clear instructions instead.')
    lines.push('After an edit, say in one sentence what changed.')
  } else if (n.target) {
    lines.push('You cannot edit that document from here: when asked to change it, give the new text so the user can paste it.')
  }
  if (n.selection) lines.push('The user selected a passage of the document; it is quoted at the end of their message, and their request is about it.')
  if (n.quickEdit && tools && n.editTools) {
    lines.push('This is a quick edit: apply the change to the selected passage with editNote straight away, then confirm in one short sentence.')
  }
  lines.push(`The meeting's id, for tools and citations: ${n.noteId}`)
  return lines.join('\n')
}

// ---------- thread titles (prompt inputs `message`, `current_date`, `day_of_week`) ----------

export const TITLE_SYSTEM =
  "You name chat threads. Reply with a title of 2 to 6 words, at most 40 characters, for what the user's first message asks about, " +
  'in the language of that message. No quotes, no final punctuation, nothing but the title.'

export function titleUser(input: { message: string; current_date: string; day_of_week: string }): string {
  return `Today is ${input.day_of_week}, ${input.current_date}.\n\nThe user's first message:\n${input.message.slice(0, 4_000)}`
}

/** Trimmed, whitespace collapsed, the first 40 code points, trimmed again. */
export function cleanTitle(reply: string, max: number): string {
  return cutCodePoints(oneLine(reply), max).trimEnd()
}
