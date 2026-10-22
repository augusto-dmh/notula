// SPDX-License-Identifier: Apache-2.0
// The bubble windows' roots. Each is the lazy root of a
// secondary window chosen by hash in main.tsx (#/bubble, #/bubble-transcript,
// #/bubble-inactivity). They never mount StorageGate, OnboardingGate or CaptureEngineHost:
// they follow main's state through a read-only capture mirror.

import { createElement, type JSX } from 'react'
import { BubbleInactivity, BubbleTranscript } from './BubblePanels'
import { BubblePill } from './BubblePill'

export function BubbleRoot(): JSX.Element {
  return createElement(BubblePill)
}

export function BubbleTranscriptRoot(): JSX.Element {
  return createElement(BubbleTranscript)
}

export function BubbleInactivityRoot(): JSX.Element {
  return createElement(BubbleInactivity)
}
