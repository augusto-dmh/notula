// SPDX-License-Identifier: Apache-2.0
// Settings, permissions and onboarding. SettingsPage and PermissionsPage take no props;
// OnboardingGate renders its children once onboarding is done.
//
// The theme controller starts when the app loads, so the stored theme applies
// before the first page renders.

import { startThemeController } from './theme'

startThemeController()

export { OnboardingGate } from './OnboardingGate'
export { PermissionsPage } from './PermissionsPage'
export { SettingsPage } from './SettingsPage'
// Layout primitives other features' settings pages build on.
export { SettingsCard, SettingsRow, SettingsSectionHeading } from './primitives'
