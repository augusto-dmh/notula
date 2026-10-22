// SPDX-License-Identifier: Apache-2.0
// Trash and copy icons (Notula's own line icons, the app/icons.tsx grid: 24 units, 1.75 stroke).

import type { JSX, ReactNode } from 'react'

interface IconProps {
  size?: number
  className?: string
}

function Svg({ size = 18, className, children }: IconProps & { children: ReactNode }): JSX.Element {
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
      {children}
    </svg>
  )
}

export function IconTrash(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 7h16M10 11v6M14 11v6M5.5 7l.9 11.2A2 2 0 0 0 8.4 20h7.2a2 2 0 0 0 2-1.8L18.5 7M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </Svg>
  )
}

export function IconRestore(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4" />
    </Svg>
  )
}

export function IconMore(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="6" cy="12" r="0.9" fill="currentColor" />
      <circle cx="12" cy="12" r="0.9" fill="currentColor" />
      <circle cx="18" cy="12" r="0.9" fill="currentColor" />
    </Svg>
  )
}

export function IconCopy(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h8" />
    </Svg>
  )
}

export function IconStop(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
    </Svg>
  )
}

export function IconPlay(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M8 6.5v11l9-5.5z" />
    </Svg>
  )
}

export function IconOpen(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M14 4h6v6M20 4l-8 8M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
    </Svg>
  )
}
