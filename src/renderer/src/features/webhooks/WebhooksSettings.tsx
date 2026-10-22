// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Integrations ▸ Webhooks: personal endpoints, the setup
// steps (scope, events, URL), the one-time signing secret, test events, edit, turn off or on,
// rotate and delete. The renderer never holds a saved URL or secret: only `url_label`, and the
// secret once, from create or rotate.

import { useCallback, useEffect, useState, type JSX } from 'react'
import type { Folder } from '@shared/types/folders'
import { WEBHOOK_LIMITS, type WebhookEndpoint, type WebhookEvent, type WebhookTestResult } from '@shared/types/webhooks'
import { showToast } from '../../app/toast'
import { ago, errorText, InlineConfirm, Modal } from '../automations/ui'
import { Group } from '../settings/controls'
import './webhooks.css'

const EVENTS: { value: WebhookEvent; label: string; description: string }[] = [
  { value: 'note.summarized', label: 'A new note is ready', description: 'When Notula finishes the enhanced notes for a meeting.' },
  { value: 'note.updated', label: 'A note is edited', description: 'When you edit the summary, or ask Notula to rewrite it.' },
  { value: 'note.access_added', label: 'A note is filed in this folder', description: 'When a note is filed in the folder you chose above.' }
]

// The header names are joined at run time: the renderer holds no signing literal, since
// signing happens only in main.
const H = (name: string): string => ['webhook', name].join('-')

const URL_RULE = 'Use a public https:// address.'
const LOCAL_NOTE = 'Local addresses only work while that tool runs on this computer.'

function isLocal(url: string): boolean {
  return /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(url.trim())
}

export function testText(t: WebhookTestResult): string {
  if (t.ok) return 'Success'
  if (t.errorMessage) return `Test event failed. ${t.errorMessage}`
  if (t.httpStatusCode) return `Test event failed. The server responded with HTTP ${t.httpStatusCode}. Check the URL and try again.`
  return 'Test event failed. Check the URL and try again.'
}

function Secret({ secret, title, onDone, onTest }: { secret: string; title: string; onDone(): void; onTest?(): void }): JSX.Element {
  const copy = (): void => {
    void window.notula.clipboard
      .writeText({ text: secret })
      .then(() => showToast({ kind: 'success', title: 'Secret copied' }))
      .catch(() => showToast({ kind: 'error', title: 'Couldn’t copy the secret' }))
  }
  return (
    <Modal
      title={title}
      onClose={onDone}
      footer={
        <>
          {onTest ? (
            <button type="button" className="n-btn" onClick={onTest}>
              Send test event
            </button>
          ) : null}
          <button type="button" className="n-btn n-btn--primary" onClick={onDone}>
            Done
          </button>
        </>
      }
    >
      <p>
        Notula signs every request with this secret. Check the signature in the <code>{H('signature')}</code> header to confirm a request came from Notula.
      </p>
      <div className="wb-secret">
        <code>{secret}</code>
        <button type="button" className="n-btn n-btn--sm" onClick={copy}>
          Copy signing secret
        </button>
      </div>
      <p className="wb-warning">Copy the secret now. It won’t be shown again.</p>
      <details className="wh-tips">
        <summary>Setup tips</summary>
        <p>
          Each request carries <code>{H('id')}</code>, <code>{H('timestamp')}</code> and <code>{H('signature')}</code> (<code>v1,</code> + base64 HMAC-SHA256 of <code>id.timestamp.body</code>, keyed with the secret after <code>whsec_</code>). The body includes the note, and <code>note_id</code> is Notula’s note id.
        </p>
      </details>
    </Modal>
  )
}

function Setup({ folders, onClose, onCreated }: { folders: Folder[]; onClose(): void; onCreated(): void }): JSX.Element {
  const [step, setStep] = useState<'scope' | 'events' | 'url' | 'test' | 'secret'>('scope')
  const [scope, setScope] = useState<'my_notes_only' | 'one_folder'>('my_notes_only')
  const [folderId, setFolderId] = useState('')
  const [events, setEvents] = useState<WebhookEvent[]>(['note.summarized', 'note.updated'])
  const [url, setUrl] = useState('')
  const [includeTranscript, setIncludeTranscript] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<{ endpoint: WebhookEndpoint; signingSecret: string; test: WebhookTestResult } | null>(null)

  const evs = scope === 'one_folder' ? EVENTS : EVENTS.filter((e) => e.value !== 'note.access_added')
  const create = async (): Promise<void> => {
    setError(null)
    if (!/^https:\/\//i.test(url.trim()) && !isLocal(url)) {
      setError(URL_RULE)
      return
    }
    setBusy(true)
    try {
      const r = await window.notula.webhooks.create({ url: url.trim(), scope, folderId: scope === 'one_folder' ? folderId : null, events: events.filter((e) => evs.some((x) => x.value === e)), includeTranscript })
      setCreated(r)
      setStep(r.test.ok ? 'secret' : 'test')
      onCreated()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  const retest = async (): Promise<void> => {
    if (!created) return
    try {
      const t = await window.notula.webhooks.test({ id: created.endpoint.id })
      showToast({ kind: t.ok ? 'success' : 'error', title: testText(t) })
    } catch {
      showToast({ kind: 'error', title: 'Couldn’t send the test event. Check the URL and try again.' })
    }
  }

  if (step === 'secret' && created) {
    return (
      <Secret
        title="Webhook created"
        secret={created.signingSecret}
        onDone={() => {
          showToast({ kind: 'success', title: 'Webhook created' })
          onClose()
        }}
        onTest={() => void retest()}
      />
    )
  }
  if (step === 'test' && created) {
    return (
      <Modal
        title="The test event didn’t arrive"
        onClose={onClose}
        footer={
          <>
            <button
              type="button"
              className="n-btn"
              onClick={() => {
                void window.notula.webhooks.delete({ id: created.endpoint.id }).finally(onCreated)
                setCreated(null)
                setStep('url')
              }}
            >
              Change URL
            </button>
            <button type="button" className="n-btn n-btn--primary" onClick={() => setStep('secret')}>
              Save anyway
            </button>
          </>
        }
      >
        <p>{testText(created.test)}</p>
        <p className="wb-help">Notula sent one test event before saving. You can save this webhook anyway and fix the tool later.</p>
      </Modal>
    )
  }
  const next = (): void => {
    setError(null)
    if (step === 'scope') {
      if (scope === 'one_folder' && !folderId) return setError('Pick a folder.')
      setStep('events')
    } else if (step === 'events') {
      if (!events.some((e) => evs.some((x) => x.value === e))) return setError('Pick at least one event.')
      setStep('url')
    } else void create()
  }
  return (
    <Modal
      title={step === 'scope' ? 'Which notes should this webhook cover?' : step === 'events' ? 'Which events should it send?' : 'Where should Notula send them?'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="n-btn" onClick={() => (step === 'scope' ? onClose() : setStep(step === 'url' ? 'events' : 'scope'))}>
            {step === 'scope' ? 'Cancel' : 'Back'}
          </button>
          <button type="button" className="n-btn n-btn--primary" disabled={busy} onClick={next}>
            {step === 'url' ? (busy ? 'Testing…' : 'Save webhook') : 'Continue'}
          </button>
        </>
      }
    >
      {step === 'scope' ? (
        <div className="wb-options" role="radiogroup">
          <button type="button" role="radio" aria-checked={scope === 'my_notes_only'} className="wb-option" onClick={() => setScope('my_notes_only')}>
            <span className="wb-option__text">
              All your notes
              <span className="wb-option__hint">Every note in your Notula library.</span>
            </span>
          </button>
          <button type="button" role="radio" aria-checked={scope === 'one_folder'} className="wb-option" onClick={() => setScope('one_folder')}>
            <span className="wb-option__text">
              Notes in one folder
              <span className="wb-option__hint">Only notes in the folder you pick.</span>
            </span>
          </button>
          {scope === 'one_folder' ? (
            <select className="n-input" aria-label="Folder" value={folderId} onChange={(e) => setFolderId(e.target.value)}>
              <option value="" disabled>
                Choose a folder
              </option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.title}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      ) : null}
      {step === 'events' ? (
        <>
          <p className="wb-help">Pick the events that trigger a request to your URL.</p>
          {evs.map((e) => (
            <label key={e.value} className="wb-check wh-event">
              <input type="checkbox" checked={events.includes(e.value)} onChange={(x) => setEvents((list) => (x.target.checked ? [...list, e.value] : list.filter((v) => v !== e.value)))} />
              <span className="wb-option__text">
                {e.label}
                <span className="wb-option__hint">{e.description}</span>
              </span>
            </label>
          ))}
          <label className="wb-check">
            <input type="checkbox" checked={includeTranscript} onChange={(x) => setIncludeTranscript(x.target.checked)} />
            Include the transcript
          </label>
        </>
      ) : null}
      {step === 'url' ? (
        <div className="wb-field">
          <label htmlFor="wh-url">Destination URL</label>
          <input id="wh-url" className="n-input" type="url" autoComplete="off" spellCheck={false} placeholder="https://hooks.zapier.com/..." value={url} onChange={(e) => setUrl(e.target.value)} />
          <p className="wb-help">Notula sends a POST request with the note as JSON to this address.</p>
          <p className="wb-help">{isLocal(url) ? LOCAL_NOTE : URL_RULE}</p>
        </div>
      ) : null}
      {error ? <p className="wb-error">{error}</p> : null}
    </Modal>
  )
}

function Edit({ ep, folders, onClose, onSaved }: { ep: WebhookEndpoint; folders: Folder[]; onClose(): void; onSaved(): void }): JSX.Element {
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState<WebhookEvent[]>(ep.events)
  const [folderId, setFolderId] = useState(ep.folder_id ?? '')
  const [includeTranscript, setIncludeTranscript] = useState(ep.include_transcript)
  const [error, setError] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const evs = ep.scope === 'one_folder' ? EVENTS : EVENTS.filter((e) => e.value !== 'note.access_added')
  const save = async (): Promise<void> => {
    setError(null)
    try {
      await window.notula.webhooks.update({ id: ep.id, ...(url.trim() ? { url: url.trim() } : {}), events, includeTranscript, ...(ep.scope === 'one_folder' ? { folderId: folderId || null } : {}) })
      showToast({ kind: 'success', title: 'Webhook updated' })
      onSaved()
      onClose()
    } catch (err) {
      setError(errorText(err))
    }
  }
  const rotate = async (): Promise<void> => {
    try {
      const r = await window.notula.webhooks.rotateSecret({ id: ep.id })
      setSecret(r.signingSecret)
    } catch (err) {
      setError(errorText(err))
    }
  }
  if (secret) return <Secret title="New signing secret" secret={secret} onDone={onClose} />
  return (
    <Modal
      title="Edit webhook"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="n-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="n-btn n-btn--primary" onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <div className="wb-field">
        <label htmlFor="wh-edit-url">Destination URL</label>
        <input id="wh-edit-url" className="n-input" type="url" autoComplete="off" spellCheck={false} placeholder={`${ep.url_label}/… (unchanged)`} value={url} onChange={(e) => setUrl(e.target.value)} />
        <p className="wb-help">Leave empty to keep the current URL.</p>
      </div>
      {ep.scope === 'one_folder' ? (
        <div className="wb-field">
          <label htmlFor="wh-edit-folder">Folder</label>
          <select id="wh-edit-folder" className="n-input" value={folderId} onChange={(e) => setFolderId(e.target.value)}>
            <option value="" disabled>
              Choose a folder
            </option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.title}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {evs.map((e) => (
        <label key={e.value} className="wb-check">
          <input type="checkbox" checked={events.includes(e.value)} onChange={(x) => setEvents((list) => (x.target.checked ? [...list, e.value] : list.filter((v) => v !== e.value)))} />
          {e.label}
        </label>
      ))}
      <label className="wb-check">
        <input type="checkbox" checked={includeTranscript} onChange={(x) => setIncludeTranscript(x.target.checked)} />
        Include the transcript
      </label>
      <div className="wb-confirm">
        <strong>Signing secret</strong>
        <div className="wb-confirm__body">Make a new secret and show it once. The old one stops working at once.</div>
        <div className="wb-actions" style={{ justifyContent: 'flex-start' }}>
          <button type="button" className="n-btn n-btn--sm" onClick={() => void rotate()}>
            Rotate secret
          </button>
        </div>
      </div>
      {error ? <p className="wb-error">{error}</p> : null}
    </Modal>
  )
}

function offLine(ep: WebhookEndpoint): string | null {
  if (ep.enabled) return null
  if (ep.disabled_reason === 'gone') return 'This endpoint asked Notula to stop sending (410).'
  if (ep.disabled_reason === 'failures') return 'Turned off after it kept failing.'
  if (ep.scope === 'one_folder' && !ep.folder_id) return 'The folder for this webhook was deleted.'
  return 'Off'
}

export function WebhooksSettings(): JSX.Element {
  const [list, setList] = useState<WebhookEndpoint[] | null>(null)
  const [error, setError] = useState(false)
  const [folders, setFolders] = useState<Folder[]>([])
  const [q, setQ] = useState('')
  const [setup, setSetup] = useState(false)
  const [editing, setEditing] = useState<WebhookEndpoint | null>(null)
  const [asking, setAsking] = useState<{ id: string; kind: 'off' | 'delete' } | null>(null)
  const [testing, setTesting] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const [l, f] = await Promise.all([window.notula.webhooks.list(), window.notula.folders.list()])
      setList(l)
      setFolders(f.folders)
      setError(false)
    } catch {
      setError(true)
    }
  }, [])
  useEffect(() => {
    void load()
    return window.notula.webhooks.onChanged(() => void load())
  }, [load])

  const test = async (ep: WebhookEndpoint): Promise<void> => {
    setTesting(ep.id)
    try {
      const t = await window.notula.webhooks.test({ id: ep.id })
      showToast({ kind: t.ok ? 'success' : 'error', title: testText(t) })
    } catch {
      showToast({ kind: 'error', title: 'Couldn’t send the test event. Check the URL and try again.' })
    } finally {
      setTesting(null)
    }
  }
  const setEnabled = (ep: WebhookEndpoint, enabled: boolean): void => {
    setAsking(null)
    void window.notula.webhooks
      .update({ id: ep.id, enabled })
      .then(() => showToast({ title: enabled ? 'Webhook turned on' : 'Webhook turned off' }))
      .then(load)
      .catch((err: unknown) => showToast({ kind: 'error', title: errorText(err) }))
  }
  const remove = (ep: WebhookEndpoint): void => {
    setAsking(null)
    void window.notula.webhooks
      .delete({ id: ep.id })
      .then(() => showToast({ title: 'Webhook deleted' }))
      .then(load)
      .catch((err: unknown) => showToast({ kind: 'error', title: errorText(err) }))
  }

  const shown = (list ?? []).filter((e) => !q.trim() || e.url_label.toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <Group title="Webhooks" description="Webhooks send your notes to your own server or an automation tool when something happens in Notula, such as a note being ready.">
      <div className="wh-toolbar">
        <input className="n-input wh-search" placeholder="Search webhooks" aria-label="Search webhooks" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="n-btn n-btn--sm n-btn--primary" disabled={(list?.length ?? 0) >= WEBHOOK_LIMITS.maxEndpoints} onClick={() => setSetup(true)}>
          Set up a webhook
        </button>
      </div>
      <div className="wb-list">
        {error ? (
          <div className="wb-empty">
            Couldn’t load webhooks.{' '}
            <button type="button" className="wb-link" onClick={() => void load()}>
              Try again
            </button>
          </div>
        ) : list && !list.length ? (
          <div className="wb-empty">No webhooks yet</div>
        ) : list && !shown.length ? (
          <div className="wb-empty">No webhooks match your search</div>
        ) : null}
        {shown.map((ep) => {
          const off = offLine(ep)
          const folder = ep.scope === 'one_folder' ? folders.find((f) => f.id === ep.folder_id)?.title : null
          return (
            <div key={ep.id} className={`wb-item${ep.enabled ? '' : ' wb-item--off'}`}>
              <div className="wb-item__main">
                <div className="wb-item__title">{ep.url_label.replace(/^https?:\/\//, '')}</div>
                <div className="wb-item__meta">
                  {ep.scope === 'my_notes_only' ? 'All my notes' : `Notes in ${folder ?? 'a deleted folder'}`} · {ep.events.map((e) => EVENTS.find((x) => x.value === e)?.label ?? e).join(', ')}
                </div>
                <div className="wb-item__meta">
                  Last delivery:{' '}
                  {ep.last_delivery ? `${ep.last_delivery.status === 'sent' ? 'Sent' : ep.last_delivery.status === 'uncertain' ? 'Uncertain' : ep.last_delivery.status === 'failed' ? `Failed${ep.last_delivery.httpStatus ? ` (${ep.last_delivery.httpStatus})` : ''}` : 'Queued'} ${ago(ep.last_delivery.at)}` : 'none yet'}
                  {off ? ` · ${off}` : ''}
                </div>
                {asking?.id === ep.id && asking.kind === 'off' ? (
                  <InlineConfirm
                    danger={false}
                    title="Turn off this webhook?"
                    body={`Notula will stop sending events to ${ep.url_label.replace(/^https?:\/\//, '')} until you turn it back on.`}
                    action="Turn off"
                    onCancel={() => setAsking(null)}
                    onConfirm={() => setEnabled(ep, false)}
                  />
                ) : null}
                {asking?.id === ep.id && asking.kind === 'delete' ? <InlineConfirm title="Delete this webhook?" body="This can’t be undone. Automations that send to it are turned off." action="Delete" onCancel={() => setAsking(null)} onConfirm={() => remove(ep)} /> : null}
              </div>
              <div className="wb-item__side">
                <button type="button" className="n-btn n-btn--sm" disabled={testing === ep.id} onClick={() => void test(ep)}>
                  {testing === ep.id ? 'Sending...' : 'Send test event'}
                </button>
                <button type="button" className="n-btn n-btn--sm" onClick={() => setEditing(ep)}>
                  Edit
                </button>
                <button type="button" className="n-btn n-btn--sm" onClick={() => (ep.enabled ? setAsking({ id: ep.id, kind: 'off' }) : setEnabled(ep, true))}>
                  {ep.enabled ? 'Turn off' : 'Turn on'}
                </button>
                <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => setAsking({ id: ep.id, kind: 'delete' })}>
                  Delete
                </button>
              </div>
            </div>
          )
        })}
      </div>
      {setup ? <Setup folders={folders} onClose={() => setSetup(false)} onCreated={() => void load()} /> : null}
      {editing ? <Edit ep={editing} folders={folders} onClose={() => setEditing(null)} onSaved={() => void load()} /> : null}
    </Group>
  )
}
