// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Sources: the page shell and its named row slots. The section is listed only while
// `sources.enabled` is on, on Windows. The rows live in rows.tsx and in each feature's own
// slot files.

import type { JSX } from 'react'
import { FindSourcesRow } from '../backfill/FindSourcesRow'
import { BrowserExtensionRow } from '../extension/BrowserExtensionRow'
import {
  CourseHostRows,
  DetectionRows,
  FilingRows,
  GrantRows,
  MuteRows,
  StampRows,
  ToolsRows,
  TranscriptRows
} from './rows'

export function SourcesSettingsPage(): JSX.Element {
  return (
    <>
      {/* Detection: the reader switch, its status, the last identification step. */}
      <DetectionRows />
      {/* History and online lookups, set together by the first-use prompt. */}
      <GrantRows />
      {/* Managed yt-dlp: state, version, Download, size and licence. */}
      <ToolsRows />
      {/* The browser extension: switch, per-browser status, Repair. */}
      <BrowserExtensionRow />
      {/* Video captions and the lesson template. */}
      <TranscriptRows />
      {/* Stamps and Ctrl+Alt+T. */}
      <StampRows />
      {/* Filing into course, playlist and channel folders. */}
      <FilingRows />
      {/* Muted channels and sites. */}
      <MuteRows />
      {/* Extra course hosts for History. */}
      <CourseHostRows />
      {/* Find sources for older notes. */}
      <FindSourcesRow />
    </>
  )
}
