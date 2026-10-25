// SPDX-License-Identifier: Apache-2.0
// The renderer entry. One bundle serves every window: the hash route picks a lazy
// root, so a secondary window loads only its own chunk.

import { lazy, StrictMode, Suspense, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

/**
 * `#/bubble`, `#/bubble-transcript`, `#/bubble-inactivity`, `#/notification`, then the
 * feature windows below. Anything else is App.
 */
function rootFor(hash: string): ComponentType {
  const path = hash.replace(/^#/, '').split('?')[0]
  switch (path) {
    case '/bubble':
      return lazy(() => import('./features/bubble').then((m) => ({ default: m.BubbleRoot })))
    case '/bubble-transcript':
      return lazy(() => import('./features/bubble').then((m) => ({ default: m.BubbleTranscriptRoot })))
    case '/bubble-inactivity':
      return lazy(() => import('./features/bubble').then((m) => ({ default: m.BubbleInactivityRoot })))
    case '/notification':
      return lazy(() => import('./features/notify').then((m) => ({ default: m.NotificationRoot })))
    // ---------- feature windows ----------
    case '/captions':
      return lazy(() => import('./features/captions').then((m) => ({ default: m.CaptionsRoot })))
    case '/media-worker':
      return lazy(() => import('./features/imports').then((m) => ({ default: m.MediaWorkerRoot })))
    case '/demo':
      return lazy(() => import('./features/demo').then((m) => ({ default: m.DemoRoot })))
    case '/snapshot-picker':
      return lazy(() => import('./features/snapshots').then((m) => ({ default: m.SnapshotPickerRoot })))
    case '/snapshot-region':
      return lazy(() => import('./features/snapshots').then((m) => ({ default: m.SnapshotRegionRoot })))
    case '/screen-guide':
      return lazy(() => import('./features/screen-guide').then((m) => ({ default: m.ScreenGuideRoot })))
    case '/screen-guide-spotlight':
      return lazy(() => import('./features/screen-guide').then((m) => ({ default: m.ScreenGuideSpotlightRoot })))
    case '/quick-ask':
      return lazy(() => import('./features/quick-ask').then((m) => ({ default: m.QuickAskRoot })))
    case '/dictation-pill':
      return lazy(() => import('./features/dictation').then((m) => ({ default: m.DictationPillRoot })))
    case '/dictation-bar-menu':
      return lazy(() => import('./features/dictation').then((m) => ({ default: m.DictationBarMenuRoot })))
    case '/screen-corner':
      return lazy(() => import('./features/window-modes').then((m) => ({ default: m.ScreenCornerRoot })))
    case '/window-preview':
      return lazy(() => import('./features/window-modes').then((m) => ({ default: m.WindowPreviewRoot })))
    // ---------- the meeting dock, live context and reminder cards windows ----------
    case '/meeting-dock':
      return lazy(() => import('./features/meeting-dock').then((m) => ({ default: m.MeetingDockRoot })))
    case '/live-context':
      return lazy(() => import('./features/live-context').then((m) => ({ default: m.LiveContextRoot })))
    case '/reminder-cards':
      return lazy(() => import('./features/reminder-cards').then((m) => ({ default: m.ReminderCardsRoot })))
    default:
      return lazy(() => import('./App').then((m) => ({ default: m.App })))
  }
}

const root = document.getElementById('root')
if (!root) throw new Error('#root missing from index.html')

const Root = rootFor(window.location.hash)

createRoot(root).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Root />
    </Suspense>
  </StrictMode>
)
