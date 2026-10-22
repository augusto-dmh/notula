// SPDX-License-Identifier: Apache-2.0
// The send and save dialogs (Slack, HubSpot, Attio, Affinity, Zapier) and the Undo toasts
// of `scheduled` sends. Undo calls `integrations:cancel-delivery`, and the host re-offers
// Undo for rows still scheduled after a renderer reload, so Undo always prevents the send.

import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import type {
  IntegrationDelivery,
  IntegrationDestination,
  IntegrationProvider,
  IntegrationSearchResult,
  IntegrationShareContent
} from '@shared/types/integrations'
import type { Note } from '@shared/types/notes'
import { IconClose } from '../../app/icons'
import { navigate } from '../../app/navigation'
import { dismissToast, showToast } from '../../app/toast'
import { Modal } from '../folders/Modal'
import { settingsPath } from './ShareMenu'
import {
  ago,
  closeShareDialog,
  errorText,
  isMac,
  latestSent,
  onDelivery,
  openExternal,
  panelContent,
  useShareDialog,
  waitForDeliveries,
  type OpenDialog
} from './store'
import './integrations.css'

// ---------- Undo toasts ----------

function undoToast(rows: IntegrationDelivery[], title: string, remainingMs: number): void {
  const id = `undo-${rows[0]?.id ?? 'x'}`
  showToast({
    id,
    kind: 'success',
    title,
    durationMs: Math.max(1_000, remainingMs),
    action: {
      label: 'Undo',
      onClick: () => {
        dismissToast(id)
        void Promise.allSettled(rows.map((r) => window.notula.integrations.cancelDelivery({ deliveryId: r.id }))).then((res) => {
          if (res.some((r) => r.status === 'rejected')) showToast({ kind: 'error', title: 'Too late to undo: it was already sent.' })
        })
      }
    }
  })
}

/** After the scheduled rows ran: Attio's batch summary, Zapier's per-workflow failures. */
function followUp(provider: IntegrationProvider, ids: string[], noteId: string): void {
  void waitForDeliveries(ids, noteId).then((rows) => {
    const live = rows.filter((r) => r.status !== 'cancelled')
    const bad = live.filter((r) => r.status !== 'sent')
    if (!live.length || !bad.length) return
    if (provider === 'attio') {
      if (bad.length === live.length) showToast({ kind: 'error', title: 'Couldn’t save to Attio. Try again in a minute.', description: bad[0]?.errorMessage ?? undefined })
      else showToast({ kind: 'error', title: `Saved to Attio with ${bad.length} issue(s)`, action: { label: 'View details', onClick: () => navigate(settingsPath('attio')) } })
    } else {
      showToast({ kind: 'error', title: bad.length > 1 ? `Couldn’t send to ${bad.length} Zapier connection(s).` : 'Couldn’t send to Zapier. Try again in a minute.', description: bad[0]?.errorMessage ?? undefined })
    }
  })
}

// ---------- shared pieces ----------

function useNote(noteId: string): Note | null {
  const [note, setNote] = useState<Note | null>(null)
  useEffect(() => {
    void window.notula.notes.get({ id: noteId }).then(setNote).catch(() => setNote(null))
  }, [noteId])
  return note
}

function useContent(d: OpenDialog): IntegrationShareContent | null | 'error' {
  const [c, setC] = useState<IntegrationShareContent | null | 'error'>(null)
  useEffect(() => {
    void panelContent(d.noteId, d.panelId)
      .then((r) => setC(r?.content ?? 'error'))
      .catch(() => setC('error'))
  }, [d.noteId, d.panelId])
  return c
}

function previewDate(note: Note | null): string {
  const ev = note?.linked_event
  const iso = ev?.start?.dateTime ?? ev?.start?.date ?? note?.created_at
  return iso ? new Date(iso).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }) : ''
}

/** Newline runs → `: `, `.:` → `.`, `::` → `:`, 120 characters plus `…`. */
function previewSubtitle(text: string): string {
  const s = text.replace(/\n+/g, ': ').replace(/\.:/g, '.').replace(/::/g, ':').trim()
  return s.length > 120 ? `${s.slice(0, 120)}…` : s
}

function IconLock(): JSX.Element {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-label="Private">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  )
}

function Header({ title, subtitle, onClose }: { title: string; subtitle?: string | null; onClose(): void }): JSX.Element {
  return (
    <div className="h-modal__header">
      <div>
        <h2 className="h-modal__title">{title}</h2>
        {subtitle ? <p className="h-modal__subtitle">{subtitle}</p> : null}
      </div>
      <button type="button" className="n-icon-btn n-icon-btn--sm" aria-label="Close" onClick={onClose}>
        <IconClose size={15} />
      </button>
    </div>
  )
}

// ---------- Slack ----------

interface ChannelOption {
  key: string
  label: string
  isPrivate: boolean
  /** A bot channel id, or a webhook destination id. */
  channelId?: string
  destinationId?: string
}

function SlackDialog({ d }: { d: OpenDialog }): JSX.Element {
  const note = useNote(d.noteId)
  const content = useContent(d)
  const [mode, setMode] = useState<'bot' | 'webhook' | null>(null)
  const [options, setOptions] = useState<ChannelOption[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<ChannelOption | null>(null)
  const [text, setText] = useState('')
  const [initial, setInitial] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const [drafting, setDrafting] = useState(false)
  useEffect(() => {
    if (!content || content === 'error') return
    // D-SL-b: the composer opens with the selected panel, or with an AI draft when Labs has it on.
    setText(content.markdown)
    setInitial(content.markdown)
    let alive = true
    void window.notula.prefs.get().then((p) => {
      if (!alive || !p['integrations.slack.aiDraft']) return
      setDrafting(true)
      window.notula.integrations
        .slackDraft({ noteId: d.noteId, panelId: d.panelId, panelText: content.text })
        .then((r) => {
          if (!alive || !r.text) return
          setText(r.text)
          setInitial(r.text)
        })
        .catch(() => {})
        .finally(() => alive && setDrafting(false))
    })
    return () => {
      alive = false
    }
  }, [content, d.noteId, d.panelId])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const prefs = await window.notula.prefs.get()
        const m = prefs['integrations.slack.mode']
        if (!alive) return
        setMode(m)
        const [dests, history] = await Promise.all([
          window.notula.integrations.listDestinations({ provider: 'slack' }),
          window.notula.integrations.listDeliveries({ provider: 'slack', limit: 50 })
        ])
        const recentDest = history.filter((h) => h.status === 'sent' && h.trigger === 'manual').map((h) => h.destinationId)
        let opts: ChannelOption[]
        if (m === 'webhook') {
          opts = dests.filter((x) => x.kind === 'slack-webhook' && x.status === 'ok').map((x) => ({ key: x.id, label: x.label, isPrivate: false, destinationId: x.id }))
        } else {
          const channels = await window.notula.integrations.search({ provider: 'slack', kinds: ['channel'] })
          opts = channels.map((c) => ({ key: c.id, label: c.label, isPrivate: c.extra?.['isPrivate'] === true, channelId: c.id }))
        }
        // Channels from the sharing history first.
        const rank = (o: ChannelOption): number => {
          const destId = o.destinationId ?? dests.find((x) => x.kind === 'slack-channel' && x.externalId === o.channelId)?.id
          const i = destId ? recentDest.indexOf(destId) : -1
          return i < 0 ? Infinity : i
        }
        opts = opts.map((o, i) => ({ o, i })).sort((a, b) => rank(a.o) - rank(b.o) || a.i - b.i).map((x) => x.o)
        if (!alive) return
        setOptions(opts)
        // Step 16: preselect the most recent Slack destination.
        if (opts[0] && rank(opts[0]) !== Infinity) setPicked(opts[0])
      } catch (err) {
        if (alive) {
          setOptions([])
          setLoadError(errorText(err))
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const dirty = text.trim() !== '' && text !== initial
  const close = (): void => {
    if (busy) return
    if (dirty && !confirmDiscard) setConfirmDiscard(true)
    else closeShareDialog()
  }
  const filtered = (options ?? []).filter((o) => !query.trim() || o.label.toLowerCase().includes(query.trim().toLowerCase()))
  const canPost = !!picked && !busy && text.trim() !== '' && content !== null && content !== 'error'

  const post = async (): Promise<void> => {
    if (!canPost || !picked || !content) return
    setBusy(true)
    setError(null)
    try {
      const body: IntegrationShareContent = text === initial ? content : { markdown: text, text, html: '' }
      const { deliveryIds } = await window.notula.integrations.share({
        provider: 'slack',
        noteId: d.noteId,
        panelId: d.panelId,
        content: body,
        ...(picked.destinationId ? { destinationIds: [picked.destinationId] } : { targets: [{ kind: 'channel', id: picked.channelId ?? '', label: picked.label }] })
      })
      const [row] = await waitForDeliveries(deliveryIds, d.noteId)
      if (row?.status === 'sent') {
        showToast({ kind: 'success', title: `Sent to #${picked.label}` })
        closeShareDialog()
        return
      }
      // A failed send ends the busy state and keeps the text.
      setError(row?.errorMessage ?? 'Couldn’t send to Slack. Try again.')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void post()
    }
  }

  return (
    <Modal label="Send to Slack" className="int-dialog" onClose={close}>
      {confirmDiscard ? (
        <div className="int-confirm">
          <h2 className="h-modal__title">Discard message?</h2>
          <div className="h-modal__footer">
            <button type="button" className="n-btn" data-autofocus onClick={() => setConfirmDiscard(false)}>
              Go back
            </button>
            <button type="button" className="n-btn n-btn--danger" onClick={() => closeShareDialog()}>
              Discard
            </button>
          </div>
        </div>
      ) : (
        <div onKeyDown={onKey}>
          <Header title="Send to Slack" onClose={close} />
          <div className="h-modal__body int-body">
            <label className="int-label" htmlFor="int-slack-search">
              Post to
            </label>
            {picked ? (
              <div className="int-picked">
                <span className="int-chip">
                  {picked.isPrivate ? <IconLock /> : '#'}
                  {picked.label}
                  <button type="button" aria-label="Clear channel" onClick={() => setPicked(null)}>
                    ×
                  </button>
                </span>
              </div>
            ) : (
              <>
                <input id="int-slack-search" className="n-input int-input" placeholder="Search channels" value={query} onChange={(e) => setQuery(e.target.value)} data-autofocus />
                <div className="int-list" role="listbox" aria-label="Channels">
                  {options === null ? <div className="int-empty">Loading channels…</div> : null}
                  {options && !filtered.length ? (
                    <div className="int-empty">
                      {loadError ?? 'No channels found.'}{' '}
                      {mode === 'webhook' ? (
                        <button type="button" className="int-link" onClick={() => { closeShareDialog(); navigate(settingsPath('slack')) }}>
                          Add a channel…
                        </button>
                      ) : (
                        <button type="button" className="int-link" onClick={() => { closeShareDialog(); navigate(settingsPath('slack')) }}>
                          How to add private channels
                        </button>
                      )}
                    </div>
                  ) : null}
                  {filtered.map((o) => (
                    <button key={o.key} type="button" role="option" aria-selected={false} className="int-option" onClick={() => setPicked(o)}>
                      <span className="int-option__icon">{o.isPrivate ? <IconLock /> : '#'}</span>
                      {o.label}
                    </button>
                  ))}
                </div>
              </>
            )}
            <label className="int-label" htmlFor="int-slack-text">
              Message
            </label>
            <textarea id="int-slack-text" className="n-input int-composer" value={content === null ? '' : text} disabled={content === null || drafting} placeholder={content === null ? 'Loading the summary…' : ''} aria-busy={drafting || undefined} onChange={(e) => setText(e.target.value)} />
            <div className="int-preview">
              <div className="int-preview__title">{note?.title?.trim() || 'Untitled note'}</div>
              <div className="int-preview__meta">{previewDate(note)}</div>
              <div className="int-preview__sub">Notes: {previewSubtitle(content && content !== 'error' ? content.text : '')}</div>
            </div>
            {error ? <p className="int-error" role="alert">{error}</p> : null}
          </div>
          <div className="h-modal__footer">
            <span className="int-hint">
              <kbd className="n-kbd">{isMac() ? '⌘' : 'Ctrl'}</kbd> <kbd className="n-kbd">⏎</kbd>
            </span>
            <button type="button" className="n-btn" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="n-btn n-btn--primary" disabled={!canPost} onClick={() => void post()}>
              {busy ? 'Sending' : 'Post'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

// ---------- HubSpot, Attio, Affinity ----------

const RECORDS: Record<'hubspot' | 'attio' | 'affinity', { title: string; label: string; placeholder: string; empty: string; none: string; minChars: number }> = {
  hubspot: { title: 'Save to HubSpot', label: 'Save notes to:', placeholder: 'Search contacts, companies and deals', empty: 'No matches found.', none: 'Search for contacts, companies or deals.', minChars: 1 },
  attio: { title: 'Save to Attio', label: 'Save notes to', placeholder: 'Search people, companies, or deals...', empty: 'No records match. Try another name.', none: 'No contacts available.', minChars: 3 },
  affinity: { title: 'Save to Affinity', label: 'Save notes to', placeholder: 'Search people and organizations', empty: 'No match. Records you add in Affinity show up here.', none: 'Search for a person or organization', minChars: 1 }
}

const KIND_LABEL: Record<string, string> = { contact: 'Contact', company: 'Company', deal: 'Deal', person: 'Person', organization: 'Organization' }

function RecordsDialog({ d, provider }: { d: OpenDialog; provider: 'hubspot' | 'attio' | 'affinity' }): JSX.Element {
  const copy = RECORDS[provider]
  const content = useContent(d)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<IntegrationSearchResult[] | null>(null)
  const [selected, setSelected] = useState<IntegrationSearchResult[]>([])
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    void window.notula.integrations.listDeliveries({ noteId: d.noteId, provider, limit: 20 }).then((r) => setSavedAt(latestSent(r, provider)?.sentAt ?? null))
  }, [d.noteId, provider])

  useEffect(() => {
    const q = query.trim()
    if (q && q.length < copy.minChars) {
      setResults(null)
      return
    }
    const n = ++seq.current
    const t = setTimeout(
      () => {
        window.notula.integrations
          .search({ provider, ...(q ? { query: q } : { noteId: d.noteId }) })
          .then((r) => {
            if (n !== seq.current) return
            setResults(r)
            setError(null)
            // Suggestions pre-select once, while the selection is untouched.
            if (!q && !touched) setSelected((s) => (s.length ? s : r.filter((x) => x.suggested)))
          })
          .catch((err) => {
            if (n !== seq.current) return
            setResults([])
            setError(errorText(err))
          })
      },
      q ? 300 : 0
    )
    return () => clearTimeout(t)
    // `touched` only gates the one-time pre-selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, provider, d.noteId, copy.minChars])

  const isSel = (r: IntegrationSearchResult): boolean => selected.some((s) => s.kind === r.kind && s.id === r.id)
  const toggle = (r: IntegrationSearchResult): void => {
    setTouched(true)
    setSelected((s) => (isSel(r) ? s.filter((x) => !(x.kind === r.kind && x.id === r.id)) : [...s, r]))
  }

  const save = async (): Promise<void> => {
    if (!selected.length || !content || content === 'error' || busy) return
    const targets = selected.map((s) => ({ kind: s.kind, id: s.id, label: s.label }))
    if (provider === 'attio') {
      // The dialog closes first; the saves wait 3 s behind Undo.
      closeShareDialog()
      try {
        const { deliveryIds } = await window.notula.integrations.share({ provider, noteId: d.noteId, panelId: d.panelId, content, targets, delayMs: 3_000 })
        const rows = await window.notula.integrations.listDeliveries({ noteId: d.noteId, provider, limit: 100 })
        undoToast(rows.filter((r) => deliveryIds.includes(r.id)), 'Saved to Attio', 3_000)
        followUp('attio', deliveryIds, d.noteId)
      } catch (err) {
        showToast({ kind: 'error', title: 'Couldn’t save to Attio. Try again in a minute.', description: errorText(err) })
      }
      return
    }
    setBusy(true)
    setError(null)
    const name = provider === 'hubspot' ? 'HubSpot' : 'Affinity'
    const toastId = `save-${provider}-${d.noteId}`
    showToast({ id: toastId, title: `Saving to ${name}...`, durationMs: 60_000 })
    try {
      const { deliveryIds } = await window.notula.integrations.share({ provider, noteId: d.noteId, panelId: d.panelId, content, targets })
      const [row] = await waitForDeliveries(deliveryIds, d.noteId)
      if (row?.status === 'sent') {
        const url = row.externalUrl
        showToast({ id: toastId, kind: 'success', title: `Notes saved to ${name}`, ...(url ? { action: { label: 'Open', onClick: () => openExternal(url) } } : {}) })
        closeShareDialog()
        return
      }
      dismissToast(toastId)
      setError(row?.errorMessage ?? `Error saving to ${name}`)
    } catch (err) {
      dismissToast(toastId)
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const q = query.trim()
  const list = results ?? []
  const others = list.filter((r) => !isSel(r))
  return (
    <Modal label={copy.title} className="int-dialog" onClose={() => !busy && closeShareDialog()}>
      <Header title={copy.title} subtitle={savedAt ? `Saved ${ago(savedAt)}` : null} onClose={() => !busy && closeShareDialog()} />
      <div className="h-modal__body int-body">
        <label className="int-label" htmlFor="int-records-search">
          {copy.label}
        </label>
        {selected.length ? (
          <div className="int-picked">
            {selected.map((s) => (
              <span key={`${s.kind}:${s.id}`} className="int-chip">
                {s.label}
                <span className="int-chip__kind">{KIND_LABEL[s.kind] ?? s.kind}</span>
                <button type="button" aria-label={`Remove ${s.label}`} onClick={() => toggle(s)}>
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <input id="int-records-search" className="n-input int-input" placeholder={copy.placeholder} value={query} onChange={(e) => setQuery(e.target.value)} data-autofocus />
        <div className="int-list" role="listbox" aria-label="Records" aria-multiselectable>
          {q && q.length < copy.minChars ? <div className="int-empty">Keep typing to search.</div> : null}
          {results === null && !(q && q.length < copy.minChars) ? <div className="int-empty">Searching…</div> : null}
          {results && !others.length && !error ? <div className="int-empty">{q ? copy.empty : copy.none}</div> : null}
          {others.map((r) => (
            <button key={`${r.kind}:${r.id}`} type="button" role="option" aria-selected={false} className="int-option" onClick={() => toggle(r)}>
              <span className="int-option__main">
                {r.label}
                {r.subtitle ? <span className="int-option__sub">{r.subtitle}</span> : null}
              </span>
              <span className="int-option__kind">{KIND_LABEL[r.kind] ?? r.kind}</span>
            </button>
          ))}
          {provider === 'attio' && !q && list.length >= 25 ? <div className="int-empty">Showing the first 25. Search to find others.</div> : null}
        </div>
        {error ? <p className="int-error" role="alert">{error}</p> : null}
      </div>
      <div className="h-modal__footer">
        <button type="button" className="n-btn" onClick={() => closeShareDialog()} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="n-btn n-btn--primary" disabled={!selected.length || busy || !content || content === 'error'} onClick={() => void save()}>
          {busy ? 'Saving...' : copy.title}
        </button>
      </div>
    </Modal>
  )
}

// ---------- Zapier ----------

function ZapierDialog({ d }: { d: OpenDialog }): JSX.Element {
  const content = useContent(d)
  const [workflows, setWorkflows] = useState<IntegrationDestination[] | null>(null)
  const [query, setQuery] = useState('')
  const [checked, setChecked] = useState<string[]>([])
  useEffect(() => {
    void window.notula.integrations.listDestinations({ provider: 'zapier' }).then((all) => setWorkflows(all.filter((w) => w.trigger === 'share')))
  }, [])
  const shown = (workflows ?? []).filter((w) => !query.trim() || w.label.toLowerCase().includes(query.trim().toLowerCase()))

  const send = async (): Promise<void> => {
    if (!content || content === 'error' || !checked.length) return
    closeShareDialog()
    for (const id of checked) {
      const w = workflows?.find((x) => x.id === id)
      try {
        const { deliveryIds } = await window.notula.integrations.share({ provider: 'zapier', noteId: d.noteId, panelId: d.panelId, content, destinationIds: [id], delayMs: 10_000 })
        const rows = await window.notula.integrations.listDeliveries({ noteId: d.noteId, provider: 'zapier', limit: 100 })
        undoToast(rows.filter((r) => deliveryIds.includes(r.id)), `Sent to Zapier workflow ${w?.label ?? 'Untitled workflow'}`, 10_000)
        followUp('zapier', deliveryIds, d.noteId)
      } catch (err) {
        showToast({ kind: 'error', title: 'Couldn’t send to Zapier. Try again in a minute.', description: errorText(err) })
      }
    }
  }

  return (
    <Modal label="Choose a workflow" className="int-dialog" onClose={() => closeShareDialog()}>
      <Header title="Choose a workflow" onClose={() => closeShareDialog()} />
      <div className="h-modal__body int-body">
        <input className="n-input int-input" placeholder="Search workflows" value={query} onChange={(e) => setQuery(e.target.value)} data-autofocus aria-label="Search workflows" />
        <div className="int-list" role="listbox" aria-label="Workflows" aria-multiselectable>
          {workflows && !shown.length ? <div className="int-empty">No workflows found</div> : null}
          {shown.map((w) => {
            const on = checked.includes(w.id)
            return (
              <button
                key={w.id}
                type="button"
                role="option"
                aria-selected={on}
                className={`int-option${on ? ' int-option--on' : ''}`}
                disabled={w.status !== 'ok'}
                onClick={() => setChecked((c) => (on ? c.filter((x) => x !== w.id) : [...c, w.id]))}
              >
                <span className={`int-check${on ? ' int-check--on' : ''}`} aria-hidden="true" />
                <span className="int-option__main">
                  {w.label}
                  {w.status !== 'ok' ? <span className="int-option__sub">Disconnected</span> : null}
                </span>
              </button>
            )
          })}
        </div>
      </div>
      <div className="h-modal__footer">
        <button type="button" className="n-btn" onClick={() => closeShareDialog()}>
          Cancel
        </button>
        <button type="button" className="n-btn n-btn--primary" disabled={!checked.length || !content || content === 'error'} onClick={() => void send()}>
          Send
        </button>
      </div>
    </Modal>
  )
}

// ---------- host ----------

export function IntegrationsDialogsHost(): JSX.Element | null {
  const open = useShareDialog()

  // Undo survives a renderer reload: re-offer it for manual sends still waiting.
  useEffect(() => {
    let alive = true
    void window.notula.integrations
      .listDeliveries({ limit: 100 })
      .then((rows) => {
        if (!alive) return
        const waiting = rows.filter((r) => r.status === 'scheduled' && r.trigger === 'manual' && r.nextAttemptAt && Date.parse(r.nextAttemptAt) > Date.now())
        const groups = new Map<string, IntegrationDelivery[]>()
        for (const r of waiting) {
          const key = r.provider === 'attio' ? `attio:${r.noteId}:${r.createdAt.slice(0, 19)}` : r.id
          groups.set(key, [...(groups.get(key) ?? []), r])
        }
        void window.notula.integrations.listDestinations({ provider: 'zapier' }).then((zaps) => {
          for (const g of groups.values()) {
            const first = g[0]
            if (!first?.nextAttemptAt) continue
            const left = Date.parse(first.nextAttemptAt) - Date.now()
            const title = first.provider === 'attio' ? 'Saved to Attio' : `Sent to Zapier workflow ${zaps.find((z) => z.id === first.destinationId)?.label ?? 'Untitled workflow'}`
            undoToast(g, title, left)
            followUp(first.provider, g.map((x) => x.id), first.noteId)
          }
        })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // Folder auto-sync results for Attio.
  useEffect(
    () =>
      onDelivery((d) => {
        if (d.provider !== 'attio' || d.trigger !== 'folder') return
        if (d.errorCode === 'no_records') showToast({ id: `attio-folder-${d.noteId}`, kind: 'error', title: 'Not saved to Attio: no records match this meeting' })
        else if (d.status === 'sent') showToast({ id: `attio-folder-${d.noteId}`, kind: 'success', title: 'Saved to Attio' })
      }),
    []
  )

  const dialog = useMemo(() => {
    if (!open) return null
    if (open.kind === 'slack') return <SlackDialog key={`${open.noteId}-slack`} d={open} />
    if (open.kind === 'zapier') return <ZapierDialog key={`${open.noteId}-zapier`} d={open} />
    return <RecordsDialog key={`${open.noteId}-${open.kind}`} d={open} provider={open.kind} />
  }, [open])
  return dialog
}
