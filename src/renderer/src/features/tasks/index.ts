// SPDX-License-Identifier: Apache-2.0
// The Tasks page: `/tasks` and its sidebar link with the open-task badge
// (`tasks:get-badge`). The link is null while `tasks.enabled` is off; the route stays reachable.

import { createElement, useEffect, useState, type JSX } from 'react'
import { IconCheckbox } from '../../app/icons'
import { navigate, useRoute } from '../../app/navigation'
import { closeSidebarOverlay } from '../../app/sidebar-state'
import { usePrefs } from '../settings/prefs-store'
import { TasksPageView } from './TasksPage'

export function TasksPage(): JSX.Element {
  return createElement(TasksPageView)
}

function useBadge(on: boolean): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (!on) return
    let cancelled = false
    const load = (): void => {
      window.notula.tasks
        .getBadge()
        .then((r) => {
          if (!cancelled) setCount(r.openCount)
        })
        .catch(() => undefined)
    }
    load()
    const off = window.notula.tasks.onChanged(load)
    return () => {
      cancelled = true
      off()
    }
  }, [on])
  return on ? count : 0
}

export function SidebarTasksLink(): JSX.Element | null {
  const prefs = usePrefs()
  const { path } = useRoute()
  const on = prefs?.['tasks.enabled'] === true
  const count = useBadge(on)
  if (!on) return null
  const active = path === '/tasks'
  return createElement(
    'button',
    {
      type: 'button',
      className: 'app-sidebar__item',
      'aria-current': active ? 'page' : undefined,
      onMouseDown: (e: { preventDefault(): void }) => e.preventDefault(),
      onClick: () => {
        navigate('/tasks')
        closeSidebarOverlay()
      }
    },
    createElement(IconCheckbox, { size: 16 }),
    createElement('span', { className: 'app-sidebar__label' }, 'Tasks'),
    count > 0 ? createElement('span', { className: 'app-sidebar__badge', 'aria-label': `${count} open` }, count > 99 ? '99+' : String(count)) : null
  )
}
