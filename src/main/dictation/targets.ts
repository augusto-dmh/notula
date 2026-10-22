// SPDX-License-Identifier: Apache-2.0
// The app-category table: the foreground process name
// and, for browsers, the window title, give a category (styles) and a target hint (the
// formatter: email layout, chat brevity, no style in terminals).

import type { DictationCategory, DictationTargetHint } from '@shared/types/dictation'

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

export function classifyTarget(processName: string, title: string): Target {
  const p = processName.toLowerCase().replace(/\.exe$/, '').trim()
  const fixed = APPS[p]
  if (fixed) return { category: fixed[0], hint: fixed[1], app: fixed[2], site: null }
  if (BROWSERS.includes(p)) {
    for (const [re, site, category, hint] of SITES) if (re.test(title)) return { category, hint, app: processName, site }
  }
  return { category: 'other', hint: null, app: processName, site: null }
}
