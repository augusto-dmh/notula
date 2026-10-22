// SPDX-License-Identifier: Apache-2.0
// Calendar and people in the renderer: the home page's Coming up, Settings ▸ Calendar,
// the note header's attendees, the onboarding calendar step and the People preference rows.

import { createElement, type JSX } from 'react'
import { CalendarOnboarding } from './CalendarOnboardingStep'
import { CalendarSettingsPage } from './CalendarSettings'
import { NoteAttendeesView } from './NoteAttendees'
import { PeoplePreferences } from './PeoplePreferencesRows'

/** Home: "Coming up". */
export { UpcomingMeetings } from './UpcomingMeetings'

/** `/person/<email>`, opened by the command palette's People group. */
export { PersonPage } from './PersonPage'

/** Settings ▸ Calendar. */
export function CalendarSettings(): JSX.Element {
  return createElement(CalendarSettingsPage)
}

/** The note header's date and attendee trigger, with the people and event popover; sends `calendar:viewing-event`. */
export function NoteAttendees({ noteId }: { noteId: string }): JSX.Element | null {
  return createElement(NoteAttendeesView, { noteId })
}

/** The onboarding step after AI providers, shown once `calendarEnabled()`. */
export function CalendarOnboardingStep({ onDone }: { onDone(): void }): JSX.Element {
  return createElement(CalendarOnboarding, { onDone })
}

/** Gates Settings ▸ Calendar and the onboarding step. */
export function calendarEnabled(): boolean {
  return true
}

/** Settings ▸ Preferences: the Gravatar switch and the generic-domain editor. */
export function PeoplePreferencesRows(): JSX.Element {
  return createElement(PeoplePreferences)
}
