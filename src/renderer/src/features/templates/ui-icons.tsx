// SPDX-License-Identifier: Apache-2.0
// Small line icons the template and recipe UIs need beyond the app set (24-unit grid,
// 1.75 stroke, currentColor), in the style of app/icons.tsx.

import type { JSX, ReactNode } from 'react'

interface IconProps {
  size?: number
  className?: string
}

function Svg({ size = 16, className, children }: IconProps & { children: ReactNode }): JSX.Element {
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

export function IconLock(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </Svg>
  )
}

export function IconGrip(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" strokeWidth={2.6} />
    </Svg>
  )
}

export function IconTrashSmall(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4.5 7h15M10 11v6M14 11v6M6.5 7l.8 11.2A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.8L17.5 7M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2" />
    </Svg>
  )
}

export function IconMore(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth={2.8} />
    </Svg>
  )
}

export function IconStar({ filled, ...p }: IconProps & { filled?: boolean }): JSX.Element {
  return (
    <Svg {...p}>
      <path d="m12 3.8 2.5 5.1 5.6.8-4 3.9 1 5.6-5.1-2.7-5 2.7.9-5.6-4-3.9 5.6-.8L12 3.8Z" fill={filled ? 'currentColor' : 'none'} />
    </Svg>
  )
}

export function IconCopy(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2" />
      <path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5" />
    </Svg>
  )
}

export function IconSlash(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M15 4 9 20" />
    </Svg>
  )
}

export function IconGrid(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
    </Svg>
  )
}

export function IconRows(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 6.5h16M4 12h16M4 17.5h16" />
    </Svg>
  )
}

export function IconPlay(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M8 5.5v13l10.5-6.5L8 5.5Z" />
    </Svg>
  )
}

export function IconUndo(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M9 7 4.5 11.5 9 16" />
      <path d="M4.5 11.5h10a5 5 0 0 1 0 10H12" />
    </Svg>
  )
}
