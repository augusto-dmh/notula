// SPDX-License-Identifier: Apache-2.0
// The extension ids Notula accepts: `allowed_origins` in the host
// manifest, and the same list again in main's `auth` check, so a manifest edited by another program
// can't add a caller.
//
// - Store ids come from `extension/store/ids.json` (null until the first dashboard upload).
// - The dev id is fixed by the committed public key (`extension/keys/dev-public-key.txt`). Anyone
//   can load an unpacked extension with that key, so it is accepted by dev builds of Notula only.

import storeIds from '../../../../extension/store/ids.json'

export const DEV_EXTENSION_ID = 'pdbjfbgamjlapjbmchmdkdadhgnoeokh'
const ID = /^[a-p]{32}$/

export const originOf = (id: string): string => `chrome-extension://${id}/`

export function allowedOrigins(devBuild: boolean): string[] {
  const ids: unknown[] = [storeIds.cws, storeIds.edge]
  if (devBuild) ids.push(DEV_EXTENSION_ID)
  return [...new Set(ids.filter((v): v is string => typeof v === 'string' && ID.test(v)))].map(originOf)
}
