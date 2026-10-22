// SPDX-License-Identifier: Apache-2.0
// Live captions: the #/captions window
// and the Preferences row.

import { createElement, type JSX } from 'react'
import { CaptionsWindow } from './Captions'
import { CaptionsRow } from './CaptionsRow'

export { useCaptionsState } from './Captions'

/** `#/captions`. */
export function CaptionsRoot(): JSX.Element {
  return createElement(CaptionsWindow)
}

/** Settings ▸ Preferences: captions for every meeting. */
export function CaptionsPreferenceRow(): JSX.Element {
  return createElement(CaptionsRow)
}
