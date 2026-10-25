// SPDX-License-Identifier: Apache-2.0
// The app-category table: the foreground process name
// and, for browsers, the window title, give a category (styles) and a target hint (the
// formatter: email layout, chat brevity, no style in terminals).
//
// The destination table runs after it and changes only the hint (AI prompts, code editors,
// documents); the category, and so the style, stays the app table's. At release, `finalHint`
// narrows the hint with the focused field: secure input, single-line controls, email fields.

import type { DictationCategory, DictationTargetHint } from '@shared/types/dictation'
import type { DeskContext } from './desk'

export interface Target {
  category: DictationCategory
  hint: DictationTargetHint | null
  /** A display name for the context block and the keyterm exclusion. */
  app: string
  site: string | null
}

const BROWSERS = ['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'arc', 'safari', 'google chrome', 'microsoft edge', 'chromium']

/** process (lower-case, no extension) → [category, hint, display name] */
const APPS: Record<string, [DictationCategory, DictationTargetHint | null, string]> = {
  outlook: ['email', 'email', 'Outlook'],
  olk: ['email', 'email', 'Outlook'],
  'microsoft outlook': ['email', 'email', 'Outlook'],
  thunderbird: ['email', 'email', 'Thunderbird'],
  mail: ['email', 'email', 'Mail'],
  hxoutlook: ['email', 'email', 'Mail'],
  slack: ['work', 'chat', 'Slack'],
  teams: ['work', 'chat', 'Teams'],
  'ms-teams': ['work', 'chat', 'Teams'],
  'microsoft teams': ['work', 'chat', 'Teams'],
  notion: ['work', null, 'Notion'],
  linear: ['work', null, 'Linear'],
  whatsapp: ['casual', 'chat', 'WhatsApp'],
  telegram: ['casual', 'chat', 'Telegram'],
  signal: ['casual', 'chat', 'Signal'],
  messages: ['casual', 'chat', 'Messages'],
  discord: ['casual', 'chat', 'Discord'],
  windowsterminal: ['other', 'terminal', 'Windows Terminal'],
  powershell: ['other', 'terminal', 'PowerShell'],
  pwsh: ['other', 'terminal', 'PowerShell'],
  cmd: ['other', 'terminal', 'Command Prompt'],
  terminal: ['other', 'terminal', 'Terminal'],
  iterm2: ['other', 'terminal', 'iTerm2'],
  conhost: ['other', 'terminal', 'Console']
}

/** [title fragment, site, category, hint] for browser tabs; titles end with the site name. */
const SITES: [RegExp, string, DictationCategory, DictationTargetHint | null][] = [
  [/\bgmail\b|mail\.google\.com/i, 'mail.google.com', 'email', 'email'],
  [/outlook\.(live|office)\.com|\bOutlook\b/i, 'outlook.office.com', 'email', 'email'],
  [/\bSlack\b/, 'app.slack.com', 'work', 'chat'],
  [/Microsoft Teams/i, 'teams.microsoft.com', 'work', 'chat'],
  [/Google Docs/i, 'docs.google.com', 'work', null],
  [/\bNotion\b/, 'notion.so', 'work', null],
  [/\bLinear\b/, 'linear.app', 'work', null],
  [/\bJira\b/i, 'atlassian.net', 'work', null],
  [/\bConfluence\b/i, 'atlassian.net', 'work', null],
  [/WhatsApp/i, 'web.whatsapp.com', 'casual', 'chat'],
  [/Telegram/i, 'web.telegram.org', 'casual', 'chat'],
  [/\bDiscord\b/i, 'discord.com', 'casual', 'chat']
]

/** One destination: apps (process names), hosts, browser-title fragments, macOS bundle ids. */
interface Destination {
  hint: DictationTargetHint
  apps?: readonly string[]
  hosts?: readonly string[]
  titles?: RegExp
  bundles?: readonly string[]
}

/** First match wins. Windows exposes no browser URL, so tabs match on their title. */
const DESTINATIONS: readonly Destination[] = [
  {
    hint: 'ai-chat',
    apps: ['chatgpt', 'claude'],
    hosts: ['chatgpt.com', 'chat.openai.com', 'claude.ai', 'gemini.google.com', 'aistudio.google.com'],
    titles: /\b(?:ChatGPT|Claude|Gemini|Google AI Studio)\b/
  },
  { hint: 'code', apps: ['cursor', 'code', 'visual studio code', 'zed', 'xcode'] },
  {
    hint: 'document',
    apps: ['notion', 'obsidian', 'microsoft word', 'winword', 'notes', 'pages'],
    hosts: ['notion.so', 'notion.site'],
    bundles: ['com.apple.notes', 'notion.id', 'md.obsidian', 'com.microsoft.word', 'com.apple.iwork.pages']
  }
]

const hostOf = (h: string): string => h.toLowerCase().replace(/^www\./, '')

function destination(p: string, browser: boolean, title: string, host: string | null, bundle: string | null): DictationTargetHint | null {
  const h = host ? hostOf(host) : null
  const b = bundle?.toLowerCase() ?? null
  for (const d of DESTINATIONS) {
    if (d.apps?.includes(p)) return d.hint
    if (h && d.hosts?.some((x) => h === x || h.endsWith(`.${x}`))) return d.hint
    if (b && d.bundles?.includes(b)) return d.hint
    if (browser && d.titles?.test(title)) return d.hint
  }
  return null
}

/** `host` and `bundle` only when the helper reports them (macOS). */
export function classifyTarget(processName: string, title: string, host: string | null = null, bundle: string | null = null): Target {
  const p = processName.toLowerCase().replace(/\.exe$/, '').trim()
  const browser = BROWSERS.includes(p)
  const t = baseTarget(p, processName, title, browser)
  const hint = destination(p, browser, title, host, bundle)
  return hint ? { ...t, hint } : t
}

function baseTarget(p: string, processName: string, title: string, browser: boolean): Target {
  const fixed = APPS[p]
  if (fixed) return { category: fixed[0], hint: fixed[1], app: fixed[2], site: null }
  if (browser) {
    for (const [re, site, category, hint] of SITES) if (re.test(title)) return { category, hint, app: processName, site }
  }
  return { category: 'other', hint: null, app: processName, site: null }
}

const SINGLE_LINE_LABELS = new Set(['subject', 'search', 'search mail', 'search in mail', 'to', 'cc', 'bcc'])
const BODY_LABELS = new Set(['message body', 'message', 'body'])
// TODO(macOS): the helper reports no focused field yet; once it does, AXTextField,
// AXSearchField and AXComboBox are single-line and AXTextArea is multi-line.
const MAC_SINGLE = new Set(['AXTextField', 'AXSearchField', 'AXComboBox'])
const MAC_MULTI = new Set(['AXTextArea'])

type Field = NonNullable<DeskContext['field']>

const labelOf = (f: Field): string => f.name.trim().toLowerCase().replace(/:$/, '').trim()

/** UIA Edit is single-line only when the helper read `ES_MULTILINE` off; an unknown Edit is multi-line. */
function lineKind(f: Field): 'single' | 'multi' | null {
  if (f.type === 'ControlType.ComboBox' || MAC_SINGLE.has(f.type)) return 'single'
  if (f.type === 'ControlType.Edit') return f.multiline === false ? 'single' : 'multi'
  if (f.type === 'ControlType.Document' || MAC_MULTI.has(f.type)) return 'multi'
  return null
}

/**
 * The hint the formatter gets, from the start target and the focused field read at release
 * (null when there was no reading). The first rule that applies wins.
 */
export function finalHint(target: Target, field: DeskContext | null): DictationTargetHint | null {
  if (field?.result === 'secure_input' || field?.field?.password) return null
  const hint = target.hint
  if (hint === 'terminal') return 'terminal'
  const f = field?.field ?? null
  if (!f) return hint === 'email' ? null : hint
  const kind = lineKind(f)
  const label = labelOf(f)
  if (kind === 'single' || SINGLE_LINE_LABELS.has(label)) return 'single-line'
  if (hint === 'email' && kind !== 'multi' && !BODY_LABELS.has(label)) return null
  return hint
}
