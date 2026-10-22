// SPDX-License-Identifier: Apache-2.0
// The onboarding guard.
//
// Steps, in order: permissions, then AI providers (skippable), then the calendar step
// once calendar sync ships (`calendarEnabled()`, `CalendarOnboardingStep`; done when
// `onboarding.calendarDoneAt` is set). Until every step is done nothing else renders,
// Settings included; while the state is unknown the splash stays up. Steps render in
// place, so when they finish the original route renders. `/permissions` is itself a
// step route: it needs no earlier step, so it renders.
//
// An unreadable settings record reads as the defaults, so onboarding shows again; the
// stored record itself is never touched.
//
// - Permissions are done when the record has microphone and system audio granted.
//   Once the step is shown it stays until Continue, even once both are granted.
// - AI providers are done once `onboarding.aiProvidersDoneAt` is set.
// - `onboarding:set-state` is sent on every change.
// - macOS, once per launch: a silent system-audio refresh when both are
//   already granted, or one re-run when the "requesting" mark survived a restart.
//
// After onboarding it also hosts the app-level permission banners and the
// `settings:open` listener.

import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { useRoute } from '../../app/navigation'
import { CalendarOnboardingStep, calendarEnabled } from '../calendar'
import { AiProvidersStep } from '../onboarding/AiProvidersStep'
import { PermissionBanners } from '../onboarding/PermissionBanners'
import { PermissionsCard } from '../onboarding/PermissionsCard'
import { requestSystemAudio, usePermissions } from '../onboarding/permissions-store'
import { setPrefs, usePrefs } from './prefs-store'
import { useSettingsOpenListener } from './SettingsPage'
import '../onboarding/onboarding.css'

type Step = 'unknown' | 'permissions' | 'ai-providers' | 'calendar' | null

let startupRefreshDone = false

export function OnboardingGate({ children }: { children: ReactNode }): JSX.Element {
  useSettingsOpenListener()
  const { path } = useRoute()
  const prefs = usePrefs()
  const perms = usePermissions()
  /** The permissions step was shown this session: it stays until Continue. */
  const [permissionsOpen, setPermissionsOpen] = useState(false)

  const permissionsDone = perms ? perms.microphone === 'granted' && perms.systemAudio === 'granted' : null
  const aiDone = prefs ? prefs['onboarding.aiProvidersDoneAt'] !== null : null
  const calendarDone = prefs ? !calendarEnabled() || prefs['onboarding.calendarDoneAt'] !== null : null
  const onStepRoute = path === '/permissions'

  useEffect(() => {
    if (permissionsDone === false) setPermissionsOpen(true)
  }, [permissionsDone])

  // macOS startup refresh, once per launch.
  useEffect(() => {
    if (!perms || startupRefreshDone) return
    startupRefreshDone = true
    if (perms.platform !== 'darwin') return
    const bothGranted = perms.microphone === 'granted' && perms.systemAudio === 'granted'
    if (bothGranted || perms.requestingSystemAudio) void requestSystemAudio().catch(() => undefined)
  }, [perms])

  let step: Step
  if (onStepRoute) step = permissionsDone === null ? 'unknown' : null
  else if (permissionsDone === null || aiDone === null) step = 'unknown'
  else if (!permissionsDone || permissionsOpen) step = 'permissions'
  else if (!aiDone) step = 'ai-providers'
  else if (!calendarDone) step = 'calendar'
  else step = null

  const inOnboarding = step !== null || onStepRoute
  useEffect(() => {
    window.notula.onboarding.setState({ inOnboarding })
  }, [inOnboarding])

  if (step === 'unknown') return <div className="onb-splash" aria-busy="true" />
  if (step === 'permissions') {
    return (
      <main className="onb-step onb-step--center">
        <PermissionsCard onContinue={() => setPermissionsOpen(false)} />
      </main>
    )
  }
  if (step === 'ai-providers' && prefs) return <AiProvidersStep prefs={prefs} />
  if (step === 'calendar') {
    return (
      <main className="onb-step onb-step--center">
        <CalendarOnboardingStep onDone={() => setPrefs({ 'onboarding.calendarDoneAt': new Date().toISOString() })} />
      </main>
    )
  }

  return (
    <div className="onb-shell">
      <PermissionBanners />
      <div className="onb-shell__content">{children}</div>
    </div>
  )
}
