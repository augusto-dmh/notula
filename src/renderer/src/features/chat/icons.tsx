// SPDX-License-Identifier: Apache-2.0
// Chat's own line icons, on the app's 24-unit grid with a 1.75 stroke (see app/icons.tsx).

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

export function IconSend(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </Svg>
  )
}

export function IconStop(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />
    </Svg>
  )
}

export function IconCopy(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
    </Svg>
  )
}

export function IconImage(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M20.5 15.5l-4.5-4.5-8.5 8.5" />
    </Svg>
  )
}

export function IconEdit(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z" />
      <path d="M14 7l3 3" />
    </Svg>
  )
}

export function IconResend(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 5v6h-6" />
    </Svg>
  )
}

export function IconBookmark(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6.5 4h11v16l-5.5-4-5.5 4z" />
    </Svg>
  )
}

export function IconPin(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M9 4h6l-1 5 3 3H7l3-3z" />
      <path d="M12 12v8" />
    </Svg>
  )
}

export function IconMore(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="6" cy="12" r="1" fill="currentColor" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
      <circle cx="18" cy="12" r="1" fill="currentColor" />
    </Svg>
  )
}

export function IconHistory(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5" />
      <path d="M4 4v4.5h4.5" />
      <path d="M12 8v4l3 2" />
    </Svg>
  )
}

export function IconCompose(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-6" />
      <path d="M17.5 3.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z" />
    </Svg>
  )
}

export function IconExpand(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />
    </Svg>
  )
}

export function IconArrowDown(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 5v14M6 13l6 6 6-6" />
    </Svg>
  )
}

export function IconSearchDoc(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.5-4.5" />
    </Svg>
  )
}

export function IconDoc(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20z" />
      <path d="M14 3.5V8h4M10 12h5M10 15.5h5" />
    </Svg>
  )
}

export function IconClock(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l2.5 2" />
    </Svg>
  )
}

export function IconTool(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M14.5 6.5a4 4 0 0 0 5 5L13 18l-3 3-4-4 3-3 6.5-6.5a4 4 0 0 0-1-1z" />
    </Svg>
  )
}

export function IconWarn(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4M12 17h.01" />
    </Svg>
  )
}

export function IconChat(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />
    </Svg>
  )
}

export function IconUndo(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M9 7L4 12l5 5" />
      <path d="M4 12h10a6 6 0 0 1 0 12h-1" transform="translate(0 -6)" />
    </Svg>
  )
}

export function IconRedo(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M15 7l5 5-5 5" />
      <path d="M20 12H10a6 6 0 0 0 0 12h1" transform="translate(0 -6)" />
    </Svg>
  )
}

// ---------- categories, cards, files ----------

export function IconPaperclip(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M20.5 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />
    </Svg>
  )
}

export function IconCalendarDay(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </Svg>
  )
}

export function IconPeople(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="9" cy="9" r="3.2" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <circle cx="17" cy="9.5" r="2.6" />
      <path d="M15.5 14.2A4.6 4.6 0 0 1 21 18.6" />
    </Svg>
  )
}

export function IconFolderSmall(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    </Svg>
  )
}

export function IconQuestion(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.7" />
      <path d="M12 17h.01" />
    </Svg>
  )
}

export function IconCaretRight(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M10 7l5 5-5 5" />
    </Svg>
  )
}

export function IconMail(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
      <path d="M4 7l8 6 8-6" />
    </Svg>
  )
}
