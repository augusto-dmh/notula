// SPDX-License-Identifier: Apache-2.0
import type { JSX } from 'react'

/** Two stacked note cards. */
function StackedNotes(): JSX.Element {
  return (
    <svg width="112" height="96" viewBox="0 0 112 96" aria-hidden="true" focusable="false" className="not-found__art">
      <g transform="rotate(-8 50 52)">
        <rect x="22" y="18" width="56" height="68" rx="9" fill="var(--surface-2)" stroke="var(--border-strong)" strokeWidth="1.5" />
      </g>
      <g transform="rotate(6 62 46)">
        <rect x="36" y="10" width="56" height="68" rx="9" fill="var(--surface)" stroke="var(--border-strong)" strokeWidth="1.5" />
        <path d="M48 30h32M48 40h26M48 50h30M48 60h18" stroke="var(--fg-3)" strokeWidth="2.5" strokeLinecap="round" opacity="0.6" />
      </g>
    </svg>
  )
}

/** The message plus the requested id in monospace. */
export function NotFound({ id }: { id: string }): JSX.Element {
  return (
    <div className="not-found" role="alert">
      <StackedNotes />
      <p className="not-found__title">This note doesn’t exist or was deleted for good.</p>
      <code className="not-found__id">{id}</code>
    </div>
  )
}
