// SPDX-License-Identifier: Apache-2.0
// The destination table: the foreground process name, a browser tab's title (Windows exposes no
// browser URL) or host, and macOS bundle ids give one of eight destinations. The destination
// picks the tone key (./format.ts `toneFor`) and the formatter's destination rules.
//
// At release, `finalTarget` reads the focused field: secure input drops the destination; a
// single-line control, or a field labelled like one, sets `singleLine`; an email app's
// address and subject lines are marked so a spelled-out address is joined.
// App names here only identify apps; nothing else names another product.

import type { DictationDestination } from '@shared/types/dictation'
import type { DeskContext } from './desk'

export interface Target {
  destination: DictationDestination
  /** A display name for the context block and the keyterm exclusion. */
  app: string
  site: string | null
}

/** What the formatter gets at release. */
export interface FinalTarget {
  destination: DictationDestination
  singleLine: boolean
  /** In an email app: the address lines, the subject, or the body. */
  emailField: 'address' | 'subject' | 'body' | null
}

const BROWSERS = ['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'arc', 'safari', 'google chrome', 'microsoft edge', 'chromium']

/** One destination: apps (process names, lower case, no `.exe`), hosts, browser-title fragments, macOS bundle ids. */
interface Row {
  destination: DictationDestination
  apps?: Record<string, string>
  hosts?: readonly string[]
  titles?: RegExp
  bundles?: readonly string[]
}

/** First match wins, so the narrow rows (AI chat, code) come before the broad ones. */
const TABLE: readonly Row[] = [
  {
    destination: 'ai-chat',
    apps: { chatgpt: 'ChatGPT', claude: 'Claude', 'microsoft copilot': 'Copilot', copilot: 'Copilot', perplexity: 'Perplexity' },
    hosts: ['chatgpt.com', 'chat.openai.com', 'claude.ai', 'gemini.google.com', 'aistudio.google.com', 'copilot.microsoft.com', 'perplexity.ai', 'chat.mistral.ai', 'poe.com'],
    titles: /\b(?:ChatGPT|Claude|Gemini|Google AI Studio|Copilot|Perplexity|Le Chat)\b/,
    bundles: ['com.openai.chat', 'com.anthropic.claudefordesktop', 'com.microsoft.copilot', 'ai.perplexity.mac']
  },
  {
    destination: 'terminal',
    apps: {
      windowsterminal: 'Windows Terminal',
      wt: 'Windows Terminal',
      powershell: 'PowerShell',
      pwsh: 'PowerShell',
      powershell_ise: 'PowerShell ISE',
      cmd: 'Command Prompt',
      conhost: 'Console',
      openconsole: 'Console',
      terminal: 'Terminal',
      iterm2: 'iTerm2',
      alacritty: 'Alacritty',
      wezterm: 'WezTerm',
      'wezterm-gui': 'WezTerm',
      kitty: 'kitty',
      warp: 'Warp',
      hyper: 'Hyper',
      tabby: 'Tabby',
      mintty: 'Git Bash',
      putty: 'PuTTY'
    },
    bundles: ['com.apple.terminal', 'com.googlecode.iterm2', 'dev.warp.warp-stable', 'io.alacritty', 'net.kovidgoyal.kitty', 'com.github.wez.wezterm']
  },
  {
    destination: 'code',
    apps: {
      code: 'Visual Studio Code',
      'code - insiders': 'Visual Studio Code',
      'visual studio code': 'Visual Studio Code',
      cursor: 'Cursor',
      windsurf: 'Windsurf',
      zed: 'Zed',
      xcode: 'Xcode',
      devenv: 'Visual Studio',
      idea64: 'IntelliJ IDEA',
      pycharm64: 'PyCharm',
      webstorm64: 'WebStorm',
      rider64: 'Rider',
      goland64: 'GoLand',
      clion64: 'CLion',
      phpstorm64: 'PhpStorm',
      studio64: 'Android Studio',
      'sublime_text': 'Sublime Text',
      'notepad++': 'Notepad++',
      vim: 'Vim',
      gvim: 'Vim',
      nvim: 'Neovim',
      emacs: 'Emacs'
    },
    hosts: ['github.dev', 'vscode.dev', 'codesandbox.io', 'stackblitz.com', 'replit.com'],
    bundles: ['com.microsoft.vscode', 'com.todesktop.230313mzl4w4u92', 'dev.zed.zed', 'com.apple.dt.xcode', 'com.jetbrains.intellij', 'com.sublimetext.4']
  },
  {
    destination: 'email',
    apps: { outlook: 'Outlook', olk: 'Outlook', 'microsoft outlook': 'Outlook', thunderbird: 'Thunderbird', hxoutlook: 'Mail', mail: 'Mail', mailspring: 'Mailspring', spark: 'Spark', 'em client': 'eM Client', mailclient: 'eM Client' },
    hosts: ['mail.google.com', 'outlook.office.com', 'outlook.live.com', 'outlook.office365.com', 'mail.yahoo.com', 'mail.proton.me', 'app.fastmail.com', 'app.hey.com'],
    titles: /\bGmail\b|\bOutlook\b|Proton Mail|Yahoo Mail|\bFastmail\b/i,
    bundles: ['com.apple.mail', 'com.microsoft.outlook', 'org.mozilla.thunderbird', 'com.readdle.smartemail-mac', 'com.mailspring.mailspring']
  },
  {
    destination: 'work-chat',
    apps: {
      slack: 'Slack',
      teams: 'Teams',
      'ms-teams': 'Teams',
      'microsoft teams': 'Teams',
      mattermost: 'Mattermost',
      'rocket.chat': 'Rocket.Chat',
      element: 'Element',
      zoom: 'Zoom',
      webex: 'Webex',
      googlechat: 'Google Chat'
    },
    hosts: ['app.slack.com', 'teams.microsoft.com', 'teams.live.com', 'chat.google.com', 'app.element.io', 'mattermost.com'],
    titles: /\bSlack\b|Microsoft Teams|Google Chat|\bMattermost\b/,
    bundles: ['com.tinyspeck.slackmacgap', 'com.microsoft.teams', 'com.microsoft.teams2', 'com.mattermost.desktop', 'im.riot.app']
  },
  {
    destination: 'personal-chat',
    apps: {
      whatsapp: 'WhatsApp',
      'whatsapp.root': 'WhatsApp',
      telegram: 'Telegram',
      signal: 'Signal',
      messages: 'Messages',
      discord: 'Discord',
      messenger: 'Messenger',
      skype: 'Skype',
      viber: 'Viber',
      line: 'LINE',
      wechat: 'WeChat',
      weixin: 'WeChat'
    },
    hosts: ['web.whatsapp.com', 'web.telegram.org', 'discord.com', 'messenger.com', 'www.messenger.com', 'web.skype.com', 'messages.google.com', 'instagram.com'],
    titles: /WhatsApp|\bTelegram\b|\bDiscord\b|\bMessenger\b|Google Messages|\bSignal\b/,
    bundles: ['net.whatsapp.whatsapp', 'ru.keepcoder.telegram', 'org.whispersystems.signal-desktop', 'com.apple.mobilesms', 'com.hnc.discord', 'com.facebook.archon']
  },
  {
    destination: 'document',
    apps: {
      winword: 'Word',
      'microsoft word': 'Word',
      obsidian: 'Obsidian',
      notion: 'Notion',
      onenote: 'OneNote',
      onenoteim: 'OneNote',
      evernote: 'Evernote',
      logseq: 'Logseq',
      typora: 'Typora',
      joplin: 'Joplin',
      soffice: 'LibreOffice',
      'soffice.bin': 'LibreOffice',
      wordpad: 'WordPad',
      notes: 'Notes',
      pages: 'Pages',
      bear: 'Bear',
      craft: 'Craft',
      notepad: 'Notepad'
    },
    hosts: ['docs.google.com', 'notion.so', 'notion.site', 'coda.io', 'quip.com', 'dropbox.com', 'office.com', 'sharepoint.com', 'atlassian.net', 'linear.app'],
    titles: /Google Docs|\bNotion\b|\bWord\b|\bConfluence\b|\bCoda\b|\bOneNote\b/,
    bundles: ['com.microsoft.word', 'md.obsidian', 'notion.id', 'com.apple.notes', 'com.apple.iwork.pages', 'net.shinyfrog.bear', 'com.microsoft.onenote.mac', 'com.evernote.evernote']
  }
]

const hostOf = (h: string): string => h.toLowerCase().replace(/^www\./, '')

/** `host` and `bundle` only when the helper reports them (macOS). */
export function classifyTarget(processName: string, title: string, host: string | null = null, bundle: string | null = null): Target {
  const p = processName.toLowerCase().replace(/\.exe$/, '').trim()
  const browser = BROWSERS.includes(p)
  const h = host ? hostOf(host) : null
  const b = bundle?.toLowerCase() ?? null
  for (const row of TABLE) {
    const name = row.apps?.[p]
    if (name) return { destination: row.destination, app: name, site: null }
    const site = h ? row.hosts?.find((x) => h === x || h.endsWith(`.${x}`)) : undefined
    if (site) return { destination: row.destination, app: processName, site }
    if (b && row.bundles?.includes(b)) return { destination: row.destination, app: processName, site: null }
  }
  // A tab title names its site last; check the narrow rows first, as above.
  if (browser) {
    for (const row of TABLE) if (row.titles?.test(title)) return { destination: row.destination, app: processName, site: null }
  }
  return { destination: 'other', app: processName, site: null }
}

const SINGLE_LINE_LABELS = new Set(['subject', 'search', 'search mail', 'search in mail', 'to', 'cc', 'bcc', 'add a subject', 'title'])
const ADDRESS_LABELS = new Set(['to', 'cc', 'bcc', 'from', 'recipients', 'add recipients'])
const SUBJECT_LABELS = new Set(['subject', 'add a subject'])
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
 * The destination and field the formatter gets, from the start target and the focused field
 * read at release (null when there was no reading). A terminal stays a terminal; a password
 * field drops to `other`.
 */
export function finalTarget(target: Target, field: DeskContext | null): FinalTarget {
  if (field?.result === 'secure_input' || field?.field?.password) return { destination: 'other', singleLine: true, emailField: null }
  const destination = target.destination
  const f = field?.field ?? null
  if (destination === 'terminal' || !f) return { destination, singleLine: false, emailField: null }
  const kind = lineKind(f)
  const label = labelOf(f)
  const singleLine = kind === 'single' || SINGLE_LINE_LABELS.has(label)
  let emailField: FinalTarget['emailField'] = null
  if (destination === 'email') {
    if (ADDRESS_LABELS.has(label)) emailField = 'address'
    else if (SUBJECT_LABELS.has(label)) emailField = 'subject'
    else if (kind === 'multi' || BODY_LABELS.has(label)) emailField = 'body'
  }
  return { destination, singleLine, emailField }
}
