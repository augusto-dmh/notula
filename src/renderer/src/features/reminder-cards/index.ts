// SPDX-License-Identifier: Apache-2.0
// Meeting reminder cards.

import { createElement, type JSX } from 'react'
import { ReminderCardsRootView } from './ReminderCards'

/** `#/reminder-cards`. */
export function ReminderCardsRoot(): JSX.Element {
  return createElement(ReminderCardsRootView)
}
