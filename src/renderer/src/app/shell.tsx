// SPDX-License-Identifier: Apache-2.0
// The app shell: the window layout with its sidebar, the crash
// screen, the deep-link listener, the sidebar's update button, and the reports main
// needs about the window (viewing note, last interaction).

import {
  Component,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ErrorInfo,
  type JSX,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import type { DeepLinkEvent } from '@shared/types/app'
import { startNewNote } from '../features/new-note'
import { IconAlert, IconDownload } from './icons'
import { isKnownRoute, isSettingsPath, navigate, navigateToSettings, useRoute } from './navigation'
import { debugLog, isMac, isMod } from './platform'
import { clampWidth, closeSidebarOverlay, saveSidebarWidth, toggleSidebar, useSidebar } from './sidebar-state'
import { showToast } from './toast'
import { reloadUpdateState, useUpdateState } from './update-store'
import './sidebar.css'

/** Notula's issue page and release page (the download page). */
export const NOTULA_ISSUES_URL = 'https://github.com/augusto-dmh/notula/issues'
export const NOTULA_RELEASES_URL = 'https://github.com/augusto-dmh/notula/releases'

// ---------- layout ----------

/** Mod+S toggles the sidebar; Escape closes it over the page. */
function useSidebarKeys(overlay: boolean): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isMod(e) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        toggleSidebar()
      } else if (e.key === 'Escape' && overlay) {
        closeSidebarOverlay()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [overlay])
}

function ResizeHandle({ width, onDrag }: { width: number; onDrag(w: number | null): void }): JSX.Element {
  const drag = useRef<{ startX: number; startWidth: number; last: number } | null>(null)
  const limit = (w: number): number => clampWidth(Math.min(w, window.innerWidth - 600))

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { startX: e.clientX, startWidth: width, last: width }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    d.last = limit(d.startWidth + e.clientX - d.startX)
    onDrag(d.last)
  }
  const onPointerUp = (): void => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.last !== d.startWidth) saveSidebarWidth(d.last)
    onDrag(null)
  }
  return (
    <div
      className="app-sidebar-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  )
}

/** The main window: the sidebar on the left (docked, or over the page when narrow), the routed page on the right. */
export function Layout({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }): JSX.Element {
  const view = useSidebar()
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  useSidebarKeys(view.overlay)
  const width = dragWidth ?? view.width
  const shown = view.docked || view.overlay

  return (
    <div
      className={`app-layout${dragWidth !== null ? ' app-layout--resizing' : ''}`}
      style={{ '--sidebar-width': `${width}px` } as CSSProperties}
    >
      {shown ? (
        <aside className={`app-sidebar-shell${view.overlay ? ' app-sidebar-shell--overlay' : ''}`}>
          {sidebar}
          {view.docked ? <ResizeHandle width={width} onDrag={setDragWidth} /> : null}
        </aside>
      ) : null}
      {view.overlay ? <div className="app-sidebar-scrim" onClick={closeSidebarOverlay} /> : null}
      <main className="app-layout__main">{children}</main>
    </div>
  )
}

// ---------- crash screen ----------

/**
 * A render error replaces the app with a short explanation, a Relaunch button and a footer
 * link. The button relaunches through `app:relaunch`. It never offers to clear data.
 */
export class CrashBoundary extends Component<{ children: ReactNode }, { failed: boolean; restarting: boolean }> {
  state = { failed: false, restarting: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    debugLog('renderer-crash', { message: error.message, stack: info.componentStack ?? '' })
  }

  private restart = (): void => {
    this.setState({ restarting: true })
    window.notula.app.relaunch().catch(() => window.location.reload())
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div className="crash-screen" role="alert">
        <div className="crash-screen__card">
          <span className="crash-screen__icon">
            <IconAlert size={22} />
          </span>
          <h1 className="crash-screen__title">Something went wrong</h1>
          <p className="crash-screen__text">Notula ran into an unexpected error. Restarting usually fixes it.</p>
          <button type="button" className="n-btn n-btn--primary" disabled={this.state.restarting} onClick={this.restart}>
            {this.state.restarting ? 'Restarting…' : 'Restart Notula'}
          </button>
        </div>
        <p className="crash-screen__footer">
          If this problem persists, report it on{' '}
          <a href={NOTULA_ISSUES_URL} target="_blank" rel="noreferrer">
            Notula’s issue page
          </a>
          .
        </p>
      </div>
    )
  }
}

// ---------- deep links ----------

const UNSUPPORTED_LINK_ERROR = 'Notula can’t open this link. It may need a newer version, so check for updates and try again.'
const RECENT_MS = 1_000
const recent = new Map<string, number>()

/** The renderer's own 1 s guard. */
function isRecent(event: DeepLinkEvent): boolean {
  const key = JSON.stringify(event)
  const now = Date.now()
  for (const [k, t] of recent) if (now - t >= RECENT_MS) recent.delete(k)
  const seen = recent.has(key)
  recent.set(key, now)
  return seen
}

function handleDeepLink(event: DeepLinkEvent): void {
  if (isRecent(event)) {
    debugLog('deeplink:duplicate', { type: event.type })
    return
  }
  debugLog('deeplink:received', { type: event.type })
  switch (event.type) {
    case 'open': {
      if (!event.data.path) return
      let pathname: string
      try {
        // Pathname only: the query and the fragment are dropped.
        pathname = new URL(event.data.path, 'https://notula.invalid').pathname
      } catch {
        debugLog('deeplink:open-unparsable')
        return
      }
      if (!isKnownRoute(pathname)) {
        debugLog('deeplink:open-unknown-route', { pathname })
        return
      }
      if (isSettingsPath(pathname)) navigateToSettings(pathname.split('/')[2] || 'preferences')
      else navigate(pathname)
      return
    }
    case 'new-note':
      void startNewNote({
        creationSource: event.data.creationSource,
        autoTranscribe: event.data.autoTranscribe,
        ...(event.data.event ? { event: event.data.event } : {})
      })
      return
    case 'show-note': {
      const source = event.data.openSource ?? 'deep_link'
      navigate(`/meeting/${encodeURIComponent(event.data.documentId)}?opened_from=${source}`)
      return
    }
    case 'show-settings':
      navigateToSettings(event.data.page)
  }
}

/**
 * Mounted once inside the gates. It subscribes to unsupported links, fetches the
 * pending event with `deeplink:get-pending` (which also tells main its pushes can now
 * be received), and only then listens for `deeplink:received`. Bubble and
 * notification clicks arrive the same way as `show-note`.
 */
export function DeepLinkListener(): null {
  useEffect(() => {
    let disposed = false
    let offReceived: (() => void) | null = null
    const offUnsupported = window.notula.deeplink.onUnsupported(({ reason }) => {
      debugLog('deeplink:unsupported', { reason })
      showToast({ id: 'deeplink-unsupported', kind: 'error', title: UNSUPPORTED_LINK_ERROR })
    })
    window.notula.deeplink
      .getPending()
      .then((event) => {
        // A fetched event is main's to forget, so it runs even if this mount is gone.
        if (event) handleDeepLink(event)
        if (disposed) return
        offReceived = window.notula.deeplink.onReceived(handleDeepLink)
      })
      .catch((err: unknown) => debugLog('deeplink:get-pending-failed', { err: String(err) }))
    return () => {
      disposed = true
      offUnsupported()
      offReceived?.()
    }
  }, [])
  return null
}

// ---------- the update button ----------

/** The sidebar footer's "Install update"; null until a download is ready. */
export function UpdateButton(): JSX.Element | null {
  const state = useUpdateState()
  const [busy, setBusy] = useState(false)
  if (!state || state.download.state !== 'downloaded') return null

  const install = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.notula.update.install()
    } catch (err) {
      debugLog('update:install-failed', { err: String(err) })
      const next = await reloadUpdateState()
      // Still downloaded: the button works again. Otherwise the release page opens.
      if (next?.download.state !== 'downloaded') window.open(NOTULA_RELEASES_URL, '_blank')
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      className="n-btn n-btn--ghost app-sidebar__item app-sidebar__update"
      title={isMac ? undefined : 'Install update'}
      disabled={busy || state.installing}
      onClick={() => void install()}
    >
      <IconDownload size={16} />
      {state.installing ? 'Installing…' : 'Install update'}
    </button>
  )
}

// ---------- what main needs to know about the window ----------

const INTERACTION_THROTTLE_MS = 30_000

/**
 * Reports the note on screen (`app:viewing-note`, on every route change and on
 * visibility change) and user activity (`app:user-interacted`, at most every 30 s).
 * Main reads them for the updater's install rules and the notification rules.
 */
export function ShellReporters(): null {
  const { path, params } = useRoute()
  const noteId = path.startsWith('/meeting/') ? (params['id'] ?? null) : null

  useEffect(() => {
    const send = (): void =>
      window.notula.app.setViewingNote({ noteId: document.visibilityState === 'visible' ? noteId : null })
    send()
    document.addEventListener('visibilitychange', send)
    return () => document.removeEventListener('visibilitychange', send)
  }, [noteId])

  useEffect(() => {
    let last = 0
    const report = (): void => {
      const now = Date.now()
      if (now - last < INTERACTION_THROTTLE_MS) return
      last = now
      window.notula.app.reportInteraction()
    }
    const events = ['pointerdown', 'pointermove', 'wheel', 'keydown'] as const
    for (const ev of events) window.addEventListener(ev, report, { capture: true, passive: true })
    return () => {
      for (const ev of events) window.removeEventListener(ev, report, { capture: true })
    }
  }, [])

  return null
}
