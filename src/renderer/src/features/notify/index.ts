// SPDX-License-Identifier: Apache-2.0
// Notification windows and their settings page.
// `NotificationRoot` is the lazy root of the #/notification window; it never mounts
// StorageGate, OnboardingGate or CaptureEngineHost.

import { createElement, lazy, Suspense, type JSX } from 'react'
import { NotificationCard } from './NotificationCard'

export function NotificationRoot(): JSX.Element {
  return createElement(NotificationCard)
}

// Lazy: the page uses the Settings primitives, which the notification window must not load.
const LazySettings = lazy(() => import('./NotificationsSettings').then((m) => ({ default: m.NotificationsSettings })))

/** Settings ▸ Notifications. */
export function NotificationsSettings(): JSX.Element {
  return createElement(Suspense, { fallback: null }, createElement(LazySettings))
}
