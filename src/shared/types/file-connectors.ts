// SPDX-License-Identifier: Apache-2.0
// Read-only file connectors (Labs).

import type { IsoTime } from './common'

export type FileConnectorKey = 'google_drive' | 'onedrive' | 'dropbox'

export interface FileConnectorStatus {
  connector: FileConnectorKey
  state: 'connected' | 'not-connected' | 'needs-calendar' | 'reconnect'
  accountLabel: string | null
  sourceId: string | null
}

export interface FileSearchResult {
  id: string
  name: string
  url: string | null
  mimeType: string | null
  modifiedAt: IsoTime | null
  owner?: string
  path?: string
}

export interface FileReadResult {
  id: string
  name: string
  url: string | null
  text: string
  truncated: boolean
}

export const FILE_CONNECTOR_LIMITS = {
  searchMax: 25,
  searchDefault: 10,
  readChars: 20_000,
  fileMaxBytes: 26_214_400,
  exportMaxBytes: 10_485_760
} as const
