// SPDX-License-Identifier: Apache-2.0
// The in-app navigation history the empty-note auto-delete checks: a note still
// reachable with Back is kept. Home is the root, so going
// home (the Back button) starts the history over; a Back step pops one entry; any other
// navigation pushes. A note whose route is still current (a re-mount) counts as present.

import { currentRoute } from '../../app/navigation'

const MAX_ENTRIES = 100
const MEETING_PREFIX = '/meeting/'

/** Paths without their query, oldest first; the last is the latest navigation. */
const stack: string[] = [currentRoute().path]

function onRouteChange(): void {
  const path = currentRoute().path
  if (path === stack[stack.length - 1]) return
  if (path === '/') {
    stack.length = 0
    stack.push('/')
    return
  }
  if (stack.length >= 2 && stack[stack.length - 2] === path) {
    stack.pop()
    return
  }
  stack.push(path)
  if (stack.length > MAX_ENTRIES) stack.shift()
}

window.addEventListener('hashchange', onRouteChange)

/** The note id of a `/meeting/<id>` path, up to `?`, `#` or `/`, lower-cased (UUID normalization). */
function meetingId(path: string): string | null {
  if (!path.startsWith(MEETING_PREFIX)) return null
  const rest = path.slice(MEETING_PREFIX.length).split(/[?#/]/)[0] ?? ''
  try {
    return decodeURIComponent(rest).toLowerCase()
  } catch {
    return rest.toLowerCase()
  }
}

export function noteInNavHistory(noteId: string): boolean {
  // The page unmounts inside the router's own hashchange handling, before this module's
  // listener runs, so the history first catches up with the route already in effect.
  onRouteChange()
  const id = noteId.toLowerCase()
  if (meetingId(currentRoute().path) === id) return true
  return stack.some((p) => meetingId(p) === id)
}
