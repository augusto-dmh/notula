// SPDX-License-Identifier: Apache-2.0
// A tiny prompt template engine, no dependency. With <v> an input name:
//   {{<v>}}              the value (booleans and numbers as text)
//   {{#<v>}} … {{/<v>}}  the body when the value is truthy (non-empty text, true, non-zero)
//   {{^<v>}} … {{/<v>}}  the body when it is falsy
// A section tag alone on its line takes the whole line with it, so templates can be
// laid out readably without leaving blank lines behind.
//
// Every name a prompt uses must be a known input (the prompt inputs, the template
// variables, and the rewrite's `edit_instructions`). `definePrompt` checks this when the
// module loads.

export type PromptValue = string | number | boolean
export type PromptVariables = Record<string, PromptValue>

/** The prompt input contract. */
export const SUMMARY_VARIABLE_NAMES = [
  'transcript',
  'transcript_chars',
  'transcript_is_brief',
  'speaker_labels',
  'speaker_labels_mic_only',
  'has_room_speakers',
  'speakers_attributed',
  'notes',
  'headers',
  'urls',
  'notes_are_long',
  'tags',
  'author_name',
  'author_company',
  'author_bio',
  'author_colleagues',
  'outside_attendees',
  'outside_companies',
  'counterpart_name',
  'counterpart_bio',
  'participants',
  'reader_name',
  'reader_bio',
  'reader_company',
  'document_id',
  'event_name',
  'date',
  'time',
  'current_date',
  'latest_summary',
  'is_shared_note',
  'from_mobile',
  'is_multilingual',
  'summary_in_english',
  'uses_british_spelling',
  'custom_vocabulary',
  'author_is_investor',
  // Background about the note's author, never meeting content
  'author_context',
  'author_job_title',
  // Content sources: the video or lesson a source note came from ('' / false otherwise)
  'source_kind',
  'source_title',
  'source_channel',
  'source_series',
  'source_lesson',
  'source_url',
  'source_duration',
  // The transcript is a video's sound or captions, not a conversation
  'transcript_is_media'
] as const

/** Added only when the template has at least one section. */
export const TEMPLATE_VARIABLE_NAMES = [
  'section_headings',
  'lead_heading',
  'template_description',
  'template_name',
  'heading_limit'
] as const

/** The rewrite's input (with `latest_summary` from the prompt inputs). */
export const REWRITE_VARIABLE_NAMES = ['edit_instructions'] as const

export type SummaryVariableName = (typeof SUMMARY_VARIABLE_NAMES)[number]
export type TemplateVariableName = (typeof TEMPLATE_VARIABLE_NAMES)[number]

const KNOWN = new Set<string>([...SUMMARY_VARIABLE_NAMES, ...TEMPLATE_VARIABLE_NAMES, ...REWRITE_VARIABLE_NAMES])

export interface PromptTemplate {
  slug: string
  system: string
  user: string
}

type Node =
  | { kind: 'text'; text: string }
  | { kind: 'var'; name: string }
  | { kind: 'section'; name: string; inverted: boolean; body: Node[] }

const TAG = /\{\{\s*([#^/]?)\s*([a-z_][a-z0-9_]*)\s*\}\}/g
const STANDALONE = /^[ \t]*(\{\{\s*[#^/]\s*[a-z_][a-z0-9_]*\s*\}\})[ \t]*\r?\n/gm

function parse(template: string, where: string): Node[] {
  const src = template.replace(STANDALONE, '$1')
  const root: Node[] = []
  const stack: { name: string; nodes: Node[] }[] = [{ name: '', nodes: root }]
  let at = 0
  for (const m of src.matchAll(TAG)) {
    const top = stack[stack.length - 1] as { name: string; nodes: Node[] }
    if (m.index > at) top.nodes.push({ kind: 'text', text: src.slice(at, m.index) })
    at = m.index + m[0].length
    const [, sigil, name = ''] = m
    if (!KNOWN.has(name)) throw new Error(`prompt ${where}: unknown variable "${name}"`)
    if (sigil === '#' || sigil === '^') {
      const body: Node[] = []
      top.nodes.push({ kind: 'section', name, inverted: sigil === '^', body })
      stack.push({ name, nodes: body })
    } else if (sigil === '/') {
      if (stack.length === 1 || top.name !== name) throw new Error(`prompt ${where}: unbalanced {{/${name}}}`)
      stack.pop()
    } else {
      top.nodes.push({ kind: 'var', name })
    }
  }
  if (stack.length !== 1) throw new Error(`prompt ${where}: unclosed section`)
  if (at < src.length) root.push({ kind: 'text', text: src.slice(at) })
  return root
}

function truthy(v: PromptValue | undefined): boolean {
  if (typeof v === 'string') return v.trim().length > 0
  if (typeof v === 'number') return v !== 0
  return v === true
}

function render(nodes: Node[], vars: PromptVariables): string {
  let out = ''
  for (const n of nodes) {
    if (n.kind === 'text') out += n.text
    else if (n.kind === 'var') out += String(vars[n.name] ?? '')
    else if (truthy(vars[n.name]) !== n.inverted) out += render(n.body, vars)
  }
  return out
}

export interface CompiledPrompt {
  slug: string
  render(vars: PromptVariables): { system: string; user: string }
}

/** Parses and validates a prompt once, at module load. */
export function definePrompt(p: PromptTemplate): CompiledPrompt {
  const system = parse(p.system, `${p.slug}/system`)
  const user = parse(p.user, `${p.slug}/user`)
  return {
    slug: p.slug,
    render: (vars) => ({ system: render(system, vars).trim(), user: render(user, vars).trim() })
  }
}
