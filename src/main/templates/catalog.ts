// SPDX-License-Identifier: Apache-2.0
// The built-in note templates: ten read-only
// templates with their titles, categories and section text, in the default
// order. They are constants, never rows, so an app update can improve
// them; the ids are fixed in the shared contract.

import { BUILTIN_TEMPLATE_IDS, type NoteTemplate, type TemplateIcon } from '@shared/types/templates'

type BuiltinKey = keyof typeof BUILTIN_TEMPLATE_IDS

interface BuiltinSpec {
  key: BuiltinKey
  title: string
  category: string
  icon: TemplateIcon
  /** heading → what belongs under it. */
  sections: [string, string][]
}

/** When the catalog first shipped; built-ins never change their `created_at`. */
const CATALOG_DATE = '2026-10-01T00:00:00.000Z'

const SPECS: BuiltinSpec[] = [
  {
    key: 'one-on-one',
    title: 'One-on-one',
    category: 'Team',
    icon: { type: 'icon', value: 'user-pair', color: 'blue' },
    sections: [
      ['Check-in', 'How the other person is doing, and anything about workload or wellbeing they chose to share. Keep it brief.'],
      ['Updates and wins', 'Progress since the last one-on-one: what shipped or moved forward, and results worth recognising, with specifics.'],
      ['Challenges and support', 'Blockers, concerns or frustrations raised, and the help or changes asked for or offered.'],
      ['Feedback', 'Feedback in either direction, stated concretely: what was observed, and what to keep doing or change.'],
      ['Growth and career', 'Goals, development or promotion topics, with deadlines and what is needed to get there.'],
      ['Action items', 'One line per commitment: owner, task and due date when stated.']
    ]
  },
  {
    key: 'team-meeting',
    title: 'Team meeting',
    category: 'Team',
    icon: { type: 'icon', value: 'users', color: 'teal' },
    sections: [
      ['Updates', 'Each topic or status update covered, with its key facts, numbers and dates.'],
      ['Decisions', 'What the team decided, with the reasons or constraints given.'],
      ['Risks and blockers', 'Problems, dependencies and risks raised, and who is handling each.'],
      ['Open questions', 'Questions left unanswered, and who will follow up on each.'],
      ['Action items', 'One line per task: owner, task and due date when stated.']
    ]
  },
  {
    key: 'stand-up',
    title: 'Daily stand-up',
    category: 'Team',
    icon: { type: 'icon', value: 'sunrise', color: 'orange' },
    sections: [
      ['Progress', 'What each person finished or moved forward since the last stand-up, grouped by person.'],
      ['Up next', 'What each person plans to work on next.'],
      ['Blockers', 'Anything holding someone up, and who offered to help.'],
      ['Follow-ups', 'Topics taken offline, with who will discuss them.']
    ]
  },
  {
    key: 'project-kick-off',
    title: 'Project kick-off',
    category: 'Team',
    icon: { type: 'icon', value: 'rocket', color: 'purple' },
    sections: [
      ['Goals and success criteria', 'What the project must achieve and how success will be measured.'],
      ['Scope', 'What is in and out of scope, including anything explicitly deferred.'],
      ['Roles and owners', 'Who is responsible for what, including stakeholders and decision makers.'],
      ['Timeline and milestones', 'Phases, milestones and deadlines as stated.'],
      ['Risks and dependencies', 'Known risks, assumptions and dependencies on other teams or systems.'],
      ['Next steps', 'One line per task: owner, task and due date when stated.']
    ]
  },
  {
    key: 'sales-meeting',
    title: 'Sales call',
    category: 'Customers and sales',
    icon: { type: 'icon', value: 'handshake', color: 'green' },
    sections: [
      ['About the prospect', 'The company, the people on the call and their roles, and the setup or tools they use today.'],
      ['Needs and pain points', 'The problems they described, their impact (cost, incidents, time lost) and what success would look like for them.'],
      ['Requirements and objections', 'Must-haves such as security, compliance or integrations, and any concerns raised with the answers given.'],
      ['Pricing and budget', 'Plans, prices, discounts and budget figures, exactly as stated.'],
      ['Decision process', 'Who decides, other options being considered, and the timeline or deadline for the decision.'],
      ['Next steps', 'One line per follow-up: owner, task and due date, including meetings that were scheduled.']
    ]
  },
  {
    key: 'customer-check-in',
    title: 'Customer check-in',
    category: 'Customers and sales',
    icon: { type: 'icon', value: 'heart', color: 'pink' },
    sections: [
      ['Account status', 'How the customer uses the product, the results so far and their overall sentiment.'],
      ['Feedback and requests', 'What they value, what frustrates them and the features they asked for, in their own words where possible.'],
      ['Issues', 'Problems or support cases raised, their impact and current status.'],
      ['Renewal and growth', 'Signs of expansion or of risk, renewal timing, and any figures or dates mentioned.'],
      ['Next steps', 'One line per follow-up: owner, task and due date when stated.']
    ]
  },
  {
    key: 'user-interview',
    title: 'User interview',
    category: 'Research',
    icon: { type: 'icon', value: 'chat', color: 'yellow' },
    sections: [
      ['Participant', 'Who they are: role, company or context, as far as they shared.'],
      ['How they work today', 'How they do the job now: the steps, tools and workarounds they described.'],
      ['Pain points', 'Difficulties and frustrations, each with the concrete example they gave.'],
      ['Reactions', 'Responses to the ideas, prototypes or features shown: what worked and what confused them.'],
      ['Quotes', 'Short quotes worth keeping, word for word.'],
      ['Insights and follow-ups', 'Patterns or hypotheses the interview suggests, and any follow-up agreed with the participant.']
    ]
  },
  {
    key: 'candidate-interview',
    title: 'Candidate interview',
    category: 'Hiring',
    icon: { type: 'icon', value: 'briefcase', color: 'red' },
    sections: [
      ['Background', 'The candidate\'s current role, experience and career history, as they described it.'],
      ['Skills and evidence', 'What their answers show about their skills: projects, examples, results and technologies.'],
      ['Motivation', 'Why they are interested, what they are looking for, and any concerns they raised.'],
      ['Their questions', 'What the candidate asked, and the answers given.'],
      ['Logistics', 'Availability, notice period, location and compensation expectations, as stated.'],
      ['Impressions and next steps', 'Strengths and concerns that the interviewers voiced in the meeting (add no judgments of your own), and the agreed next steps in the process.']
    ]
  },
  {
    key: 'brainstorm',
    title: 'Brainstorm',
    category: 'Workshops',
    icon: { type: 'icon', value: 'lightbulb', color: 'yellow' },
    sections: [
      ['Goal', 'The problem or question the session set out to explore.'],
      ['Ideas', 'Each idea raised, with who proposed it when clear, and the main arguments for and against.'],
      ['Shortlist', 'The ideas the group favoured or chose to pursue, and why.'],
      ['Open questions', 'What needs to be found out before deciding.'],
      ['Next steps', 'One line per task: owner, task and due date when stated.']
    ]
  },
  {
    // Content sources: selected for a source note while `sources.lessonTemplate` is on.
    key: 'lesson',
    title: 'Lesson',
    category: 'Learning',
    icon: { type: 'icon', value: 'graduation', color: 'blue' },
    sections: [
      ['Key ideas', 'The main concepts the lesson teaches, in the order it presents them: what each one is, how it works and why it matters. End each with the video time where it is explained, as [mm:ss].'],
      ['Definitions', 'Terms the lesson defines or relies on, one per line: the term in bold, then its meaning as the lesson gives it.'],
      ['Examples', 'Worked examples, demos, code, commands and tools shown, with what each one illustrates and its video time [mm:ss].'],
      ['Questions', 'Questions the lesson raises or leaves open, the questions in the user’s notes, and the points worth reviewing again.'],
      ['References', 'Links, books, courses, tools and people the lesson mentions, and the moments worth rewatching, each with its video time [mm:ss].']
    ]
  }
]

function toTemplate(spec: BuiltinSpec): NoteTemplate {
  const id = BUILTIN_TEMPLATE_IDS[spec.key]
  return {
    id,
    workspace_id: null,
    owner_id: null,
    title: spec.title,
    description: '',
    sections: spec.sections.map(([heading, section_hint], i) => ({
      id: `${id.slice(0, 8)}-section-${i + 1}`,
      heading,
      section_hint
    })),
    category: spec.category,
    icon: spec.icon,
    is_builtin: true,
    shared_with: null,
    copied_from: null,
    created_at: CATALOG_DATE,
    updated_at: null,
    deleted_at: null
  }
}

/** The ten built-ins, in the default order. Object.freeze'd: callers get copies. */
const BUILTINS: readonly NoteTemplate[] = Object.freeze(SPECS.map(toTemplate))
const BY_ID = new Map(BUILTINS.map((t) => [t.id, t]))

export function builtinTemplates(): NoteTemplate[] {
  return BUILTINS.map((t) => structuredClone(t))
}

export function builtinTemplate(id: string): NoteTemplate | null {
  const t = BY_ID.get(id.toLowerCase())
  return t ? structuredClone(t) : null
}

export function isBuiltinTemplateId(id: string): boolean {
  return BY_ID.has(id.toLowerCase())
}
