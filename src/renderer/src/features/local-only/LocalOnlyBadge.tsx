// SPDX-License-Identifier: Apache-2.0
// The "Local only" badge in the sidebar footer: null while the mode is off.

import type { JSX } from 'react'
import { LOCAL_ONLY_COPY } from '@shared/types/local-only'
import { openLocalOnlySetting, useLocalOnly } from './store'
import './local-only.css'

export function LocalOnlyBadge(): JSX.Element | null {
  const status = useLocalOnly()
  if (!status?.enabled) return null
  return (
    <button type="button" className="lo-badge" title={LOCAL_ONLY_COPY.tooltip} aria-label={LOCAL_ONLY_COPY.tooltip} onClick={openLocalOnlySetting}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="3" y="7" width="10" height="7" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
        <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      <span>{LOCAL_ONLY_COPY.badge}</span>
    </button>
  )
}
