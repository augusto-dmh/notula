// SPDX-License-Identifier: Apache-2.0
// People and companies icons, on the app's 24-unit grid with a 1.75 stroke (see app/icons.tsx).

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

export function IconPeopleLarge(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="9" cy="9" r="3.2" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <circle cx="17" cy="9.5" r="2.6" />
      <path d="M15.5 14.2A4.6 4.6 0 0 1 21 18.6" />
    </Svg>
  )
}

export function IconBuilding(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4.5 20.5V5.5a1.5 1.5 0 0 1 1.5-1.5h7a1.5 1.5 0 0 1 1.5 1.5v15" />
      <path d="M14.5 9.5h3.5a1.5 1.5 0 0 1 1.5 1.5v9.5" />
      <path d="M3 20.5h18M8 8h3M8 11.5h3M8 15h3" />
    </Svg>
  )
}

export function IconStar({ size = 16, filled, className }: IconProps & { filled?: boolean }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 3.8l2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.6-5 2.6.9-5.6-4-3.9 5.6-.8z" />
    </svg>
  )
}

export function IconCopySmall(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
    </Svg>
  )
}

export function IconExternal(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M14 4h6v6M20 4l-8.5 8.5" />
      <path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
    </Svg>
  )
}
