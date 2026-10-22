// SPDX-License-Identifier: Apache-2.0
// Company favorites: the setting `companies.favorites`,
// newest first, one entry per domain (lower-cased, trimmed). Shown while the Labs switch
// `companies.sidebarFavorites` is on.

import type { CompanyFavorite } from '@shared/types/people'
import { getPrefs, setPrefs } from '../settings/prefs-store'

/** The drag type of a folder's company row. */
export const COMPANY_FAVORITE_MIME = 'application/x-notula-company-favorite'

const MAX = 200

export function favorites(): CompanyFavorite[] {
  const list = getPrefs()?.['companies.favorites']
  return Array.isArray(list) ? list : []
}

export function isFavorite(domain: string, list: CompanyFavorite[] = favorites()): boolean {
  const d = domain.trim().toLowerCase()
  return list.some((f) => f.domain === d)
}

export function addFavorite(f: CompanyFavorite): void {
  const domain = f.domain.trim().toLowerCase()
  if (!domain) return
  setPrefs({ 'companies.favorites': [{ domain, name: f.name.trim().slice(0, 200) || domain }, ...favorites().filter((x) => x.domain !== domain)].slice(0, MAX) })
}

export function removeFavorite(domain: string): void {
  const d = domain.trim().toLowerCase()
  setPrefs({ 'companies.favorites': favorites().filter((x) => x.domain !== d) })
}
