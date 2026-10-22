// SPDX-License-Identifier: Apache-2.0
// Settings and onboarding icons, drawn on the same grid as app/icons.tsx
// (24 units, 1.75 stroke, currentColor).

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

export function IconMic(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </Svg>
  )
}

export function IconSpeaker(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
      <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
    </Svg>
  )
}

export function IconSliders(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </Svg>
  )
}

export function IconSparkles(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M10 4.5l1.6 4.4 4.4 1.6-4.4 1.6L10 16.5l-1.6-4.4L4 10.5l4.4-1.6z" />
      <path d="M17.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
    </Svg>
  )
}

export function IconRefresh(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v3.8h-3.8" />
    </Svg>
  )
}

export function IconExternal(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M13.5 5H19v5.5M19 5l-8 8M17 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4" />
    </Svg>
  )
}

export function IconLock(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </Svg>
  )
}

export function IconChevronDown(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6 9l6 6 6-6" />
    </Svg>
  )
}

export function IconX(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </Svg>
  )
}

export function IconCheck(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Svg>
  )
}

export function IconWarning(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 4l9 15.5H3z" />
      <path d="M12 10v4.5M12 17h.01" />
    </Svg>
  )
}

// ---------- feature section icons ----------

export function IconKeyboard(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="3" y="6" width="18" height="12" rx="2.5" />
      <path d="M7 10h.01M10.5 10h.01M14 10h.01M17.5 10h.01M7.5 14h9" />
    </Svg>
  )
}

export function IconUsers(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="9" cy="9" r="3.25" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0M15.5 6.2a3.25 3.25 0 0 1 0 5.6M17.5 14.2A5.5 5.5 0 0 1 20.5 19" />
    </Svg>
  )
}

export function IconPlug(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M9 3v4M15 3v4M7 7h10v3.5a5 5 0 0 1-10 0z" />
      <path d="M12 15.5V21" />
    </Svg>
  )
}

export function IconNodes(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="6" cy="6" r="2.25" />
      <circle cx="18" cy="6" r="2.25" />
      <circle cx="12" cy="18" r="2.25" />
      <path d="M8 7.2l2.8 8.6M16 7.2l-2.8 8.6M8.25 6h7.5" />
    </Svg>
  )
}

export function IconFlask(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M9.5 3h5M10 3v6.2L4.8 18a2 2 0 0 0 1.7 3h11a2 2 0 0 0 1.7-3L14 9.2V3" />
      <path d="M7.4 14.5h9.2" />
    </Svg>
  )
}

/** A screen with a play mark (Settings ▸ Sources). */
export function IconPlay(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="M10.5 9.5v5l4-2.5z" />
    </Svg>
  )
}

export function IconLifebuoy(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3.5" />
      <path d="M6 6l3.5 3.5M14.5 14.5L18 18M18 6l-3.5 3.5M9.5 14.5L6 18" />
    </Svg>
  )
}
