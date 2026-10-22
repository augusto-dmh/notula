// SPDX-License-Identifier: Apache-2.0
// What a page tells every editor inside it: read-only while the note is in Trash, and
// the copy header a whole-document copy adds. Panel editors mounted by other features
// (EnhancedView) get both from here, so they need no extra props.

import { createContext, useContext } from 'react'
import type { CopyHeader } from './copy'

export interface EditorScope {
  readOnly: boolean
  copyHeader: CopyHeader | null
}

export const EditorScopeContext = createContext<EditorScope>({ readOnly: false, copyHeader: null })

export function useEditorScope(): EditorScope {
  return useContext(EditorScopeContext)
}
