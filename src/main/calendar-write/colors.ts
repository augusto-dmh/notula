// SPDX-License-Identifier: Apache-2.0
// Google's event color palette for the draft card's swatches: `GET /colors`, once per account
// and kept in memory. Until it answers (or when it can't), the card uses the built-in copy of
// the same palette.

import type { MainContext } from '../context'
import { egressBlocked } from '../privacy'
import { exchange, providerHttp } from './http'

/** Google's event palette (`event.<id>.background`), as its public colors endpoint lists it. */
export const GOOGLE_EVENT_COLORS: Readonly<Record<string, string>> = {
  '1': '#a4bdfc',
  '2': '#7ae7bf',
  '3': '#dbadff',
  '4': '#ff887c',
  '5': '#fbd75b',
  '6': '#ffb878',
  '7': '#46d6db',
  '8': '#e1e1e1',
  '9': '#5484ed',
  '10': '#51b749',
  '11': '#dc2127'
}

const cache = new Map<string, Record<string, string>>()

export async function eventColors(ctx: MainContext, sourceId: string): Promise<Record<string, string>> {
  const held = cache.get(sourceId)
  if (held) return held
  const src = (await ctx.storage.listCalendarSources().catch(() => [])).find((s) => s.id === sourceId)
  if (src?.kind !== 'google' || (await egressBlocked(ctx, { kind: 'calendar' }))) return { ...GOOGLE_EVENT_COLORS }
  let token: string
  try {
    token = await ctx.calendar.accessToken(sourceId, null)
  } catch {
    return { ...GOOGLE_EVENT_COLORS }
  }
  const x = await exchange(() =>
    providerHttp(ctx, 'calendar', 'calendar-read').fetch('https://www.googleapis.com/calendar/v3/colors', { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } })
  )
  if (!x.ok) return { ...GOOGLE_EVENT_COLORS }
  const palette: Record<string, string> = { ...GOOGLE_EVENT_COLORS }
  const event = x.body['event']
  for (const [id, v] of Object.entries(event && typeof event === 'object' ? (event as Record<string, unknown>) : {})) {
    const bg = (v as { background?: unknown } | null)?.background
    if (typeof bg === 'string' && /^#[0-9a-f]{6}$/i.test(bg)) palette[id] = bg
  }
  cache.set(sourceId, palette)
  return palette
}
