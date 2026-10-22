// SPDX-License-Identifier: Apache-2.0
// Feedback reports. The page lives in FeedbackPage.tsx.

import { createElement, type JSX } from 'react'
import { FeedbackPage } from './FeedbackPage'

export function FeedbackSettings(): JSX.Element {
  return createElement(FeedbackPage)
}
