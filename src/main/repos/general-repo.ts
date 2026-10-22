// SPDX-License-Identifier: Apache-2.0
// General: the storage-worker side of its StorageApi group. Worker-safe: no Electron imports.
//
// - `noteCount`: the app-icon milestones count the user's own notes that are
//   not trashed. Scratchpads and the demo meeting are not notes the user took, so they don't count.
// - `databaseCreatedAt`: the `meta.created_at` row written when the database was first opened;
//   "In use since" on the device card starts from it.

import { DEMO_MEETING_PREFIX } from '@shared/types/notes'
import type { IsoTime } from '@shared/types/common'
import { readMeta } from '../storage/kv-repo'
import type { StoreCtx } from '../storage/store'

export function noteCount(s: StoreCtx, _q: { excludeTrashed: true }): number {
  const row = s.db
    .prepare(
      `SELECT COUNT(*) AS n FROM documents
        WHERE owner_id = ? AND deleted_at IS NULL AND is_scratchpad = 0 AND id NOT LIKE '${DEMO_MEETING_PREFIX}%'`
    )
    .get(s.identity.ownerId) as { n: number }
  return row.n
}

export function databaseCreatedAt(s: StoreCtx): IsoTime | null {
  const v = readMeta(s.db, 'created_at')
  return v && !Number.isNaN(Date.parse(v)) ? (v as IsoTime) : null
}
