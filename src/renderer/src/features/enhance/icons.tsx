// SPDX-License-Identifier: Apache-2.0
// Icons for the enhance feature, drawn on the same 24-unit grid as app/icons.

import type { JSX } from 'react'

export function IconRegenerate({ size = 16, className }: { size?: number; className?: string }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M20 11a8 8 0 1 0-2.34 5.66" />
      <path d="M20 4v7h-7" />
    </svg>
  )
}

/** A speech bubble with text lines: "Show in transcript". */
export function IconTranscript({ size = 16, className }: { size?: number; className?: string }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4.5 5h15v10.5H10L5.5 19v-3.5h-1z" />
      <path d="M8.5 9h7M8.5 12h4.5" />
    </svg>
  )
}
