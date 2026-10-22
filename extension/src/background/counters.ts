// SPDX-License-Identifier: Apache-2.0
// Event counts for the `log` message: counts only, never text from a page, flushed to
// Notula at most every 60 s. Event names are fixed strings plus a site host and a field
// name for adapter misses.

const counts = new Map<string, number>()
const MAX_EVENTS = 50

export function count(event: string, n = 1): void {
  const name = event.slice(0, 120)
  if (!counts.has(name) && counts.size >= MAX_EVENTS) return
  counts.set(name, (counts.get(name) ?? 0) + n)
}

/** Takes every pending count and clears them. */
export function drainCounts(): [string, number][] {
  const out = [...counts.entries()]
  counts.clear()
  return out
}

/** True when a count is waiting to be sent. */
export function hasCounts(): boolean {
  return counts.size > 0
}
