// SPDX-License-Identifier: Apache-2.0
// Transcription rules: ask, warn or block before Notula takes notes
// Rules are the user's own.

export type RuleAction = 'confirm' | 'override' | 'block'

export type RuleCondition =
  | { type: 'always' }
  | { type: 'has_outside_guest' }
  | { type: 'internal_only' }
  | { type: 'guest_domain'; domains: string[] }
  | { type: 'guest_email'; emails: string[] }
  | { type: 'in_person' }
  | { type: 'event_name'; match: 'contains'; strings: string[] }
  /** Kept, never matches (guest_group, consent_page_absent, unknown types). */
  | { type: string; [field: string]: unknown }

export interface TranscriptionRule {
  id: string
  enabled: boolean
  action: RuleAction
  condition: RuleCondition
  presentation: { text: string | null; link: { label: string; url: string } | null }
}

export interface RuleDecision {
  noteId: string
  outcome: 'allow' | 'confirm' | 'block'
  decisionKey: string
  phase: 'start' | 'runtime'
  matchedRuleIds: string[]
  presentation: TranscriptionRule['presentation'][]
}

export const TRANSCRIPTION_RULES_LIMITS = {
  maxRules: 50,
  messageMax: 500,
  linkLabelMax: 100,
  urlMax: 2_000,
  runtimeCheckMs: 600_000,
  jitterMs: 5_000,
  firstResultWaitMs: 3_000,
  runtimeGraceMs: 3_000,
  eventGraceStartMs: 120_000,
  eventGraceEndMs: 300_000
} as const

/** The action labels, the rule list's sentences and badges, and the default texts. */
export const RULE_LABELS = {
  actions: { confirm: 'Ask before transcribing', override: 'Allow override', block: 'Block' },
  badges: { confirm: 'Ask first', override: 'Warn, allow override', block: 'Never take notes' },
  sentences: {
    always: 'In every meeting',
    in_person: 'In in-person meetings',
    has_outside_guest: 'When anyone from outside your company joins',
    internal_only: 'When every participant is from your company',
    guest_domain: 'When a participant is from:',
    guest_email: 'When the meeting includes:',
    guest_group: 'When a participant belongs to:',
    event_name: 'When the meeting title contains:'
  },
  /** `<lead>` below: `Check before transcribing` for a confirm, `Don't transcribe` otherwise. */
  leads: { confirm: 'Check before transcribing', other: "Don't transcribe" },
  defaultTexts: {
    always: 'Check before transcribing every meeting',
    has_outside_guest: '<lead> meetings with external participants',
    internal_only: '<lead> internal-only meetings',
    guest_domain: '<lead> meetings with people from these domains',
    guest_email: '<lead> meetings with restricted participants',
    guest_group: '<lead> meetings with members of these groups',
    in_person: '<lead> in-person meetings',
    consent_page_absent: '<lead> meetings without a consent page. Notula doesn’t apply this rule yet.',
    event_name: '<lead> meetings whose title contains these words'
  }
} as const

/** The decision dialog kinds and their copy. */
export const RULE_DIALOG_COPY = {
  headerOne: 'You set the following rule:',
  headerMany: 'You set the following rules:',
  concurrentLine: 'This applies because “<title>” is on your calendar right now.',
  concurrentLineNoTitle: 'This applies because of an event on your calendar now.',
  block: {
    titleActive: "Notula stopped transcribing",
    title: "Notula won’t transcribe this meeting",
    description: 'This meeting matches one of your transcription rules.',
    decline: 'Got it'
  },
  override: {
    title: 'Your rules say not to use Notula here',
    description: 'This meeting matches a rule. Continue only if you’re sure it’s allowed.',
    decline: "Don't take notes",
    confirm: 'Override and continue'
  },
  confirm: {
    titleAlways: 'Confirm before using Notula',
    title: 'Use Notula in this meeting?',
    description: 'By starting Notula you confirm this meeting is OK to record under your rules.',
    decline: "Don't take notes",
    confirm: 'Start Notula'
  }
} as const
