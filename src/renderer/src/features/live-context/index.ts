// SPDX-License-Identifier: Apache-2.0
// Live context: the card window and the Labs row.

import { createElement, type JSX } from 'react'
import { LiveContextLabsRowView, LiveContextRootView } from './LiveContext'

/** `#/live-context`. */
export function LiveContextRoot(): JSX.Element {
  return createElement(LiveContextRootView)
}

/** Settings ▸ Labs: the custom select for `liveContext.mode`. */
export function LiveContextLabsRow(): JSX.Element {
  return createElement(LiveContextLabsRowView)
}
