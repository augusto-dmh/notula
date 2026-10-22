// SPDX-License-Identifier: Apache-2.0
// The sidebar's company favorites: shown while the
// Labs switch `companies.sidebarFavorites` is on. A folder's company row dragged onto the
// sidebar adds it; the × on a row removes it.

import { useEffect, useState, type DragEvent, type JSX } from 'react'
import { IconClose } from '../../app/icons'
import { navigate, useRoute } from '../../app/navigation'
import { closeSidebarOverlay } from '../../app/sidebar-state'
import { usePrefs } from '../settings/prefs-store'
import { CompanyLogo } from './CompanyLogo'
import { addFavorite, COMPANY_FAVORITE_MIME, removeFavorite } from './favorites'

/** Whether a company row is being dragged anywhere in the window (the drop zone shows then). */
function useCompanyDrag(): boolean {
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    const start = (e: globalThis.DragEvent): void => {
      if (e.dataTransfer?.types.includes(COMPANY_FAVORITE_MIME)) setDragging(true)
    }
    const end = (): void => setDragging(false)
    window.addEventListener('dragstart', start)
    window.addEventListener('dragend', end)
    window.addEventListener('drop', end)
    return () => {
      window.removeEventListener('dragstart', start)
      window.removeEventListener('dragend', end)
      window.removeEventListener('drop', end)
    }
  }, [])
  return dragging
}

export function SidebarCompanyFavoritesView(): JSX.Element | null {
  const prefs = usePrefs()
  const { path } = useRoute()
  const dragging = useCompanyDrag()
  const [over, setOver] = useState(false)
  if (prefs?.['companies.sidebarFavorites'] !== true) return null
  const list = prefs['companies.favorites'] ?? []
  if (list.length === 0 && !dragging) return null

  const dropProps = {
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(COMPANY_FAVORITE_MIME)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setOver(true)
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
    },
    onDrop: (e: DragEvent) => {
      setOver(false)
      if (!e.dataTransfer.types.includes(COMPANY_FAVORITE_MIME)) return
      e.preventDefault()
      try {
        const f = JSON.parse(e.dataTransfer.getData(COMPANY_FAVORITE_MIME)) as { domain?: unknown; name?: unknown }
        if (typeof f.domain === 'string') addFavorite({ domain: f.domain, name: typeof f.name === 'string' ? f.name : f.domain })
      } catch {
        // Not a company row.
      }
    }
  }

  return (
    <section className={`sidebar-companies${over ? ' is-drop' : ''}`} aria-label="Company favorites" {...dropProps}>
      <div className="sidebar-folders__heading">Companies</div>
      {list.length === 0 ? <div className="sidebar-companies__hint">Drop a company here</div> : null}
      <ul className="sidebar-companies__list">
        {list.map((f) => {
          const active = path === `/company/${encodeURIComponent(f.domain)}` || path === `/company/${f.domain}`
          return (
            <li key={f.domain} className={`sidebar-companies__row${active ? ' is-active' : ''}`}>
              <button
                type="button"
                className="sidebar-companies__link"
                aria-current={active ? 'page' : undefined}
                title={f.domain}
                onClick={() => {
                  navigate(`/company/${encodeURIComponent(f.domain)}`)
                  closeSidebarOverlay()
                }}
              >
                <CompanyLogo domain={f.domain} name={f.name} size={16} />
                <span className="sidebar-companies__name">{f.name}</span>
              </button>
              <button type="button" className="sidebar-companies__remove" aria-label={`Remove ${f.name} from favorites`} onClick={() => removeFavorite(f.domain)}>
                <IconClose size={11} />
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
