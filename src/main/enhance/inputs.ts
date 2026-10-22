// SPDX-License-Identifier: Apache-2.0
// Prompt inputs. One routine
// builds every variable from the note, its attendees, the local profile,
// preferences and the transcript; the summary, rewrite and title prompts all use it.

import { formatPosition } from '@shared/lib/position'
import type { CalendarAttendee, Note, NotePerson } from '@shared/types/notes'
import type { Settings } from '@shared/types/settings'
import type { NoteSource, SourceSeries } from '@shared/types/sources'
import type { TranscriptChunk } from '@shared/types/transcript'
import type { PromptValue, PromptVariables, SummaryVariableName, TemplateVariableName } from './prompts/engine'
import type { Template } from './templates'
import { formatTranscript, type FormattedTranscript } from './transcript'

const SHORT_TRANSCRIPT_CHARS = 200
const LONG_NOTES_LINES = 20
/** Mail domains shared by unrelated people: never "the same company". */
const FREE_MAIL = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'gmx.de',
  'hey.com',
  'fastmail.com',
  'zoho.com',
  'yandex.com',
  'mail.com'
])
const URL_PATTERN =
  /\b(?:https?:\/\/[^\s<>()"']+|www\.[^\s<>()"']+|(?:[a-z0-9-]+\.)+(?:com|org|net|io|ai|co|dev|app|edu|gov|uk|de|fr|es|it|nl|br|ca|au|in|jp|me|us|eu|ly|so|xyz|tech|cloud)(?:\/[^\s<>()"']*)?)/gi

export interface InputSources {
  note: Note | null
  chunks: TranscriptChunk[]
  settings: Settings
  /** The editor's current markdown (manual generate). */
  notesMarkdown?: string
  /** The meeting's transcription language: the latest session's, else the setting. */
  language: string
  /** The app locale (`app.getLocale()`). */
  locale: string
  template?: Template
  overrides?: Record<string, string>
  now?: Date
  /** The note is still being transcribed (live speaker turns). */
  live?: boolean
  /** A source note's source and series (content sources); absent for every other note. */
  source?: SourceInputs | null
}

export interface PromptInputs {
  vars: PromptVariables
  transcript: FormattedTranscript
}

interface Person {
  name: string
  email: string
  company: string
  jobTitle: string
}

function person(p: NotePerson | undefined): Person {
  return {
    name: p?.name?.trim() ?? '',
    email: p?.email?.trim().toLowerCase() ?? '',
    company: p?.company?.trim() ?? '',
    jobTitle: p?.jobTitle?.trim() ?? ''
  }
}

function domainOf(email: string): string {
  const at = email.lastIndexOf('@')
  return at === -1 ? '' : email.slice(at + 1).toLowerCase()
}

function companyFromDomain(domain: string): string {
  if (!domain || FREE_MAIL.has(domain)) return ''
  const label = domain.split('.').slice(-2, -1)[0] ?? ''
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : ''
}

function displayName(p: Person): string {
  return p.name || p.email
}

/** "A", "A and B", "A, B and C". */
function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

function unique(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const i of items) {
    const k = i.toLowerCase()
    if (!i || seen.has(k)) continue
    seen.add(k)
    out.push(i)
  }
  return out
}

/** Attendees other than the creator, merged from the note's people and its event. */
function attendeesOf(note: Note, creator: Person): Person[] {
  const byKey = new Map<string, Person>()
  const add = (p: Person): void => {
    if (!p.name && !p.email) return
    if (creator.email && p.email === creator.email) return
    const key = p.email || p.name.toLowerCase()
    const prev = byKey.get(key)
    byKey.set(key, prev ? { ...prev, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v)) } : p)
  }
  for (const a of note.people?.attendees ?? []) add(person(a))
  for (const a of (note.linked_event?.attendees ?? []) as CalendarAttendee[]) {
    if (a.self || a.resource) continue
    add(person({ email: a.email, name: a.displayName }))
  }
  return [...byKey.values()]
}

function bioSentence(p: Person, firstPerson: boolean): string {
  const who = firstPerson ? 'I work' : `${displayName(p)} works`
  if (p.jobTitle && p.company) return `${who} at ${p.company} as ${p.jobTitle}.`
  if (p.jobTitle) return `${who} as ${p.jobTitle}.`
  if (p.company) return `${who} at ${p.company}.`
  return ''
}

function participant(p: Person): string {
  return p.name && p.email ? `${p.name} <${p.email}>` : displayName(p)
}

function headersOf(markdown: string): string {
  return markdown
    .split('\n')
    .filter((l) => l.trimStart().startsWith('#'))
    .map((l) => l.trim().replace(/^#+/, '').trim())
    .filter(Boolean)
    .join(', ')
}

function urlsOf(text: string): string {
  const found = (text.match(URL_PATTERN) ?? []).map((u) => {
    const clean = u.replace(/[.,;:!?'"]+$/, '')
    return /^https?:\/\//i.test(clean) ? clean : `https://${clean}`
  })
  return unique(found).join(', ')
}

interface PmNode {
  type?: string
  text?: string
  attrs?: Record<string, unknown>
  content?: PmNode[]
}

/** Text of each block that contains a mention, de-duplicated, blank-line separated. */
function tagsOf(doc: unknown): string {
  const lines: string[] = []
  const textOf = (n: PmNode): string =>
    n.type === 'text'
      ? (n.text ?? '')
      : n.type === 'mention'
        ? `@${String(n.attrs?.['label'] ?? n.attrs?.['id'] ?? '')}`
        : (n.content ?? []).map(textOf).join('')
  const hasMention = (n: PmNode): boolean => n.type === 'mention' || (n.content ?? []).some(hasMention)
  const walk = (n: PmNode): void => {
    const blocks = n.content ?? []
    const isTextBlock = blocks.length > 0 && blocks.every((c) => c.type === 'text' || c.type === 'mention' || c.type === 'hardBreak')
    if (isTextBlock) {
      if (hasMention(n)) lines.push(textOf(n).trim())
      return
    }
    blocks.forEach(walk)
  }
  if (doc && typeof doc === 'object') walk(doc as PmNode)
  return unique(lines).join('\n\n')
}

function validZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return zone
  } catch {
    return undefined
  }
}

/** `heading_limit`. */
export function maxNumHeadings(transcriptLength: number): number {
  if (transcriptLength < 8_000) return 4
  if (transcriptLength < 20_000) return 5
  if (transcriptLength < 80_000) return Math.floor(transcriptLength / 10_000) + 1
  return 8
}

function emptyVars(): Record<SummaryVariableName, string | number | boolean> {
  return {
    transcript: '',
    transcript_chars: 0,
    transcript_is_brief: true,
    speaker_labels: 'unlabeled',
    speaker_labels_mic_only: false,
    has_room_speakers: false,
    speakers_attributed: false,
    notes: '',
    headers: '',
    urls: '',
    notes_are_long: false,
    tags: '',
    author_name: '',
    author_company: '',
    author_bio: '',
    author_colleagues: '',
    outside_attendees: '',
    outside_companies: '',
    counterpart_name: '',
    counterpart_bio: '',
    participants: '',
    reader_name: '',
    reader_bio: '',
    reader_company: '',
    document_id: '',
    event_name: '',
    date: '',
    time: '',
    current_date: '',
    latest_summary: '',
    is_shared_note: false,
    from_mobile: false,
    is_multilingual: false,
    summary_in_english: true,
    uses_british_spelling: false,
    custom_vocabulary: '',
    author_is_investor: false,
    author_context: '',
    author_job_title: '',
    source_kind: '',
    source_title: '',
    source_channel: '',
    source_series: '',
    source_lesson: '',
    source_url: '',
    source_duration: '',
    transcript_is_media: false
  }
}

/** A source note's facts for its prompt inputs (`InputSources.source`). */
export interface SourceInputs {
  source: NoteSource
  series: Pick<SourceSeries, 'kind' | 'title'> | null
}

const SOURCE_KIND_TEXT: Record<NoteSource['kind'], string> = {
  video: 'video',
  live: 'live stream',
  lesson: 'lesson',
  other: 'video'
}

/** "12", "12 (Module 2)", or the label alone; a guessed or pending number isn't stated. */
function lessonText(s: NoteSource): string {
  const label = s.lesson_label?.trim() ?? ''
  const n = s.lesson_state === 'numbered' && s.lesson_number !== null ? String(s.lesson_number) : ''
  if (n && label) return `${n} (${label})`
  return n || label
}

/**
 * Content sources: the source variables of a source note, and `notes` from the
 * stamped projection. Applied after the note's own variables; an empty result changes nothing.
 */
export function sourceVars(src: SourceInputs | null): Partial<Record<SummaryVariableName, PromptValue>> {
  if (!src) return {}
  const s = src.source
  const stamped = s.notes_md_stamped?.trim() ? s.notes_md_stamped : null
  return {
    source_kind: SOURCE_KIND_TEXT[s.kind] ?? 'video',
    source_title: s.title.trim(),
    source_channel: s.channel?.trim() ?? '',
    source_series: src.series?.title.trim() ?? '',
    source_lesson: lessonText(s),
    source_url: s.url ?? '',
    source_duration: s.duration_ms !== null && s.duration_ms > 0 && !s.live ? formatPosition(s.duration_ms) : '',
    transcript_is_media: true,
    // The renderer's stamped projection: each stamped line carries its `[mm:ss](link)`.
    ...(stamped ? { notes: stamped } : {})
  }
}

/** The note's text for `notes`: the editor's Markdown when sent, else the stored projection, else plain text. */
function noteNotes(src: InputSources, note: Note): string {
  return src.notesMarkdown?.trim() ? src.notesMarkdown : note.notes_md?.trim() ? note.notes_md : (note.notes_text ?? '')
}

/** A stamped paragraph's prefix, after any quote, list or task marker: `[mm:ss](link) ` or `[mm:ss] `. */
const STAMP_PREFIX = /^(\s*(?:>\s*)*(?:[-*+]\s+|\d+[.)]\s+)?(?:\\?\[[ xX]\\?\]\s+)?)\\?\[(?:\d+:)?\d{1,2}:\d{2}\\?\](?:\([^()\s]*\))? /

function sameText(a: string, b: string): boolean {
  const norm = (t: string): string =>
    t
      .split('\n')
      .map((l) => l.trimEnd())
      .join('\n')
      .trim()
  return norm(a) === norm(b)
}

/**
 * The source with its stamped projection only when that projection is the note's current text
 * with stamps added. The renderer saves it on a 10 s debounce, so it can lag the editor's
 * Markdown or the stored notes; a stale one is dropped and the newer notes are used, without
 * stamps.
 */
function withFreshStamped(src: SourceInputs, notes: string): SourceInputs {
  const stamped = src.source.notes_md_stamped
  if (!stamped?.trim()) return src
  const plain = stamped
    .split('\n')
    .map((l) => l.replace(STAMP_PREFIX, '$1'))
    .join('\n')
  return sameText(plain, notes) ? src : { ...src, source: { ...src.source, notes_md_stamped: null } }
}

export function buildPromptInputs(src: InputSources): PromptInputs {
  // Word-level attribution when diarization is on.
  // A source note's transcript is labelled with video time (content sources).
  const transcript = formatTranscript(src.chunks, {
    wordLevel: src.settings['transcription.diarization'],
    live: src.live === true,
    ...(src.note && src.source ? { media: true } : {})
  })
  // Every key is present even without a note.
  const vars: PromptVariables = emptyVars()
  if (src.note) Object.assign(vars, noteVars(src, src.note, transcript))
  if (src.note && src.source) Object.assign(vars, sourceVars(withFreshStamped(src.source, noteNotes(src, src.note))))
  if (src.template && src.template.sections.length > 0) Object.assign(vars, templateVars(src.template, transcript.text.length))
  // Caller overrides replace computed values of the same name.
  for (const [k, v] of Object.entries(src.overrides ?? {})) vars[k] = v
  return { vars, transcript }
}

/**
 * `ctx.enhance.autoGenerate` (the demo's script): `text` becomes the transcript input,
 * with the variables computed from its length.
 */
export function withTranscriptText(vars: PromptVariables, text: string, template: Template | undefined): void {
  vars['transcript'] = text
  vars['transcript_chars'] = text.length
  vars['transcript_is_brief'] = text.length < SHORT_TRANSCRIPT_CHARS
  if (template && template.sections.length > 0) vars['heading_limit'] = maxNumHeadings(text.length)
}

function noteVars(src: InputSources, note: Note, transcript: FormattedTranscript): Partial<Record<SummaryVariableName, string | number | boolean>> {
  const { settings } = src
  const british = src.locale === 'en-GB'
  const notes = noteNotes(src, note)
  const noteLines = (notes ?? '').split('\n').filter((l) => l.trim().length > 0)

  const profile = person({
    name: settings['profile.name'],
    email: settings['profile.email'],
    company: settings['profile.company'],
    jobTitle: settings['profile.jobTitle']
  })
  const stored = person(note.people?.creator)
  const creator: Person = {
    name: profile.name || stored.name,
    email: profile.email || stored.email,
    company: profile.company || stored.company,
    jobTitle: profile.jobTitle || stored.jobTitle
  }
  const companyDescription = settings['profile.companyDescription'].trim()
  const myBio = [bioSentence(creator, true), companyDescription].filter(Boolean).join(' ')

  const attendees = attendeesOf(note, creator)
  const myDomain = domainOf(creator.email)
  const sameCompany = (p: Person): boolean => !!myDomain && !FREE_MAIL.has(myDomain) && domainOf(p.email) === myDomain
  const colleagues = attendees.filter(sameCompany)
  const externals = attendees.filter((p) => !sameCompany(p))

  const event = note.linked_event
  const zone = validZone(event?.start?.timeZone)
  const startText = event?.start?.dateTime ?? event?.start?.date ?? note.created_at
  const start = new Date(startText)
  const allDay = !event?.start?.dateTime && !!event?.start?.date
  const locale = british ? 'en-GB' : 'en-US'
  const dateFmt: Intl.DateTimeFormatOptions = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }
  const valid = Number.isFinite(start.getTime())

  const language = src.language
  const summaryLanguage = settings['enhance.summaryLanguage']

  return {
    transcript: transcript.text,
    transcript_chars: transcript.text.length,
    transcript_is_brief: transcript.text.length < SHORT_TRANSCRIPT_CHARS,
    speaker_labels: transcript.labels,
    speaker_labels_mic_only: transcript.justMic,
    has_room_speakers: transcript.hasRoomLabels,
    speakers_attributed: false,
    notes: notes ?? '',
    headers: headersOf(notes ?? ''),
    urls: urlsOf(note.notes_text ?? notes ?? ''),
    notes_are_long: noteLines.length >= LONG_NOTES_LINES,
    tags: tagsOf(note.notes),
    author_name: creator.name,
    author_company: creator.company,
    author_bio: myBio,
    author_colleagues: unique(colleagues.map(displayName)).join(', '),
    outside_attendees: unique(externals.map(displayName)).join(', '),
    outside_companies: unique(externals.map((p) => p.company || companyFromDomain(domainOf(p.email)))).join(', '),
    counterpart_name: joinAnd(unique(attendees.map(displayName))),
    counterpart_bio: attendees
      .map((p) => bioSentence(p, false))
      .filter(Boolean)
      .join('\n'),
    participants: [creator, ...attendees]
      .filter((p) => p.name || p.email)
      .map(participant)
      .join(', '),
    reader_name: creator.name,
    reader_bio: myBio,
    reader_company: creator.company,
    document_id: note.id,
    event_name: event?.summary?.trim() || note.title?.trim() || '',
    date: valid ? start.toLocaleDateString(locale, { ...dateFmt, ...(allDay ? { timeZone: 'UTC' } : zone ? { timeZone: zone } : {}) }) : '',
    time: valid && !allDay ? start.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', ...(zone ? { timeZone: zone } : {}) }) : '',
    current_date: (src.now ?? new Date()).toLocaleDateString(locale, dateFmt),
    latest_summary: '',
    is_shared_note: note.is_shared,
    from_mobile: false,
    is_multilingual: language === 'multi' || language === 'pt-BR',
    summary_in_english: !((language === 'multi' || language === 'pt-BR') && summaryLanguage !== 'en'),
    uses_british_spelling: british,
    custom_vocabulary: settings['asr.keywords'].map((k) => k.trim()).filter(Boolean).join(', '),
    author_is_investor: false
  }
}

function templateVars(template: Template, transcriptLength: number): Record<TemplateVariableName, string | number> {
  const first = template.sections[0]
  return {
    section_headings: template.sections.map((s) => `# ${s.heading}: ${s.description}`).join('\n'),
    lead_heading: first ? `# ${first.heading}` : '',
    template_description: template.description,
    template_name: template.title,
    heading_limit: maxNumHeadings(transcriptLength)
  }
}
