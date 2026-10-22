// SPDX-License-Identifier: Apache-2.0
// The demo meeting: the #/demo stage window, the App
// host that registers the palette command, and the note dock bar of a demo note.

import { createElement, useEffect, type JSX } from 'react'
import { registerCommands } from '../../app/commands'
import { DemoBar } from './DemoNoteBar'
import { DemoStage } from './DemoStage'
import { startDemo } from './store'

export { DemoComingUpRow } from './DemoRow'

/** `#/demo`. */
export function DemoRoot(): JSX.Element {
  return createElement(DemoStage)
}

/** App host: registers "Start demo meeting" through `app/commands.ts` (always available). */
export function DemoHost(): null {
  useEffect(
    () =>
      registerCommands('demo', () => [
        {
          id: 'demo:start',
          label: 'Start demo meeting',
          group: 'general',
          keywords: ['demo', 'tour', 'tutorial', 'try'],
          run: () => startDemo('command_palette')
        }
      ]),
    []
  )
  return null
}

/** NotePage's dock for a demo note, in place of MeetingControls. */
export function DemoNoteBar({ noteId }: { noteId: string }): JSX.Element | null {
  return createElement(DemoBar, { noteId })
}
