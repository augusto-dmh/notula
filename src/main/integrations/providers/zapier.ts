// SPDX-License-Identifier: Apache-2.0
// Zapier: Catch Hook URLs as workflows, and Notula's
// own payload contract (users map these field names in their Zaps: keep them stable).

import { app } from 'electron'
import { transcriptCopyText } from '@shared/lib/transcript-text'
import { meetingEnd, noteTitle } from '../content'
import { integrationsHttp } from '../http'
import { readerTranscript } from '../../sources/reader'
import { failure, type ProviderClient, type SendOutcome } from './types'

const COPY = {
  network: 'Couldn’t reach Zapier. Check your connection and try again.',
  busy: 'Zapier is busy. Try again in a minute.',
  other: 'Couldn’t send to Zapier. Try again in a minute.',
  status: {
    404: 'This Zapier workflow is off or was deleted. Turn the Zap on, or remove it here.',
    410: 'This Zapier workflow is off or was deleted. Turn the Zap on, or remove it here.',
    413: 'This note is too large for Zapier.'
  }
}

const MAX_BYTES = 9 * 1024 * 1024

export const zapier: ProviderClient = {
  id: 'zapier',

  // Zapier has no account credential; a workflow is checked by "Send test note".
  async validate() {
    return { state: 'connected', accountLabel: null, detail: null }
  },

  async send(ctx, job): Promise<SendOutcome> {
    const dest = job.destination
    if (!dest || !job.destinationSecret) return { ok: false, retry: 'never', code: 'no_hook', message: COPY.status[404] }
    const note = job.note
    const folders = await ctx.storage.listFolders()
    const holding = folders.folders.filter((f) => (folders.membership[f.id] ?? []).includes(note.id))
    const auto = job.delivery.automationId ? (await ctx.storage.listIntegrationAutomations({ provider: 'zapier' })).find((a) => a.id === job.delivery.automationId) : null
    const trigger = auto ? folders.folders.find((f) => f.id === auto.folderId) ?? null : null
    const attendees = (note.people?.attendees ?? []).map((a) => ({ name: a.name ?? '', email: a.email ?? '' }))
    let transcript: string | undefined
    if (dest.options.zapierIncludeTranscript) {
      const [chunks, wordLevel] = await Promise.all([
        ctx.storage.getTranscript(note.id).then((c) => readerTranscript(ctx, note.id, c)),
        ctx.settings.get('transcription.diarization')
      ])
      transcript = transcriptCopyText({ note, chunks: chunks.filter((c) => c.text !== '[DELETED]'), wordLevel })
    }
    const ev = note.linked_event
    const payload: Record<string, unknown> = {
      event: job.delivery.trigger === 'folder' ? 'note.added_to_folder' : 'note.shared',
      test: job.test,
      source: 'notula',
      app_version: app.getVersion(),
      sent_at: new Date().toISOString(),
      note_id: note.id,
      title: noteTitle(note),
      created_at: note.created_at,
      meeting_start: ev?.start?.dateTime ?? ev?.start?.date ?? null,
      meeting_end: meetingEnd(note),
      event_name: typeof ev?.summary === 'string' ? ev.summary : null,
      attendees,
      attendee_emails: attendees.map((a) => a.email).filter(Boolean).join(', '),
      folder: trigger ? { id: trigger.id, name: trigger.title } : null,
      folders: holding.map((f) => f.title).join(', '),
      summary_markdown: job.content.markdown,
      summary_html: job.content.html,
      summary_text: job.content.text,
      my_notes_md: note.notes_md ?? '',
      ...(transcript !== undefined ? { transcript_text: transcript } : {}),
      truncated: false
    }
    // Under 9 MB: drop the transcript, then cut the HTML.
    const size = (): number => Buffer.byteLength(JSON.stringify(payload))
    if (size() > MAX_BYTES && 'transcript_text' in payload) {
      delete payload['transcript_text']
      payload['truncated'] = true
    }
    if (size() > MAX_BYTES) {
      const over = size() - MAX_BYTES
      payload['summary_html'] = String(payload['summary_html']).slice(0, Math.max(0, String(payload['summary_html']).length - over - 1024))
      payload['truncated'] = true
    }
    const r = await integrationsHttp.fetchUrl(job.destinationSecret, { kind: 'write', method: 'POST', json: payload, pace: { key: `zapier:${dest.id}`, intervalMs: 500 } })
    if (!r.ok) {
      const f = failure(r, COPY)
      if (r.kind === 'http' && (r.status === 404 || r.status === 410)) return { ...f, retry: 'never', disconnect: true }
      return f
    }
    return { ok: true, externalId: null, externalUrl: null }
  }
}
