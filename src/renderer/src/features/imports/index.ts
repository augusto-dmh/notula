// SPDX-License-Identifier: Apache-2.0
// Recording imports: the drop target on the main
// window and the never-shown #/media-worker window. The decoder (and mp4box) load only in the
// media worker, never in the main window's bundle.

import { createElement, useEffect, type JSX } from 'react'

/** App host: the drop overlay, its confirm dialog and the progress panel. Paths come from `files.pathForFile`. */
export { RecordingDropTarget } from './RecordingDropTarget'

/** `#/media-worker`: WebCodecs decoding for local imports, fed over a MessagePort from main. */
export function MediaWorkerRoot(): JSX.Element {
  useEffect(() => {
    let stop: (() => void) | null = null
    let alive = true
    void import('./media-worker').then((m) => {
      if (alive) stop = m.startMediaWorker()
    })
    return () => {
      alive = false
      stop?.()
    }
  }, [])
  return createElement('div', { className: 'media-worker-root' })
}
