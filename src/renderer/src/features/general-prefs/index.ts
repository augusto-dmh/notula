// SPDX-License-Identifier: Apache-2.0
// General preferences. The views live in GeneralPrefs.tsx.

import { createElement, type JSX } from 'react'
import { ChatEnterBehaviorView, LabsMoreView } from './GeneralPrefs'

export function ChatEnterBehaviorRow(): JSX.Element {
  return createElement(ChatEnterBehaviorView)
}

export function LabsMoreRow(): JSX.Element {
  return createElement(LabsMoreView)
}
