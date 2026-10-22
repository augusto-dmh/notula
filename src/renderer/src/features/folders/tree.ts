// SPDX-License-Identifier: Apache-2.0
// Folder tree helpers: titles, the title order, the
// tree, use frecency and the sidebar's "top folders" picks.

import type { IsoTime } from '@shared/types/common'
import { FOLDER_LIMITS, type Folder } from '@shared/types/folders'
import type { FoldersView } from './store'

export const UNTITLED_FOLDER = 'Untitled folder'

export function folderTitle(f: Pick<Folder, 'title'> | null | undefined): string {
  return f?.title.trim() || UNTITLED_FOLDER
}

/** Title order ignoring case and accents. */
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

export function byTitle(a: Folder, b: Folder): number {
  return collator.compare(folderTitle(a), folderTitle(b)) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
}

/** The duplicate hint's rule: trimmed and case-insensitive. */
export function sameTitle(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

export function childrenOf(view: FoldersView, parentId: string | null): Folder[] {
  return view.folders.filter((f) => f.parent_id === parentId).sort(byTitle)
}

export function hasChildren(view: FoldersView, id: string): boolean {
  return view.folders.some((f) => f.parent_id === id)
}

/** The folder and its subfolders (two levels at most, but walked generally). */
export function subtree(view: FoldersView, id: string): Folder[] {
  const out: Folder[] = []
  const seen = new Set<string>()
  const walk = (fid: string): void => {
    if (seen.has(fid)) return
    seen.add(fid)
    const f = view.byId.get(fid)
    if (!f) return
    out.push(f)
    for (const c of view.folders) if (c.parent_id === fid) walk(c.id)
  }
  walk(id)
  return out
}

/** Parents from the top level down to the folder's parent. */
export function ancestors(view: FoldersView, id: string): Folder[] {
  const out: Folder[] = []
  const seen = new Set<string>([id])
  let cur = view.byId.get(id)?.parent_id ?? null
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const f = view.byId.get(cur)
    if (!f) break
    out.unshift(f)
    cur = f.parent_id
  }
  return out
}

export function noteCount(view: FoldersView, id: string): number {
  return view.membership[id]?.length ?? 0
}

// ---------- use frecency ----------

const HOUR = 3_600_000
const DAY = 24 * HOUR
const BANDS: readonly [number, number][] = [
  [4 * HOUR, 100],
  [DAY, 80],
  [3 * DAY, 60],
  [7 * DAY, 40],
  [30 * DAY, 20],
  [90 * DAY, 10]
]

function useScore(uses: readonly IsoTime[] | undefined, now: number): number {
  let score = 0
  for (const u of uses ?? []) {
    const age = now - Date.parse(u)
    if (Number.isNaN(age)) continue
    const band = BANDS.find(([limit]) => age < limit)
    score += band ? band[1] : 0
  }
  return score
}

/** The folder's own use score plus its descendants'. */
export function frecency(view: FoldersView, uses: Readonly<Record<string, IsoTime[]>>, id: string, now = Date.now()): number {
  return subtree(view, id).reduce((sum, f) => sum + useScore(uses[f.id], now), 0)
}

/**
 * The "Add to folder…" order: use frecency, then favourites, then note
 * count, then title.
 */
export function rankForAdding(view: FoldersView, uses: Readonly<Record<string, IsoTime[]>>, folders: Folder[]): Folder[] {
  const now = Date.now()
  const score = new Map(folders.map((f) => [f.id, useScore(uses[f.id], now)]))
  return [...folders].sort(
    (a, b) =>
      (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0) ||
      Number(b.is_favourite) - Number(a.is_favourite) ||
      noteCount(view, b.id) - noteCount(view, a.id) ||
      byTitle(a, b)
  )
}

/**
 * With at least 10 folders in a section, up to 5 "top" folders: up to 2 by
 * use frecency (score ≥ 300), the newest folder created in the last day, then by
 * activity (log2(notes + 1) × exp(−age / 14 days) on the last update, zero after 45
 * days; ties by note count, then last update), then by last update. Sorted by title.
 * Returns null below the threshold.
 */
export function topFolders(
  view: FoldersView,
  uses: Readonly<Record<string, IsoTime[]>>,
  folders: Folder[],
  now = Date.now()
): Folder[] | null {
  if (folders.length < FOLDER_LIMITS.topThreshold) return null
  const picks: Folder[] = []
  const add = (f: Folder | undefined): void => {
    if (f && picks.length < FOLDER_LIMITS.topFolders && !picks.includes(f)) picks.push(f)
  }
  const updated = (f: Folder): number => Date.parse(f.updated_at) || 0

  folders
    .map((f) => ({ f, score: frecency(view, uses, f.id, now) }))
    .filter((x) => x.score >= FOLDER_LIMITS.frecencyMinScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, FOLDER_LIMITS.frecencyPicks)
    .forEach((x) => add(x.f))

  add(
    folders
      .filter((f) => now - (Date.parse(f.created_at) || 0) < FOLDER_LIMITS.newFolderMs)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
  )

  const activity = (f: Folder): number => {
    const ageDays = (now - updated(f)) / DAY
    if (ageDays > FOLDER_LIMITS.activityCutoffDays) return 0
    return Math.log2(noteCount(view, f.id) + 1) * Math.exp(-Math.max(0, ageDays) / FOLDER_LIMITS.activityHalfLifeDays)
  }
  folders
    .map((f) => ({ f, score: activity(f) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || noteCount(view, b.f.id) - noteCount(view, a.f.id) || updated(b.f) - updated(a.f))
    .forEach((x) => add(x.f))

  ;[...folders].sort((a, b) => updated(b) - updated(a)).forEach(add)
  return picks.sort(byTitle)
}
