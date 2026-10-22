// SPDX-License-Identifier: Apache-2.0
// Import notes in the renderer: the Settings card, backed by the files beside it.

import { createElement, type JSX } from 'react'
import { NotesImportCardView } from './NotesImportCard'

/** Settings ▸ Data, after the data export card. */
export function NotesImportCard(): JSX.Element {
  return createElement(NotesImportCardView)
}
