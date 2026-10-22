// SPDX-License-Identifier: Apache-2.0
// Notula's template icon set:
// named line icons on the app's 24-unit grid, plus a colour row. A template stores
// `{ type: 'icon', value: <name>, color: <colour name> }` or an emoji with its hexcode.
// The default is a grey hashtag.

import type { CSSProperties, JSX } from 'react'
import type { TemplateIcon } from '@shared/types/templates'

export const DEFAULT_TEMPLATE_ICON: TemplateIcon = { type: 'icon', value: 'hash', color: 'gray' }

/** Colour names → CSS colours that read in both themes. */
export const TEMPLATE_COLORS: { name: string; label: string; value: string }[] = [
  { name: 'gray', label: 'Grey', value: 'var(--fg-2)' },
  { name: 'blue', label: 'Blue', value: '#4a7fe0' },
  { name: 'teal', label: 'Teal', value: '#1f9a96' },
  { name: 'green', label: 'Green', value: '#3a9a5b' },
  { name: 'yellow', label: 'Yellow', value: '#c9921a' },
  { name: 'orange', label: 'Orange', value: '#dc6f2b' },
  { name: 'red', label: 'Red', value: '#d24a43' },
  { name: 'pink', label: 'Pink', value: '#cf4f8c' },
  { name: 'purple', label: 'Purple', value: '#8657d6' }
]

export function colorValue(name: string): string {
  return TEMPLATE_COLORS.find((c) => c.name === name)?.value ?? 'var(--fg-2)'
}

/** Icon name → SVG children. */
const PATHS: Record<string, JSX.Element> = {
  hash: <path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16" />,
  'user-pair': (
    <>
      <circle cx="8" cy="9" r="3" />
      <circle cx="16" cy="9" r="3" />
      <path d="M2.5 19c.7-3 2.9-4.5 5.5-4.5s4.8 1.5 5.5 4.5M13.5 15.2c.8-.5 1.6-.7 2.5-.7 2.6 0 4.8 1.5 5.5 4.5" />
    </>
  ),
  users: (
    <>
      <circle cx="12" cy="8" r="3.2" />
      <path d="M5.5 19.5c.8-3.3 3.3-5 6.5-5s5.7 1.7 6.5 5" />
      <path d="M4.5 11.5a2.3 2.3 0 1 1 1.7-4M19.5 11.5a2.3 2.3 0 1 0-1.7-4M2 16.5c.4-1.4 1.3-2.4 2.6-2.9M22 16.5c-.4-1.4-1.3-2.4-2.6-2.9" />
    </>
  ),
  sunrise: (
    <>
      <path d="M4 18h16M7 18a5 5 0 0 1 10 0" />
      <path d="M12 6V3M4.9 10.9 3 9M19.1 10.9 21 9M8 6.8 7 5M16 6.8l1-1.8" />
    </>
  ),
  rocket: (
    <>
      <path d="M14 4c3-1.2 5.3-.9 6 0 .9.7 1.2 3 0 6l-6 6-6-6 6-6Z" />
      <circle cx="15" cy="9" r="1.6" />
      <path d="M8 10 5 10 3 13l4 .5M14 16v3l-3 2-.5-4M7.5 16.5c-1.5.5-2.5 2-2.5 3.5 1.5 0 3-1 3.5-2.5" />
    </>
  ),
  handshake: (
    <>
      <path d="M3 8.5 6.5 6l3 1.5L12 6l3 1.5L17.5 6 21 8.5v5l-3 1" />
      <path d="M3 8.5v5l4.5 4c.7.6 1.6.6 2.2 0l.8-.7.8.7c.6.5 1.5.5 2.1-.1l.6-.6.4.3c.6.4 1.4.4 1.9-.2l1.7-2" />
      <path d="M12 6 8.5 9.5c-.6.6-.6 1.5 0 2 .6.6 1.5.6 2.1 0L12.5 9.6l4 4" />
    </>
  ),
  heart: <path d="M12 20s-7.5-4.6-7.5-10A4.2 4.2 0 0 1 12 7.6 4.2 4.2 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10Z" />,
  chat: (
    <>
      <path d="M20 12a7.5 7.5 0 0 1-10.9 6.7L4 20l1.3-4.4A7.5 7.5 0 1 1 20 12Z" />
      <path d="M9 11h6M9 14h4" />
    </>
  ),
  briefcase: (
    <>
      <rect x="3" y="7" width="18" height="12.5" rx="2" />
      <path d="M8.5 7V5.5A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5V7M3 12.5h18M10.5 12.5v1.5h3v-1.5" />
    </>
  ),
  lightbulb: (
    <>
      <path d="M9 17.5h6M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V17h5.2v-1.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3Z" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.5" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  clipboard: (
    <>
      <rect x="5" y="4.5" width="14" height="16.5" rx="2" />
      <path d="M9 4.5V3.8c0-.4.4-.8.8-.8h4.4c.4 0 .8.4.8.8v.7M8.5 10h7M8.5 13.5h7M8.5 17h4" />
    </>
  ),
  star: <path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.9L12 3.5Z" />,
  flag: (
    <>
      <path d="M5 21V4" />
      <path d="M5 4.5c4-2 6.5 2 10.5 0 1.3-.6 2.6-.7 3.5-.5v9.5c-.9-.2-2.2-.1-3.5.5-4 2-6.5-2-10.5 0" />
    </>
  ),
  chart: (
    <>
      <path d="M4 4v16h16" />
      <path d="M8 16v-4M12 16V8M16 16v-6" />
    </>
  ),
  code: <path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.5 5l-3 14" />,
  book: (
    <>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H12v16H5.5A1.5 1.5 0 0 1 4 18.5v-13Z" />
      <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H12v16h6.5a1.5 1.5 0 0 0 1.5-1.5v-13Z" />
    </>
  ),
  compass: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" />
    </>
  ),
  megaphone: (
    <>
      <path d="M4 10v4a1 1 0 0 0 1 1h2l8 4.5V4.5L7 9H5a1 1 0 0 0-1 1Z" />
      <path d="M18 9.5a3.5 3.5 0 0 1 0 5M8 15l1.2 4.5" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </>
  ),
  coffee: (
    <>
      <path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9Z" />
      <path d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16M8 3.5c-.6.8-.6 1.7 0 2.5M12 3.5c-.6.8-.6 1.7 0 2.5" />
    </>
  ),
  graduation: (
    <>
      <path d="M2.5 9 12 4.5 21.5 9 12 13.5 2.5 9Z" />
      <path d="M6.5 11v4.5c1.5 1.4 3.5 2 5.5 2s4-.6 5.5-2V11M21.5 9v5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.3-4.3" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5s1.1-6.1 3.4-8.5Z" />
    </>
  ),
  sparkle: <path d="M12 3.5c.7 3.9 1.9 5.1 5.8 5.8-3.9.7-5.1 1.9-5.8 5.8-.7-3.9-1.9-5.1-5.8-5.8 3.9-.7 5.1-1.9 5.8-5.8ZM18.5 14.5c.3 1.6.9 2.2 2.5 2.5-1.6.3-2.2.9-2.5 2.5-.3-1.6-.9-2.2-2.5-2.5 1.6-.3 2.2-.9 2.5-2.5Z" />
}

/** The picker's order. */
export const TEMPLATE_ICON_NAMES = Object.keys(PATHS)

export function TemplateGlyph({ name, size = 18, className }: { name: string; size?: number; className?: string }): JSX.Element {
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
      {PATHS[name] ?? PATHS['hash']}
    </svg>
  )
}

/** A template's icon at a size: the named icon in its colour, or the emoji. */
export function TemplateIconView({
  icon,
  size = 18,
  className
}: {
  icon: TemplateIcon | null | undefined
  size?: number
  className?: string
}): JSX.Element {
  const i = icon ?? DEFAULT_TEMPLATE_ICON
  if (i.type === 'emoji') {
    // A host class (a list row's tile) keeps its own box; elsewhere the emoji takes the
    // icon's box, so text after it lines up with the line icons.
    const style: CSSProperties = className
      ? { fontSize: Math.round(size * 0.92), lineHeight: 1 }
      : { fontSize: Math.round(size * 0.92), lineHeight: 1, width: size, height: size, overflow: 'visible' }
    return (
      <span className={`tpl-icon tpl-icon--emoji${className ? ` ${className}` : ''}`} style={style} aria-hidden="true">
        {i.value}
      </span>
    )
  }
  return (
    <span className={`tpl-icon${className ? ` ${className}` : ''}`} style={{ color: colorValue(i.color) }} aria-hidden="true">
      <TemplateGlyph name={i.value} size={size} />
    </span>
  )
}
