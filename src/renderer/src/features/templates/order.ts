// SPDX-License-Identifier: Apache-2.0
// Template order, groups, frecency and search. Built-ins are the shipped catalog in its default
// order; every other template in the list is the user's own (no team sharing).

import Fuse from 'fuse.js'
import { BUILTIN_TEMPLATE_IDS, TEMPLATE_QUICK_PICKS, type NoteTemplate } from '@shared/types/templates'

/** The default order of the built-ins. */
const BUILTIN_ORDER: readonly string[] = Object.values(BUILTIN_TEMPLATE_IDS)
const OTHER = 'Other'

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

export function displayTitle(t: Pick<NoteTemplate, 'title'>): string {
  return t.title.trim() || 'Untitled template'
}

export function isEditable(t: NoteTemplate): boolean {
  return !t.is_builtin
}

function byTitle(a: NoteTemplate, b: NoteTemplate): number {
  return collator.compare(displayTitle(a), displayTitle(b)) || a.created_at.localeCompare(b.created_at)
}

function builtinRank(t: NoteTemplate): number {
  const i = BUILTIN_ORDER.indexOf(t.id)
  return i === -1 ? BUILTIN_ORDER.length : i
}

export interface TemplateGroup {
  id: string
  /** null for the first group ("My templates" has its own heading). */
  heading: string
  templates: NoteTemplate[]
}

/**
 * "My templates" (own and favourites, by title), then the built-ins that
 * are not favourites, grouped by category in catalog order, "Other" last.
 */
export function galleryGroups(templates: NoteTemplate[], favorites: readonly string[]): TemplateGroup[] {
  const fav = new Set(favorites)
  const mine = templates.filter((t) => !t.is_builtin || fav.has(t.id)).sort(byTitle)
  const rest = templates.filter((t) => t.is_builtin && !fav.has(t.id)).sort((a, b) => builtinRank(a) - builtinRank(b))
  const groups: TemplateGroup[] = []
  if (mine.length) groups.push({ id: 'mine', heading: 'My templates', templates: mine })
  const byCategory = new Map<string, NoteTemplate[]>()
  for (const t of rest) {
    const c = t.category?.trim() || OTHER
    const list = byCategory.get(c) ?? []
    list.push(t)
    byCategory.set(c, list)
  }
  const categories = [...byCategory.keys()].filter((c) => c !== OTHER)
  if (byCategory.has(OTHER)) categories.push(OTHER)
  for (const c of categories) groups.push({ id: `category:${c}`, heading: c, templates: byCategory.get(c) ?? [] })
  return groups
}

/** Mine and favourites first, then the built-ins in their fixed order. */
export function defaultOrder(templates: NoteTemplate[], favorites: readonly string[]): NoteTemplate[] {
  const fav = new Set(favorites)
  const first = templates.filter((t) => !t.is_builtin || fav.has(t.id)).sort(byTitle)
  const rest = templates.filter((t) => t.is_builtin && !fav.has(t.id)).sort((a, b) => builtinRank(a) - builtinRank(b))
  return [...first, ...rest]
}

/** The recent-use score. */
export function frecency(uses: readonly string[] | undefined, now = Date.now()): number {
  const HOUR = 3_600_000
  let score = 0
  for (const u of uses ?? []) {
    const age = now - Date.parse(u)
    if (!Number.isFinite(age)) continue
    if (age < 4 * HOUR) score += 100
    else if (age < 24 * HOUR) score += 80
    else if (age < 3 * 24 * HOUR) score += 60
    else if (age < 7 * 24 * HOUR) score += 40
    else if (age < 30 * 24 * HOUR) score += 20
    else if (age < 90 * 24 * HOUR) score += 10
  }
  return score
}

/**
 * Every visible template ranked by recent use, ties in the default
 * order; the top 5, with the current template in front when it is not among them.
 */
export function quickPicks(
  templates: NoteTemplate[],
  favorites: readonly string[],
  usage: Record<string, string[]>,
  currentId: string | null,
  now = Date.now()
): NoteTemplate[] {
  const ordered = defaultOrder(templates, favorites)
  const rank = new Map(ordered.map((t, i) => [t.id, i]))
  const scored = ordered
    .map((t) => ({ t, score: frecency(usage[t.id], now) }))
    .sort((a, b) => b.score - a.score || (rank.get(a.t.id) ?? 0) - (rank.get(b.t.id) ?? 0))
    .map((x) => x.t)
  const top = scored.slice(0, TEMPLATE_QUICK_PICKS)
  const current = currentId ? templates.find((t) => t.id === currentId) : undefined
  if (current && !top.some((t) => t.id === current.id)) return [current, ...top]
  return top
}

/** Fuzzy over title (0.7) and description (0.3), threshold 0.3. */
export function searchTemplates(templates: NoteTemplate[], query: string, limit?: number): NoteTemplate[] {
  const q = query.trim()
  if (!q) return templates
  const fuse = new Fuse(templates, {
    keys: [
      { name: 'title', weight: 0.7 },
      { name: 'description', weight: 0.3 }
    ],
    threshold: 0.3,
    ignoreLocation: true
  })
  const hits = fuse.search(q).map((r) => r.item)
  return limit === undefined ? hits : hits.slice(0, limit)
}
