// SPDX-License-Identifier: Apache-2.0
// registerSearch(): `search:query` over the storage worker's FTS search. The renderer sends
// only the query text; the SQL lives in `search-repo.ts`, never in a renderer.

import { ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeRes } from '@shared/ipc'
import type { MainContext } from '../context'
import { object } from '../notes/validate'

/** A pasted page of text still searches; anything longer is refused. */
const MAX_QUERY_CHARS = 10_000

export function registerSearch(ctx: MainContext): void {
  ipcMain.handle(
    'search:query' satisfies InvokeChannel,
    (_e, req: unknown): Promise<InvokeRes<'search:query'>> => {
      const query = object(req, 'request')['query']
      if (typeof query !== 'string' || query.length > MAX_QUERY_CHARS) {
        throw notulaError('invalid-input', `query must be a string of at most ${MAX_QUERY_CHARS} characters`)
      }
      return ctx.storage.searchNotes(query)
    }
  )
}
