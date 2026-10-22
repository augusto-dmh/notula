// SPDX-License-Identifier: Apache-2.0
// Tips and What's new. The views live beside this file, the copy in tips.ts.

import { createElement, type JSX } from 'react'
import type { NuxTipId } from '@shared/types/nux'
import { NuxHostView } from './NuxHost'
import { NuxTipView } from './NuxTip'
import { TipsPreferencesView, WhatsNewCardView } from './WhatsNew'

export function NuxTip(p: { id: NuxTipId; title?: string; body?: string; onAction?(): void }): JSX.Element | null {
  return createElement(NuxTipView, p)
}

export function NuxHost(): JSX.Element | null {
  return createElement(NuxHostView)
}

export function WhatsNewCard(): JSX.Element | null {
  return createElement(WhatsNewCardView)
}

export function TipsPreferencesRow(): JSX.Element | null {
  return createElement(TipsPreferencesView)
}
