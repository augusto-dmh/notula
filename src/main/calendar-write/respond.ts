// SPDX-License-Identifier: Apache-2.0
// Answering an invitation for the user: Google sets the user's own attendee entry (under the
// event's etag), Microsoft runs the event's accept / tentativelyAccept / decline action. The
// organizer has no invitation to answer. Logs carry the provider and the answer, never the note.

import type { CalendarEvent } from '@shared/types/notes'
import type { ExecResult } from '../blocks'
import type { MainContext } from '../context'
import { log } from '../log'
import { egressBlocked } from '../privacy'
import { exchange, providerHttp } from './http'
import { COPY, eventRef, failed, googleHeaders, writeToken } from './providers'

export type InviteResponse = 'accepted' | 'tentative' | 'declined'

export const RESPOND_COPY = {
  organizer: 'You organize this event, so there’s no invitation to answer.',
  notGuest: 'You aren’t a guest of this event, so there’s no invitation to answer.'
} as const

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})

const googleEventUrl = 'https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events/{eventId}'

/** The refusal for an event the user can't answer, or null. */
export function respondRefusal(event: CalendarEvent): string | null {
  const ref = eventRef(event)
  if (!ref) return 'Calendar feeds are read-only, so this invitation can’t be answered from Notula.'
  return ref.organizer ? RESPOND_COPY.organizer : null
}

export async function respondToInvite(
  ctx: MainContext,
  event: CalendarEvent,
  response: InviteResponse,
  scope: 'occurrence' | 'series',
  note?: string
): Promise<ExecResult> {
  const refusal = respondRefusal(event)
  const ref = eventRef(event)
  if (refusal || !ref) return { status: 'failed', errorCode: 'invalid', error: refusal ?? COPY.other }
  if (await egressBlocked(ctx, { kind: 'calendar' })) return { status: 'failed', errorCode: 'local_only', error: COPY.localOnly }
  const token = await writeToken(ctx, ref.sourceId)
  if (typeof token !== 'string') return token
  const id = scope === 'series' ? (ref.seriesId ?? ref.eventId) : ref.eventId
  const comment = note?.trim() ?? ''
  const out = ref.provider === 'google' ? await google(ctx, token, ref.calendarNativeId, id, response, comment, await ctx.calendar.myEmails()) : await graph(ctx, token, id, response, comment)
  log('info', 'calendar-write:respond', { provider: ref.provider, response, status: out.status })
  if (out.status === 'updated') ctx.calendar.refreshSource(ref.sourceId)
  return out
}

async function google(ctx: MainContext, token: string, calendarId: string, eventId: string, response: InviteResponse, comment: string, mine: readonly string[]): Promise<ExecResult> {
  const http = providerHttp(ctx, 'calendar', 'calendar-write')
  const headers = googleHeaders(token)
  const me = new Set(mine.map((e) => e.toLowerCase()))
  // One retry when the event changed between the read and the write.
  for (let attempt = 0; ; attempt++) {
    const cur = await exchange(() => http.fetch(googleEventUrl, { params: { calendarId, eventId }, headers }))
    if (!cur.ok) return failed(cur, false)
    if (obj(cur.body['organizer'])['self'] === true) return { status: 'failed', errorCode: 'invalid', error: RESPOND_COPY.organizer }
    const attendees = Array.isArray(cur.body['attendees']) ? (cur.body['attendees'] as Obj[]) : []
    let own = attendees.findIndex((a) => a['self'] === true)
    if (own < 0) own = attendees.findIndex((a) => me.has(String(a['email'] ?? '').toLowerCase()))
    if (own < 0) return { status: 'failed', errorCode: 'invalid', error: RESPOND_COPY.notGuest }
    // The whole list goes back; only the user's entry changes, and its old comment stays unless a note replaces it.
    const next = attendees.map((a, i) => (i === own ? { ...a, responseStatus: response, ...(comment ? { comment } : {}) } : a))
    const x = await exchange(() =>
      http.fetch(googleEventUrl, {
        method: 'PATCH',
        params: { calendarId, eventId },
        query: { sendUpdates: 'all' },
        headers: { ...headers, 'if-match': typeof cur.body['etag'] === 'string' ? cur.body['etag'] : '*' },
        body: JSON.stringify({ attendees: next })
      })
    )
    if (x.ok) return { status: 'updated', fields: { eventId, response } }
    if (x.kind === 'http' && x.status === 412 && attempt === 0) continue
    return failed(x, true)
  }
}

const GRAPH_ACTIONS: Record<InviteResponse, string> = {
  accepted: 'https://graph.microsoft.com/v1.0/me/events/{id}/accept',
  tentative: 'https://graph.microsoft.com/v1.0/me/events/{id}/tentativelyAccept',
  declined: 'https://graph.microsoft.com/v1.0/me/events/{id}/decline'
}

async function graph(ctx: MainContext, token: string, eventId: string, response: InviteResponse, comment: string): Promise<ExecResult> {
  const http = providerHttp(ctx, 'calendar', 'calendar-write')
  const x = await exchange(() =>
    http.fetch(GRAPH_ACTIONS[response], {
      method: 'POST',
      params: { id: eventId },
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ comment, sendResponse: true })
    })
  )
  if (x.ok) return { status: 'updated', fields: { eventId, response } }
  return failed(x, true)
}
