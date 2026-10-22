// SPDX-License-Identifier: Apache-2.0
// A note's screen-snapshot state (`screen-snapshots:get-state`, `screen-snapshots:state`) for
// the bubble: the first read, then the pushes.

import { useEffect, useState } from 'react'
import type { ScreenSnapshotsState } from '@shared/types/snapshots'

export function useScreenSnapshots(noteId: string | null): ScreenSnapshotsState | null {
  const [state, setState] = useState<ScreenSnapshotsState | null>(null)
  useEffect(() => {
    setState(null)
    if (!noteId) return
    let alive = true
    let pushed = false
    const off = window.notula.screenSnapshots.onState((s) => {
      if (s.noteId !== noteId) return
      pushed = true
      setState(s)
    })
    void window.notula.screenSnapshots
      .getState({ noteId })
      .then((s) => {
        if (alive && !pushed) setState(s)
      })
      .catch(() => undefined)
    return () => {
      alive = false
      off()
    }
  }, [noteId])
  return state
}
