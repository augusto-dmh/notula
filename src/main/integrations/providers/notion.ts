// SPDX-License-Identifier: Apache-2.0
// Notion: a user token, a picked database (data source)
// or page, and one page per save, as markdown with a block-children fallback.

import { marked, type Token, type Tokens } from 'marked'
import { NOTION_VERSION, type IntegrationSearchResult } from '@shared/types/integrations'
import { log } from '../../log'
import { meetingStart, noteTitle } from '../content'
import { integrationsHttp, parseBody, type HttpInit } from '../http'
import { asString, failure, validationFailure, type ProviderClient, type SendOutcome } from './types'

const COPY = {
  network: 'Couldn’t reach Notion.',
  busy: 'Notion is busy. Try again in a minute.',
  other: 'Couldn’t save to Notion. Try again in a minute.',
  status: { 401: 'Your Notion token isn’t working. Update it in Settings.' }
}

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION }
}

const PACE: HttpInit['pace'] = { key: 'notion', intervalMs: 400 }

function plainTitle(v: unknown): string {
  return Array.isArray(v) ? v.map((t) => asString((t as Record<string, unknown>)['plain_text']) ?? '').join('').trim() : ''
}

// ---------- markdown → Notion blocks (fallback) ----------

type RichText = { type: 'text'; text: { content: string; link?: { url: string } }; annotations?: Record<string, boolean> }
type Block = Record<string, unknown> & { type: string }

function richText(tokens: Token[] | undefined, ann: Record<string, boolean> = {}, link?: string): RichText[] {
  const out: RichText[] = []
  const push = (content: string, a: Record<string, boolean>, url?: string): void => {
    for (let i = 0; i < content.length; i += 2_000) {
      out.push({ type: 'text', text: { content: content.slice(i, i + 2_000), ...(url ? { link: { url } } : {}) }, ...(Object.keys(a).length ? { annotations: a } : {}) })
    }
  }
  for (const t of tokens ?? []) {
    if (t.type === 'strong') out.push(...richText((t as Tokens.Strong).tokens, { ...ann, bold: true }, link))
    else if (t.type === 'em') out.push(...richText((t as Tokens.Em).tokens, { ...ann, italic: true }, link))
    else if (t.type === 'del') out.push(...richText((t as Tokens.Del).tokens, { ...ann, strikethrough: true }, link))
    else if (t.type === 'codespan') push((t as Tokens.Codespan).text, { ...ann, code: true }, link)
    else if (t.type === 'link') {
      const href = (t as Tokens.Link).href
      out.push(...richText((t as Tokens.Link).tokens, ann, /^https?:/i.test(href) ? href : link))
    } else if (t.type === 'image') push('[image]', ann, link)
    else if (t.type === 'br') push('\n', ann, link)
    else if ('tokens' in t && Array.isArray(t.tokens)) out.push(...richText(t.tokens, ann, link))
    else if ('text' in t && typeof t.text === 'string') push(t.text, ann, link)
  }
  return out.slice(0, 100)
}

function block(type: string, body: Record<string, unknown>): Block {
  return { object: 'block', type, [type]: body }
}

function listBlocks(list: Tokens.List, depth: number): Block[] {
  return list.items.map((item) => {
    const type = item.task ? 'to_do' : list.ordered ? 'numbered_list_item' : 'bulleted_list_item'
    const text: RichText[] = []
    const children: Block[] = []
    for (const t of item.tokens) {
      if (t.type === 'list') {
        if (depth < 2) children.push(...listBlocks(t as Tokens.List, depth + 1))
        else text.push({ type: 'text', text: { content: ` ${(t as Tokens.List).items.map((i) => i.text).join('; ')}` } })
      } else if (t.type === 'text' || t.type === 'paragraph') text.push(...richText((t as Tokens.Text).tokens ?? [{ type: 'text', raw: (t as Tokens.Text).text, text: (t as Tokens.Text).text } as Token]))
    }
    return block(type, { rich_text: text.slice(0, 100), ...(item.task ? { checked: item.checked === true } : {}), ...(children.length ? { children } : {}) })
  })
}

export function markdownToNotionBlocks(md: string): Block[] {
  const out: Block[] = []
  for (const t of marked.lexer(md, { gfm: true })) {
    switch (t.type) {
      case 'heading': {
        const h = t as Tokens.Heading
        out.push(block(`heading_${Math.min(3, h.depth)}`, { rich_text: richText(h.tokens) }))
        break
      }
      case 'paragraph':
        out.push(block('paragraph', { rich_text: richText((t as Tokens.Paragraph).tokens) }))
        break
      case 'list':
        out.push(...listBlocks(t as Tokens.List, 0))
        break
      case 'blockquote':
        out.push(block('quote', { rich_text: richText((t as Tokens.Blockquote).tokens.flatMap((c) => ('tokens' in c && Array.isArray(c.tokens) ? c.tokens : []))) }))
        break
      case 'code': {
        const c = t as Tokens.Code
        out.push(block('code', { rich_text: richText([{ type: 'text', raw: c.text, text: c.text } as Token]), language: 'plain text' }))
        break
      }
      case 'hr':
        out.push(block('divider', {}))
        break
      case 'table':
        out.push(block('paragraph', { rich_text: [{ type: 'text', text: { content: '[table]' } }] }))
        break
      case 'space':
        break
      default:
        if ('text' in t && typeof t.text === 'string' && t.text.trim()) out.push(block('paragraph', { rich_text: [{ type: 'text', text: { content: t.text.slice(0, 2_000) } }] }))
    }
  }
  return out
}

// ---------- the client ----------

function notionError(status: number, code: string, target: string): Extract<SendOutcome, { ok: false }> {
  if (status === 401) return { ok: false, retry: 'never', code: code || 'unauthorized', message: COPY.status[401] }
  if (status === 403) return { ok: false, retry: 'never', code: code || 'restricted_resource', message: `Notula can’t write to ${target}. Share it with your connection or check your access.` }
  if (status === 404) {
    return { ok: false, retry: 'never', code: code || 'object_not_found', message: 'The Notion page or database Notula saves to wasn’t found. Pick another in Settings.', disconnect: true }
  }
  if (status === 400 || status === 413) return { ok: false, retry: 'never', code: code || 'validation_error', message: 'Notion couldn’t accept this note.' }
  return { ok: false, retry: 'never', code: code || `http_${status}`, message: COPY.other }
}

export const notion: ProviderClient = {
  id: 'notion',

  async validate(_ctx, token) {
    const r = await integrationsHttp.fetch('https://api.notion.com/v1/users/me', { kind: 'read', headers: headers(token), pace: PACE })
    if (!r.ok) return validationFailure(r, 'Notion didn’t accept this token.', 'Couldn’t reach Notion.')
    const body = parseBody(r.text)
    const bot = (body['bot'] ?? {}) as Record<string, unknown>
    const owner = ((bot['owner'] ?? {}) as Record<string, unknown>)['user'] as Record<string, unknown> | undefined
    return { state: 'connected', accountLabel: asString(bot['workspace_name']) ?? asString(owner?.['name']) ?? asString(body['name']) ?? 'Notion', detail: null }
  },

  async search(_ctx, q, token): Promise<IntegrationSearchResult[]> {
    const results: IntegrationSearchResult[] = []
    for (const value of ['data_source', 'page'] as const) {
      const r = await integrationsHttp.fetch('https://api.notion.com/v1/search', {
        kind: 'read',
        method: 'POST',
        headers: headers(token),
        json: {
          ...(q.query?.trim() ? { query: q.query.trim().slice(0, 200) } : {}),
          filter: { property: 'object', value },
          sort: { timestamp: 'last_edited_time', direction: 'descending' },
          page_size: 20
        },
        pace: PACE
      })
      if (!r.ok) throw new Error(r.kind === 'http' ? `http_${r.status}` : r.kind)
      const body = parseBody(r.text)
      for (const item of Array.isArray(body['results']) ? (body['results'] as Record<string, unknown>[]) : []) {
        const id = asString(item['id'])
        if (!id) continue
        const props = (item['properties'] ?? null) as Record<string, Record<string, unknown>> | null
        let label = plainTitle(item['title'])
        let titleProperty: string | null = null
        const dateProperties: string[] = []
        for (const [name, p] of Object.entries(props ?? {})) {
          if (p?.['type'] === 'title') {
            titleProperty = name
            if (!label) label = plainTitle(p['title'])
          }
          if (p?.['type'] === 'date') dateProperties.push(name)
        }
        // A data source without its schema is saved to as a page parent.
        const kind = value === 'data_source' && titleProperty ? 'data_source' : 'page'
        results.push({
          provider: 'notion',
          kind,
          id,
          label: label || 'Untitled',
          subtitle: kind === 'data_source' ? 'Database' : 'Page',
          suggested: false,
          extra: { url: asString(item['url']), titleProperty, dateProperties: dateProperties.join('\n') }
        })
      }
    }
    return results
  },

  async send(_ctx, job): Promise<SendOutcome> {
    const dest = job.destination
    if (!dest || !dest.externalId) return { ok: false, retry: 'never', code: 'no_target', message: 'Pick where Notula saves notes in Settings.' }
    if (!job.credential) return { ok: false, retry: 'never', code: 'unauthorized', message: COPY.status[401] }
    const title = noteTitle(job.note).slice(0, 2_000)
    const isDb = dest.options.notionTargetType === 'data_source'
    const properties: Record<string, unknown> = isDb
      ? {
          [dest.options.notionTitleProperty || 'Name']: { title: [{ type: 'text', text: { content: title } }] },
          ...(dest.options.notionDateProperty ? { [dest.options.notionDateProperty]: { date: { start: meetingStart(job.note) } } } : {})
        }
      : { title: { title: [{ type: 'text', text: { content: title } }] } }
    const parent = isDb ? { type: 'data_source_id', data_source_id: dest.externalId } : { type: 'page_id', page_id: dest.externalId }
    const create = (extra: Record<string, unknown>): ReturnType<typeof integrationsHttp.fetch> =>
      integrationsHttp.fetch('https://api.notion.com/v1/pages', {
        kind: 'write',
        method: 'POST',
        headers: headers(job.credential ?? ''),
        json: { parent, properties, ...extra },
        pace: PACE
      })
    const conflictRetry = async (extra: Record<string, unknown>): ReturnType<typeof integrationsHttp.fetch> => {
      const r = await create(extra)
      return !r.ok && r.kind === 'http' && r.status === 409 ? create(extra) : r
    }
    let r = await conflictRetry({ markdown: job.content.markdown || job.content.text })
    let rest: Block[] = []
    if (!r.ok && r.kind === 'http' && (r.status === 400 || r.status === 413) && asString(parseBody(r.text)['code']) !== 'object_not_found') {
      // Content-caused rejection → block children, 100 at creation, then appends.
      log('info', 'integrations:notion-fallback', { deliveryId: job.delivery.id, status: r.status, code: asString(parseBody(r.text)['code']) })
      const blocks = markdownToNotionBlocks(job.content.markdown || job.content.text)
      rest = blocks.slice(100)
      r = await conflictRetry({ children: blocks.slice(0, 100) })
    }
    if (!r.ok) {
      if (r.kind === 'http' && r.status !== 429 && r.status < 500) return notionError(r.status, asString(parseBody(r.text)['code']) ?? '', dest.label)
      return failure(r, COPY)
    }
    const body = parseBody(r.text)
    const pageId = asString(body['id'])
    const url = asString(body['url'])
    for (let i = 0; pageId && i < rest.length; i += 100) {
      const a = await integrationsHttp.fetch('https://api.notion.com/v1/blocks/{id}/children', {
        kind: 'write',
        method: 'PATCH',
        params: { id: pageId },
        headers: headers(job.credential),
        json: { children: rest.slice(i, i + 100) },
        pace: PACE
      })
      if (!a.ok) {
        // The page exists; say so rather than create a second one on retry.
        log('warn', 'integrations:notion-append-failed', { deliveryId: job.delivery.id, status: a.kind === 'http' ? a.status : a.kind })
        return { ok: true, externalId: pageId, externalUrl: url }
      }
    }
    return { ok: true, externalId: pageId, externalUrl: url && /^https:\/\//.test(url) ? url : null }
  }
}
