// SPDX-License-Identifier: Apache-2.0
// The one-time notice and the participant texts: `speakers:dismiss-notice`,
// `speakers:participant-notice` (with the provider sentence) and `speakers:add-chat-notice-line`
// (appends the sentence to `consent.message` once, from the default when it is empty).
//
// - The texts come from `@shared/lib/speaker-notices`; `<contact>` is never filled here.
// - The provider sentence is added while names from the conversation would reach a cloud LLM:
//   `speakerNames.suggestions` on, local-only mode not blocking it, and a provider that isn't a
//   local model on a loopback host.
// - The chat line is only ever added on the user's tap; the message stays theirs to edit.
// - Locked: refused by the IPC guard like every `speakers:*` invoke.

import { ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes } from '@shared/ipc'
import { CHAT_NOTICE_SENTENCE, CHAT_NOTICE_SENTENCE_NO_APPS, participantNotice } from '@shared/lib/speaker-notices'
import { CONSENT_DEFAULT_MESSAGE, CONSENT_LIMITS } from '@shared/types/consent'
import type { Settings } from '@shared/types/settings'
import type { SpeakerNoticeLanguage } from '@shared/types/speakers'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { isLoopbackUrl } from '../net/loopback'
import { egressBlocked } from '../privacy'

function language(req: unknown): SpeakerNoticeLanguage {
  const v = typeof req === 'object' && req !== null ? (req as { language?: unknown }).language : undefined
  if (v !== 'en' && v !== 'pt') throw expected(notulaError('invalid-input', 'language is invalid.'))
  return v
}

function host(url: string): string | null {
  try {
    return new URL(url).hostname || null
  } catch {
    return null
  }
}

/** The cloud provider's display name, or null for a local model on this machine. */
function cloudProviderName(s: Settings): string | null {
  switch (s['llm.provider']) {
    case 'anthropic':
      return 'Anthropic'
    case 'openai': {
      const h = host(s['llm.openai.baseUrl'])
      return !h || h === 'api.openai.com' ? 'OpenAI' : h
    }
    case 'local':
      return isLoopbackUrl(s['llm.local.baseUrl']) ? null : host(s['llm.local.baseUrl'])
    default:
      return 'Anthropic'
  }
}

/**
 * The LLM step would reach a cloud provider now: not a model on this machine, and local-only mode
 * doesn't pause it. The participant notice's rule, for Settings' transfer note.
 */
export async function llmReachesCloud(ctx: MainContext): Promise<boolean> {
  return cloudProviderName(await ctx.settings.getAll()) !== null && !(await egressBlocked(ctx, { kind: 'llm' }))
}

/** The meeting-app readers run on Windows only (`AttributionService.supported`), so elsewhere the texts don't claim them. */
const MEETING_APPS = process.platform === 'win32'

async function noticeProvider(ctx: MainContext): Promise<string | null> {
  const s = await ctx.settings.getAll()
  if (!s['speakerNames.suggestions']) return null
  // Local-only mode skips the step with a cloud provider: nothing reaches it.
  if (await egressBlocked(ctx, { kind: 'llm' })) return null
  return cloudProviderName(s)
}

async function addChatNoticeLine(ctx: MainContext, lang: SpeakerNoticeLanguage): Promise<InvokeRes<'speakers:add-chat-notice-line'>> {
  const stored = (await ctx.settings.get('consent.message')).trim()
  const base = stored || CONSENT_DEFAULT_MESSAGE
  const sentence = (MEETING_APPS ? CHAT_NOTICE_SENTENCE : CHAT_NOTICE_SENTENCE_NO_APPS)[lang]
  if (base.includes(sentence)) {
    log('debug', 'speakers:chat-notice-line-present', { language: lang })
    return { ok: true }
  }
  const next = `${base} ${sentence}`
  if (next.length > CONSENT_LIMITS.messageMax) {
    log('info', 'speakers:chat-notice-line-too-long', { language: lang, length: next.length })
    return { ok: false }
  }
  await ctx.settings.set('consent.message', next)
  log('info', 'speakers:chat-notice-line-added', { language: lang, fromDefault: !stored })
  return { ok: true }
}

export function registerSpeakerNotice(ctx: MainContext): void {
  ipcMain.handle('speakers:dismiss-notice' satisfies InvokeChannel, async (): Promise<InvokeRes<'speakers:dismiss-notice'>> => {
    await ctx.settings.set('speakers.noticeSeen', true)
    log('info', 'speakers:notice-dismissed', {})
    return { ok: true }
  })
  ipcMain.handle(
    'speakers:participant-notice' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'speakers:participant-notice'>): Promise<InvokeRes<'speakers:participant-notice'>> => {
      const lang = language(req)
      return { text: participantNotice(lang, await noticeProvider(ctx), MEETING_APPS) }
    }
  )
  ipcMain.handle(
    'speakers:add-chat-notice-line' satisfies InvokeChannel,
    (_e, req: InvokeReq<'speakers:add-chat-notice-line'>): Promise<InvokeRes<'speakers:add-chat-notice-line'>> => addChatNoticeLine(ctx, language(req))
  )
}
