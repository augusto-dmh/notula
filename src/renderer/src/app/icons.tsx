// SPDX-License-Identifier: Apache-2.0
// Notula's own line icons (24-unit grid, 1.75 stroke). Inline SVG keeps them
// theme-aware through currentColor and CSP-safe.

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

export function IconPlus(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  )
}

export function IconClose(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  )
}

export function IconChevronLeft(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M15 18l-6-6 6-6" />
    </Svg>
  )
}

export function IconChevronUp(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6 15l6-6 6 6" />
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

export function IconSettings(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </Svg>
  )
}

export function IconAlert(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5h.01" />
    </Svg>
  )
}

export function IconInfo(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 7.5h.01" />
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

export function IconNote(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M7 3.5h7.5L19 8v11.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z" />
      <path d="M14 3.5V8.5h5M9.5 12.5h5M9.5 16h3.5" />
    </Svg>
  )
}

export function IconPencil(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 20h4L19 9a2.1 2.1 0 0 0-4-4L4 16v4z" />
      <path d="M13.5 6.5l4 4" />
    </Svg>
  )
}

export function IconSparkle(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z" />
      <path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
    </Svg>
  )
}

export function IconHeading(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6 5v14M16 5v14M6 12h10" />
    </Svg>
  )
}

export function IconList(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M10 6.5h10M10 12h10M10 17.5h10" />
      <circle cx="5" cy="6.5" r="0.6" fill="currentColor" />
      <circle cx="5" cy="12" r="0.6" fill="currentColor" />
      <circle cx="5" cy="17.5" r="0.6" fill="currentColor" />
    </Svg>
  )
}

export function IconCheckbox(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="4" y="4" width="16" height="16" rx="3.5" />
      <path d="M8.5 12.3l2.4 2.4 4.6-5" />
    </Svg>
  )
}

export function IconCalendar(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="4" y="5.5" width="16" height="14.5" rx="2.5" />
      <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
    </Svg>
  )
}

export function IconSearch(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4 4" />
    </Svg>
  )
}

/** The Notula mark: a folded page with a pen stroke. */
export function IconSidebar(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
      <path d="M9.5 4.5v15" />
    </Svg>
  )
}

export function IconArrowLeft(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M19 12H5" />
      <path d="m11 6-6 6 6 6" />
    </Svg>
  )
}

/** Install update: an arrow into a tray. */
export function IconDownload(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 4v11" />
      <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
      <path d="M5 19.5h14" />
    </Svg>
  )
}

export function IconUser(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 19.5a7 7 0 0 1 14 0" />
    </Svg>
  )
}

export function IconBell(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2h-14z" />
      <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
    </Svg>
  )
}

export function IconCode(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="m9 7-5 5 5 5" />
      <path d="m15 7 5 5-5 5" />
    </Svg>
  )
}

export function IconBook(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M5 5.5A1.5 1.5 0 0 1 6.5 4H19v14H6.5A1.5 1.5 0 0 0 5 19.5z" />
      <path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19" />
      <path d="M9 8h6" />
    </Svg>
  )
}

export function IconLayout(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M4 9.5h16" />
      <path d="M10 9.5V20" />
    </Svg>
  )
}

export function IconRestart(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
      <path d="M4.5 4.5v4h4" />
    </Svg>
  )
}

export function NotulaMark({ size = 20 }: { size?: number }): JSX.Element {
  return (
    // The app icon's mark (resources/icon/icon.svg) at 24 units; fixed brand colours.
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="1.5" y="1.5" width="21" height="21" rx="4.5" fill="#4a57d4" />
      <path
        d="M7.03 16.88V11.72c0-2.72 2.06-4.5 4.78-4.5s4.78 1.78 4.78 4.5v2.72"
        fill="none"
        stroke="#ffffff"
        strokeWidth={2.44}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="16.59" cy="17.16" r="1.59" fill="#e5484d" />
    </svg>
  )
}
