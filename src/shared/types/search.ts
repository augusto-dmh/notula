// SPDX-License-Identifier: Apache-2.0
// Local note search. Runs in
// `notula-storage` on the FTS5 trigram index; the renderer never sends SQL.

export type SearchMatchType = 'title' | 'notes' | 'panel'

export interface SearchResult {
  id: string
  title: string | null
  owner_id: string
  sort_epoch: number
  matchType: SearchMatchType
  snippet: string | null
}

/** `search:query`: merged, deduped, own-first order. */
export interface SearchResponse {
  query: string
  phrase: string | null
  results: SearchResult[]
}
