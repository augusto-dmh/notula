// SPDX-License-Identifier: Apache-2.0
// People tools: findPeopleOrCompanies, findPeople and resolvePerson over the local people
// derivation. No Gmail or Slack: those sources report `not_connected`.
// The local source is labelled `notula`; Notula's UI never shows it.

import type { CompanyRow, PersonRow } from '@shared/types/people'
import { companyName, isGenericDomain } from '@shared/lib/people'
import type { MainContext } from '../context'
import { bound, okJson, type LocalTool } from './tools'

const DAY_MS = 86_400_000
const SOURCE_STATUS = { notula: 'ok', gmail: 'not_connected', slack: 'not_connected' } as const

type Quality = 'exact' | 'strong' | 'partial'

interface Match {
  score: number
  field: 'email' | 'name' | 'domain'
  value: string
  quality: Quality
}

/** How well `value` matches `query` (case-insensitive): exact, a prefix of the value or a word, or contained. */
function matchText(query: string, value: string, field: Match['field']): Match | null {
  const q = query.trim().toLowerCase()
  const v = value.trim().toLowerCase()
  if (!q || !v) return null
  if (v === q) return { score: 1, field, value, quality: 'exact' }
  if (v.startsWith(q)) return { score: 0.85, field, value, quality: 'strong' }
  if (v.split(/[\s.@_-]+/).some((w) => w.startsWith(q))) return { score: 0.75, field, value, quality: 'strong' }
  // Every word of a multi-word query, in any order ("Doe Jane").
  const words = q.split(/\s+/).filter(Boolean)
  if (words.length > 1 && words.every((w) => v.includes(w))) return { score: 0.7, field, value, quality: 'strong' }
  if (v.includes(q)) return { score: 0.5, field, value, quality: 'partial' }
  return null
}

function best(...ms: (Match | null)[]): Match | null {
  return ms.reduce<Match | null>((b, m) => (m && (!b || m.score > b.score) ? m : b), null)
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const first = words[0]?.[0] ?? ''
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : ''
  return (first + last).toUpperCase()
}

async function scope(ctx: MainContext): Promise<{ myEmails: string[]; genericDomains: string[] }> {
  const [myEmails, genericDomains] = await Promise.all([
    ctx.calendar.myEmails().catch(() => [] as string[]),
    ctx.settings.get('people.genericEmailDomains').catch(() => [] as string[])
  ])
  return { myEmails, genericDomains }
}

function personMatch(query: string, p: PersonRow): Match | null {
  return best(matchText(query, p.email ?? '', 'email'), matchText(query, p.name, 'name'))
}

async function rankedPeople(ctx: MainContext, query: string): Promise<{ p: PersonRow; m: Match }[]> {
  const s = await scope(ctx)
  const people = await ctx.storage.listPeople({ filter: 'all', myEmails: s.myEmails })
  return people
    .map((p) => ({ p, m: personMatch(query, p) }))
    .filter((x): x is { p: PersonRow; m: Match } => !!x.m)
    .sort((a, b) => b.m.score - a.m.score || b.p.lastSeenAt.localeCompare(a.p.lastSeenAt))
}

const queryArgs = {
  query: { type: 'string', minLength: 1, maxLength: 200, description: 'A name, email address, company or domain, or part of one.' },
  limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many results to return at most (default 10).' }
}

const findPeopleOrCompanies: LocalTool = {
  def: {
    name: 'findPeopleOrCompanies',
    description:
      "Searches the people and companies the user has met, from their meetings and calendar. " +
      'Returns each match with emails, company, role when known and how many meetings they share.',
    inputSchema: { type: 'object', properties: queryArgs, required: ['query'], additionalProperties: false }
  },
  category: 'search',
  title: 'Search people and companies',
  needsApproval: false,
  readOnly: true,
  available: () => true,
  run: async (args, env) => {
    const query = String(args['query'] ?? '')
    const limit = bound(args['limit'], 10, 50)
    const s = await scope(env.ctx)
    const people = await rankedPeople(env.ctx, query)
    const companies = (await env.ctx.storage.listCompanies({ filter: 'all', ...s }))
      .map((c) => ({ c, m: best(matchText(query, c.name, 'name'), matchText(query, c.domain, 'domain')) }))
      .filter((x): x is { c: CompanyRow; m: Match } => !!x.m)
    const entities = [
      ...people.map(({ p, m }) => ({
        rank: m.score,
        at: p.lastSeenAt,
        entity: {
          kind: 'person',
          name: p.name,
          email: p.email,
          company: p.domain && !isGenericDomain(p.domain, s.genericDomains) ? companyName(p.domain) : null,
          domain: p.domain,
          title: null
        }
      })),
      ...companies.map(({ c, m }) => ({
        rank: m.score,
        at: c.lastSeenAt,
        entity: { kind: 'company', name: c.name, email: null, company: c.name, domain: c.domain, title: null }
      }))
    ]
      .sort((a, b) => b.rank - a.rank || b.at.localeCompare(a.at))
      .slice(0, limit)
      .map((x) => x.entity)
    return okJson({ query, entities })
  }
}

const findPeople: LocalTool = {
  def: {
    name: 'findPeople',
    description: "Finds people the user has met by name or email, with their emails, company and latest meetings.",
    inputSchema: { type: 'object', properties: queryArgs, required: ['query'], additionalProperties: false }
  },
  category: 'search',
  title: 'Find people',
  needsApproval: false,
  readOnly: true,
  available: () => true,
  run: async (args, env) => {
    const query = String(args['query'] ?? '')
    const people = (await rankedPeople(env.ctx, query)).slice(0, bound(args['limit'], 10, 50))
    return okJson({
      people: people.map(({ p, m }) => ({
        name: p.name,
        email: p.email,
        slackUserIds: [],
        slackHandles: [],
        sources: ['notula'],
        lastInteractionAt: p.lastSeenAt,
        signals: [],
        matchedOn: m.field,
        matchQuality: m.quality,
        derivedInitials: initials(p.name)
      })),
      sourceStatus: SOURCE_STATUS
    })
  }
}

/** 0–1: more shared notes and a more recent one score higher. */
function interactionScore(count: number, lastAt: string): number {
  const volume = Math.min(1, Math.log10(1 + count) / 2)
  const days = (Date.now() - Date.parse(lastAt)) / DAY_MS
  const recency = Number.isFinite(days) ? Math.max(0, 1 - days / 365) : 0
  return Math.round((volume * 0.6 + recency * 0.4) * 100) / 100
}

const resolvePerson: LocalTool = {
  def: {
    name: 'resolvePerson',
    description:
      "Resolves a name as the user wrote it (\"Dana\", \"the person from Acme\") to the one person it most likely means, with their email, " +
      'or lists the candidates when it is ambiguous.',
    inputSchema: { type: 'object', properties: queryArgs, required: ['query'], additionalProperties: false }
  },
  category: 'search',
  title: 'Resolve a person',
  needsApproval: false,
  readOnly: true,
  available: () => true,
  run: async (args, env) => {
    const query = String(args['query'] ?? '')
    const people = (await rankedPeople(env.ctx, query)).slice(0, bound(args['limit'], 10, 50))
    return okJson({
      people: people.map(({ p, m }) => {
        const interaction = interactionScore(p.count, p.lastSeenAt)
        return {
          name: p.name,
          email: p.email,
          slackUserIds: [],
          slackHandles: [],
          title: null,
          interactions: [{ kind: 'meeting', source: 'notula', count: p.count, lastAt: p.lastSeenAt }],
          matches: [{ query, kind: 'person', source: 'notula', field: m.field, value: m.value, quality: m.quality }],
          score: { relevance: m.score, interaction, total: Math.round((m.score * 0.7 + interaction * 0.3) * 100) / 100 },
          isSelf: p.isSelf
        }
      }),
      sourceStatus: SOURCE_STATUS
    })
  }
}

export const PEOPLE_TOOLS: readonly LocalTool[] = [findPeopleOrCompanies, findPeople, resolvePerson]
