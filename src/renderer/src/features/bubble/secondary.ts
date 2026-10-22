// SPDX-License-Identifier: Apache-2.0
// Shared setup for the meeting windows (bubble, bubble panels, notifications): a
// transparent page, so each window draws only its own rounded card, and the bubble
// family's fixed dark look. Notification cards follow the
// OS / app theme through prefers-color-scheme, which main keeps in step.

import { useEffect } from 'react'
import './secondary.css'

export function useSecondaryWindow(kind: 'bubble' | 'bubble-transcript' | 'bubble-inactivity' | 'notification'): void {
  useEffect(() => {
    const html = document.documentElement
    html.classList.add('nt-secondary', `nt-secondary--${kind}`)
    if (kind !== 'notification') html.dataset['theme'] = 'dark'
    return () => {
      html.classList.remove('nt-secondary', `nt-secondary--${kind}`)
    }
  }, [kind])
}
