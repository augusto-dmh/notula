// SPDX-License-Identifier: Apache-2.0
// Folder icons: Notula's own line icons on the
// app/icons.tsx grid (24 units, 1.75 stroke), the colour row, the 7 template presets, and
// the glyph that draws a folder's `icon` (a named icon in a colour, or an emoji).

import type { CSSProperties, JSX, ReactNode } from 'react'
import type { FolderPresetId } from '@shared/types/folders'
import type { TemplateIcon } from '@shared/types/templates'

interface IconProps {
  size?: number
  className?: string
}

function Svg({ size = 18, className, children, style }: IconProps & { children: ReactNode; style?: CSSProperties }): JSX.Element {
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
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

// ---------- the picker's icon set ----------

export const FOLDER_ICONS: Readonly<Record<string, { label: string; paths: ReactNode }>> = {
  FolderIcon: {
    label: 'Folder',
    paths: <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
  },
  StarIcon: { label: 'Star', paths: <path d="M12 4l2.5 5.1 5.6.8-4 3.9.9 5.6L12 16.8 7 19.4l.9-5.6-4-3.9 5.6-.8z" /> },
  BriefcaseIcon: {
    label: 'Briefcase',
    paths: (
      <>
        <rect x="3.5" y="7.5" width="17" height="12" rx="2" />
        <path d="M9 7.5V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v1.5M3.5 12.5h17" />
      </>
    )
  },
  UsersIcon: {
    label: 'People',
    paths: (
      <>
        <circle cx="9" cy="9" r="3" />
        <path d="M3.5 19a5.5 5.5 0 0 1 11 0M15.5 6.3a3 3 0 0 1 0 5.4M17 14.2a5.5 5.5 0 0 1 3.5 4.8" />
      </>
    )
  },
  UserIcon: {
    label: 'Person',
    paths: (
      <>
        <circle cx="12" cy="8.5" r="3.5" />
        <path d="M5 19.5a7 7 0 0 1 14 0" />
      </>
    )
  },
  ChatIcon: {
    label: 'Conversation',
    paths: <path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-9l-4.5 3v-3H5A1.5 1.5 0 0 1 3.5 16V7A1.5 1.5 0 0 1 5 5.5z" />
  },
  CalendarIcon: {
    label: 'Calendar',
    paths: (
      <>
        <rect x="4" y="5.5" width="16" height="14.5" rx="2.5" />
        <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
      </>
    )
  },
  TargetIcon: {
    label: 'Target',
    paths: (
      <>
        <circle cx="12" cy="12" r="8" />
        <circle cx="12" cy="12" r="4.5" />
        <circle cx="12" cy="12" r="1" />
      </>
    )
  },
  FlagIcon: { label: 'Flag', paths: <path d="M5.5 20.5v-16M5.5 4.5h11l-2 4 2 4h-11" /> },
  BookmarkIcon: { label: 'Bookmark', paths: <path d="M7 4.5h10a1 1 0 0 1 1 1v14l-6-4-6 4v-14a1 1 0 0 1 1-1z" /> },
  BookIcon: {
    label: 'Book',
    paths: <path d="M4.5 18V5.5A1.5 1.5 0 0 1 6 4h13.5v14H6a1.5 1.5 0 0 0 0 3h13.5v-3" />
  },
  LightbulbIcon: {
    label: 'Idea',
    paths: <path d="M9 17.5h6M10 20.5h4M12 3.5a5.5 5.5 0 0 0-3.5 9.8c.6.5 1 1.3 1 2.2h5c0-.9.4-1.7 1-2.2A5.5 5.5 0 0 0 12 3.5z" />
  },
  CodeIcon: { label: 'Code', paths: <path d="M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5M13.5 5l-3 14" /> },
  ChartIcon: { label: 'Chart', paths: <path d="M4.5 4.5v15h15M8.5 15.5v-4M12.5 15.5v-7M16.5 15.5v-5" /> },
  HeartIcon: {
    label: 'Heart',
    paths: <path d="M12 19.5s-7.5-4.4-7.5-9.7A4.3 4.3 0 0 1 12 7.3a4.3 4.3 0 0 1 7.5 2.5c0 5.3-7.5 9.7-7.5 9.7z" />
  },
  GlobeIcon: {
    label: 'Globe',
    paths: (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="M4 12h16M12 4c2.2 2.3 3.2 5 3.2 8s-1 5.7-3.2 8c-2.2-2.3-3.2-5-3.2-8s1-5.7 3.2-8z" />
      </>
    )
  },
  HomeIcon: { label: 'Home', paths: <path d="M4.5 10.5L12 4.5l7.5 6v8.5a1 1 0 0 1-1 1h-4v-5.5h-5V20h-4a1 1 0 0 1-1-1z" /> },
  PhoneIcon: {
    label: 'Phone',
    paths: <path d="M6.5 4h3l1.5 4-2 1.5a10 10 0 0 0 5.5 5.5l1.5-2 4 1.5v3a1.5 1.5 0 0 1-1.6 1.5A15.5 15.5 0 0 1 5 5.6 1.5 1.5 0 0 1 6.5 4z" />
  },
  VideoIcon: {
    label: 'Video',
    paths: (
      <>
        <rect x="3.5" y="6.5" width="12" height="11" rx="2" />
        <path d="M15.5 10.5l5-3v9l-5-3" />
      </>
    )
  },
  CoffeeIcon: {
    label: 'Coffee',
    paths: <path d="M5 9.5h11v5a4.5 4.5 0 0 1-4.5 4.5h-2A4.5 4.5 0 0 1 5 14.5zM16 11h1.5a2.5 2.5 0 0 1 0 5H16M8.5 3.5V6M12 3.5V6" />
  },
  GraduationIcon: {
    label: 'Learning',
    paths: <path d="M2.5 9.5L12 5l9.5 4.5L12 14zM6.5 11.5V16c3 2.3 8 2.3 11 0v-4.5M21.5 9.5v5" />
  },
  MegaphoneIcon: {
    label: 'Announcement',
    paths: <path d="M4 10v4a1 1 0 0 0 1 1h2l8 4.5v-15L7 9H5a1 1 0 0 0-1 1zM18.5 9.5a3.5 3.5 0 0 1 0 5M7.5 15l1 4.5" />
  },
  CompassIcon: {
    label: 'Compass',
    paths: (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="M15 9l-1.8 4.2L9 15l1.8-4.2z" />
      </>
    )
  },
  ShieldIcon: { label: 'Shield', paths: <path d="M12 3.5l7 2.5v5.5c0 4.5-3 7.8-7 9-4-1.2-7-4.5-7-9V6z" /> },
  DollarIcon: {
    label: 'Money',
    paths: (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="M14.5 9.2c-.4-.9-1.4-1.4-2.5-1.4-1.5 0-2.6.8-2.6 2s1.1 1.7 2.6 2 2.6.8 2.6 2.1-1.1 2-2.6 2c-1.2 0-2.2-.5-2.6-1.4M12 6.5v1.3M12 16.2v1.3" />
      </>
    )
  },
  BoltIcon: { label: 'Bolt', paths: <path d="M13 3.5L5.5 13.5H12l-1 7 7.5-10H12z" /> },
  LayersIcon: { label: 'Layers', paths: <path d="M12 4l8.5 4.5L12 13 3.5 8.5zM3.5 12.5L12 17l8.5-4.5M3.5 16.5L12 21l8.5-4.5" /> },
  InboxIcon: { label: 'Inbox', paths: <path d="M4 13.5l2.5-8h11l2.5 8v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM4 13.5h4.5l1 2h5l1-2H20" /> },
  TagIcon: {
    label: 'Tag',
    paths: (
      <>
        <path d="M4 4.5h7l8.5 8.5-6.5 6.5L4 11z" />
        <circle cx="8.3" cy="8.8" r="1.2" />
      </>
    )
  },
  PresentationIcon: {
    label: 'Presentation',
    paths: (
      <>
        <rect x="3.5" y="4.5" width="17" height="11" rx="1.5" />
        <path d="M12 15.5v3M8.5 20.5l3.5-2 3.5 2M8 12l2.5-2.5 2 2 3-3" />
      </>
    )
  },
  PenIcon: { label: 'Pen', paths: <path d="M15.5 4.5l4 4L9 19H5v-4zM13 7l4 4" /> },
  ClipboardIcon: {
    label: 'Checklist',
    paths: (
      <>
        <rect x="5.5" y="5" width="13" height="15.5" rx="2" />
        <path d="M9 5V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1M9 11h6M9 15h4" />
      </>
    )
  }
}

export const FOLDER_ICON_NAMES = Object.keys(FOLDER_ICONS)

/** The colour row: mid tones that read on both themes. The first is the neutral default. */
export const FOLDER_COLORS: readonly { name: string; value: string }[] = [
  { name: 'Grey', value: '#8C8C86' },
  { name: 'Red', value: '#E5534B' },
  { name: 'Orange', value: '#E9822F' },
  { name: 'Yellow', value: '#D29F18' },
  { name: 'Green', value: '#3BA16A' },
  { name: 'Teal', value: '#21A0A0' },
  { name: 'Blue', value: '#3E7BE0' },
  { name: 'Indigo', value: '#5B5BD6' },
  { name: 'Purple', value: '#9558D8' },
  { name: 'Pink', value: '#DB4F8E' }
]

export const DEFAULT_FOLDER_COLOR = '#8C8C86'

/** The "FolderIcon" in grey: the suggestion bar's new-folder icon. */
export const GREY_FOLDER_ICON: TemplateIcon = { type: 'icon', value: 'FolderIcon', color: DEFAULT_FOLDER_COLOR }

/** "Or start from a template": the preset folders' titles, text and icons. */
export const FOLDER_PRESETS: readonly { id: FolderPresetId; title: string; description: string; icon: TemplateIcon }[] = [
  {
    id: 'interviews',
    title: 'User interviews',
    description: 'Research conversations about how people work, what gets in their way and what they need',
    icon: { type: 'icon', value: 'UsersIcon', color: '#3E7BE0' }
  },
  {
    id: 'standups',
    title: 'Standups',
    description: "Short team check-ins on progress, blockers and today's priorities",
    icon: { type: 'icon', value: 'CoffeeIcon', color: '#E9822F' }
  },
  {
    id: 'projects',
    title: 'Projects',
    description: 'Planning and status meetings that track milestones, risks and decisions',
    icon: { type: 'icon', value: 'LayersIcon', color: '#5B5BD6' }
  },
  {
    id: 'sales_pipeline',
    title: 'Sales calls',
    description: 'Conversations with prospects about their needs, objections and pricing',
    icon: { type: 'icon', value: 'DollarIcon', color: '#3BA16A' }
  },
  {
    id: 'team_syncs',
    title: 'Team meetings',
    description: 'Stand-ups, planning sessions and other meetings with your team',
    icon: { type: 'icon', value: 'ChatIcon', color: '#21A0A0' }
  },
  {
    id: 'coaching',
    title: 'Coaching / Advisory',
    description: 'Sessions where you get guidance and feedback on your work',
    icon: { type: 'icon', value: 'CompassIcon', color: '#9558D8' }
  },
  {
    id: 'demos',
    title: 'Product demos',
    description: 'Walkthroughs of the product for prospects, customers or the team',
    icon: { type: 'icon', value: 'PresentationIcon', color: '#DB4F8E' }
  }
]

/** Upper-case hex code points joined by `-`. */
export function emojiHexcode(emoji: string): string {
  return [...emoji].map((c) => (c.codePointAt(0) ?? 0).toString(16).toUpperCase()).join('-')
}

/** A folder's icon: a named icon in its colour, an emoji, or the default folder. */
export function FolderGlyph({ icon, size = 16, className }: { icon: TemplateIcon | null | undefined; size?: number; className?: string }): JSX.Element {
  if (icon?.type === 'emoji') {
    return (
      <span
        className={`folder-glyph folder-glyph--emoji${className ? ` ${className}` : ''}`}
        style={{ width: size, height: size, fontSize: Math.round(size * 0.9) }}
        aria-hidden="true"
      >
        {icon.value}
      </span>
    )
  }
  const entry = (icon?.type === 'icon' && FOLDER_ICONS[icon.value]) || FOLDER_ICONS['FolderIcon']
  return (
    <Svg size={size} className={`folder-glyph${className ? ` ${className}` : ''}`} style={icon?.type === 'icon' ? { color: icon.color } : undefined}>
      {entry?.paths}
    </Svg>
  )
}

// ---------- UI icons ----------

export function IconFolder(p: IconProps): JSX.Element {
  return <Svg {...p}>{FOLDER_ICONS['FolderIcon']?.paths}</Svg>
}

export function IconFolderPlus(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M20.5 12V10a2 2 0 0 0-2-2h-7l-2-2.5h-4a2 2 0 0 0-2 2V16a2 2 0 0 0 2 2h7M18 14.5v6M15 17.5h6" />
    </Svg>
  )
}

export function IconFolderMinus(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M20.5 13V10a2 2 0 0 0-2-2h-7l-2-2.5h-4a2 2 0 0 0-2 2V16a2 2 0 0 0 2 2h8M15 17.5h6" />
    </Svg>
  )
}

export function IconStar({ filled, ...p }: IconProps & { filled?: boolean }): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 4l2.5 5.1 5.6.8-4 3.9.9 5.6L12 16.8 7 19.4l.9-5.6-4-3.9 5.6-.8z" fill={filled ? 'currentColor' : 'none'} />
    </Svg>
  )
}

export function IconChevronRight(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M9 6l6 6-6 6" />
    </Svg>
  )
}

export function IconCaretDown(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6 9l6 6 6-6" />
    </Svg>
  )
}

export function IconDots(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="6" cy="12" r="0.9" fill="currentColor" />
      <circle cx="12" cy="12" r="0.9" fill="currentColor" />
      <circle cx="18" cy="12" r="0.9" fill="currentColor" />
    </Svg>
  )
}

export function IconSpaces(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 4l8.5 4.5L12 13 3.5 8.5zM3.5 12.5L12 17l8.5-4.5" />
    </Svg>
  )
}

export function IconArrowLeft(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </Svg>
  )
}

export function IconSparkles(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M10 4.5l1.6 4.4L16 10.5l-4.4 1.6L10 16.5l-1.6-4.4L4 10.5l4.4-1.6zM17.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
    </Svg>
  )
}
