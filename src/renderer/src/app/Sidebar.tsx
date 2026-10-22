// SPDX-License-Identifier: Apache-2.0
// The main window's sidebar. Two lists in one container:
// - notes: New note; Home, Chat, Recipes, action items, Scratchpad (while
//   `scratchpad.enabled`); Templates; search; folders, then company favorites;
//   footer: Install update, People and Companies, Trash, Settings;
// - on `/settings/*`: the Settings sections, with Back to the page before Settings;
//   Troubleshooting (and Developer tools) under a "Get help" heading, Voice typing with `Beta`.
// An item is active on its path and below it. Pressing an item never moves focus, and
// a pick closes the sidebar when it is open over the page.
// Tasks, Dispatches and Wiki come after action items; Customer calls sits with the
// folders; What's new above the footer; the Local only badge in the footer.

import type { JSX, MouseEvent, ReactNode } from 'react'
import { SidebarActionItemsLink } from '../features/action-items'
import { SidebarCompanyFavorites } from '../features/companies'
import { SidebarCustomerCallsLink } from '../features/crm'
import { SidebarDispatchesLink } from '../features/dispatch'
import { SidebarFolders } from '../features/folders'
import { LocalOnlyBadge } from '../features/local-only'
import { startNewNote } from '../features/new-note'
import { WhatsNewCard } from '../features/nux'
import { SidebarPeopleButtons } from '../features/people'
import { SidebarSearchLink } from '../features/search'
import { usePrefs } from '../features/settings/prefs-store'
import { useSettingsSections } from '../features/settings/sections'
import { SidebarTasksLink } from '../features/tasks'
import { openTemplateGallery } from '../features/templates'
import { TrashButton } from '../features/trash'
import { SidebarUserContextLink } from '../features/user-context'
import {
  IconArrowLeft,
  IconBook,
  IconLayout,
  IconNote,
  IconPencil,
  IconPlus,
  IconSettings,
  IconSidebar,
  IconSparkle,
  NotulaMark
} from './icons'
import { isSettingsPath, leaveSettings, navigate, navigateToSettings, useRoute } from './navigation'
import { isMac } from './platform'
import { closeSidebarOverlay, toggleSidebar } from './sidebar-state'
import { UpdateButton } from './shell'

const keepFocus = (e: MouseEvent): void => e.preventDefault()

function Item({
  label,
  icon,
  active,
  onPick,
  dense,
  badge
}: {
  label: string
  icon: ReactNode
  active?: boolean
  onPick(): void
  dense?: boolean
  badge?: string
}): JSX.Element {
  return (
    <button
      type="button"
      className={`app-sidebar__item${dense ? ' app-sidebar__item--dense' : ''}`}
      aria-current={active ? 'page' : undefined}
      onMouseDown={keepFocus}
      onClick={() => {
        onPick()
        closeSidebarOverlay()
      }}
    >
      {icon}
      <span className="app-sidebar__label">{label}</span>
      {badge ? <span className="app-sidebar__badge">{badge}</span> : null}
    </button>
  )
}

export function SidebarToggle({ label, align }: { label: string; align: 'start' | 'end' }): JSX.Element {
  return (
    <span className={`n-tooltip n-tooltip--${align}`} data-tooltip={`${label} (${isMac ? '⌘' : 'Ctrl'} S)`}>
      <button type="button" className="n-icon-btn app-sidebar__toggle" aria-label={label} onClick={toggleSidebar}>
        <IconSidebar size={18} />
      </button>
    </span>
  )
}

function NotesList({ path }: { path: string }): JSX.Element {
  const under = (p: string): boolean => path === p || path.startsWith(`${p}/`)
  const prefs = usePrefs()
  return (
    <>
      <div className="app-sidebar__group">
        <Item
          label="New note"
          icon={<IconPlus size={16} />}
          onPick={() => void startNewNote({ creationSource: 'new_note_button', autoTranscribe: true })}
        />
      </div>
      <div className="app-sidebar__group">
        <Item label="Home" icon={<IconNote size={16} />} active={path === '/'} onPick={() => navigate('/')} />
        <Item label="Chat" icon={<IconSparkle size={16} />} active={under('/chat')} onPick={() => navigate('/chat')} />
        <Item label="Recipes" icon={<IconBook size={16} />} active={under('/recipes')} onPick={() => navigate('/recipes')} />
        <SidebarActionItemsLink />
        {/* Tasks, Dispatches and Wiki, each null while its switch is off. */}
        <SidebarTasksLink />
        <SidebarDispatchesLink />
        <SidebarUserContextLink />
        {prefs?.['scratchpad.enabled'] ? (
          <Item
            label="Scratchpad"
            icon={<IconPencil size={16} />}
            active={under('/scratchpad')}
            onPick={() => navigate('/scratchpad')}
          />
        ) : null}
        <Item label="Templates" icon={<IconLayout size={16} />} onPick={() => openTemplateGallery({ mode: 'manage' })} />
        <SidebarSearchLink />
      </div>
      <SidebarFolders />
      {/* The Customer calls view, null unless `customerCalls.enabled`. */}
      <SidebarCustomerCallsLink />
      <SidebarCompanyFavorites />
      <div className="app-sidebar__spacer" />
      {/* The What's new card, above the footer. */}
      <WhatsNewCard />
      <div className="app-sidebar__footer">
        <UpdateButton />
        {/* The Local only badge, null while local-only is off. */}
        <LocalOnlyBadge />
        <SidebarPeopleButtons />
        <TrashButton />
        <Item
          label="Settings"
          icon={<IconSettings size={16} />}
          active={isSettingsPath(path)}
          onPick={() => navigateToSettings('preferences')}
        />
      </div>
    </>
  )
}

/** The Settings sections; Troubleshooting sits under "Get help", and Developer tools after it. */
function SettingsList({ section }: { section: string | undefined }): JSX.Element {
  const sections = useSettingsSections().filter((s) => !s.hidden)
  const item = (s: (typeof sections)[number]): JSX.Element => (
    <Item
      key={s.id}
      dense
      label={s.label}
      icon={s.icon(16)}
      badge={s.badge}
      active={section === s.id || (section === undefined && s.id === 'preferences')}
      onPick={() => navigateToSettings(s.id)}
    />
  )
  const firstHelp = sections.findIndex((s) => s.group === 'help')
  const main = firstHelp < 0 ? sections : sections.slice(0, firstHelp)
  const rest = firstHelp < 0 ? [] : sections.slice(firstHelp)
  return (
    <>
      <div className="app-sidebar__group">{main.map(item)}</div>
      {rest.length > 0 ? (
        <div className="app-sidebar__group" role="group" aria-labelledby="settings-help-heading">
          <div className="app-sidebar__heading" id="settings-help-heading">
            Get help
          </div>
          {rest.map(item)}
        </div>
      ) : null}
    </>
  )
}

export function Sidebar(): JSX.Element {
  const { path, params } = useRoute()
  const settings = isSettingsPath(path)
  return (
    <nav className="app-sidebar" aria-label={settings ? 'Settings' : 'Notula'}>
      <div className="app-sidebar__header">
        {settings ? (
          <button
            type="button"
            className="app-sidebar__back"
            onMouseDown={keepFocus}
            onClick={() => {
              leaveSettings()
              closeSidebarOverlay()
            }}
          >
            <IconArrowLeft size={16} />
            Settings
          </button>
        ) : (
          <span className="app-sidebar__brand">
            <NotulaMark size={20} />
            Notula
          </span>
        )}
        <SidebarToggle label="Hide sidebar" align="end" />
      </div>
      {settings ? <SettingsList section={params['section']} /> : <NotesList path={path} />}
    </nav>
  )
}
