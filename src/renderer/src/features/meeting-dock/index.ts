// SPDX-License-Identifier: Apache-2.0
// The meeting dock window.

import { createElement, type JSX } from 'react'
import { MeetingDockRootView } from './MeetingDock'

/** `#/meeting-dock`. */
export function MeetingDockRoot(): JSX.Element {
  return createElement(MeetingDockRootView)
}
