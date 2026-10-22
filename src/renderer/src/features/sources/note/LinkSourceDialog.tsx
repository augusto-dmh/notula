// SPDX-License-Identifier: Apache-2.0
// Link source by hand, from the note chip:
// - Link: Recently played (`sources:list-playing`), a link field parsed at once for known
//   providers (`parseSourceUrl`), and Search by title (`sources:search`, lookups granted). A
//   manual link with a URL is `exact`. Linking a lesson from an unknown Circle community asks
//   once "Recognize lessons from <host>?".
// - Edit details: title, channel, series and lesson number (`sources:update`).
// - Unlink (`sources:unlink`), after a confirmation.
// Every channel may answer "No handler registered" while main has no handler for it; the dialog then
// says the action isn't available yet.

import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { parseError } from '@shared/errors'
import { parseSourceUrl, type ParsedSourceUrl } from '@shared/lib/source-key'
import { formatPosition } from '@shared/lib/position'
import type { NoteSourcePatch, NoteSourceView, PlayingItem, SeriesListItem, SourceDraft, SourceSearchResult } from '@shared/types/sources'
import { navigateToSettings } from '../../../app/navigation'
import { showToast } from '../../../app/toast'
import { setPrefs, getPrefs } from '../../settings/prefs-store'
import { isMissingHandler, trySources, useSourcesStatus } from './source-store'

export type LinkDialogMode = 'link' | 'edit' | 'unlink'

const PROVIDER_LABEL: Record<ParsedSourceUrl['provider'], string> = {
  youtube: 'YouTube',
  circle: 'Circle',
  udemy: 'Udemy',
  coursera: 'Coursera',
  hotmart: 'Hotmart',
  kiwify: 'Kiwify',
  memberkit: 'Memberkit',
  vimeo: 'Vimeo',
  web: 'Web page'
}

const KIND_LABEL: Record<ParsedSourceUrl['kind'], string> = {
  video: 'video',
  live: 'live stream',
  lesson: 'lesson',
  other: 'page'
}

function failure(err: unknown, action: string): string {
  if (isMissingHandler(err)) return `${action} isn’t available in this build yet.`
  const { code, message } = parseError(err)
  if (code === 'invalid-input' && message) return message
  return `Couldn’t ${action.toLowerCase()}. Try again.`
}

function draftFromUrl(p: ParsedSourceUrl, title: string): SourceDraft {
  return {
    canonicalKey: p.canonicalKey,
    provider: p.provider,
    kind: p.kind,
    url: p.url,
    title,
    channel: null,
    durationMs: null,
    live: p.kind === 'live',
    confidence: 'exact',
    detectedVia: 'manual',
    site: p.host,
    series: p.series,
    lesson: null
  }
}

function draftLine(d: SourceDraft): string {
  const parts = [d.channel, d.site].filter((x): x is string => !!x)
  if (d.durationMs !== null && d.durationMs > 0) parts.push(formatPosition(d.durationMs))
  return parts.join(' · ')
}

/** Asks once, after a manual Circle link, whether to read that community's lessons from History. */
function offerCourseHost(p: ParsedSourceUrl | null): void {
  if (!p || p.provider !== 'circle' || !p.host) return
  const host = p.host.toLowerCase()
  const prefs = getPrefs()
  if (!prefs || prefs['sources.courseHosts'].includes(host) || prefs['sources.dismissedHints'].includes(`course-host:${host}`)) return
  void trySources('sources:dismiss-hint-failed', () => window.notula.sources.dismissHint({ hint: 'course-host', key: host }))
  showToast({
    id: 'source-course-host',
    title: `Recognize lessons from ${host}?`,
    description: 'Notula then looks for this site’s lessons in your browser history.',
    action: {
      label: 'Recognize lessons',
      onClick: () => {
        const hosts = getPrefs()?.['sources.courseHosts'] ?? []
        if (!hosts.includes(host)) setPrefs({ 'sources.courseHosts': [...hosts, host].slice(0, 100) })
      }
    }
  })
}

function DraftRow({ draft, hint, onPick, disabled }: { draft: SourceDraft; hint?: string; onPick(): void; disabled: boolean }): JSX.Element {
  const line = draftLine(draft)
  return (
    <li>
      <button type="button" className="src-pick" disabled={disabled} onClick={onPick}>
        <span className="src-pick__title">{draft.title}</span>
        {line || hint ? <span className="src-pick__meta">{[line, hint].filter(Boolean).join(' · ')}</span> : null}
      </button>
    </li>
  )
}

function LinkBody({
  noteId,
  current,
  onDone,
  onCancel
}: {
  noteId: string
  current: NoteSourceView | null
  onDone(): void
  onCancel(): void
}): JSX.Element {
  const { status } = useSourcesStatus()
  const lookups = status?.grant.onlineLookups ?? getPrefs()?.['sources.onlineLookups'] ?? false
  const [playing, setPlaying] = useState<PlayingItem[] | null>(null)
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SourceSearchResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const urlId = useId()
  const titleId = useId()
  const queryId = useId()
  const errorId = useId()

  useEffect(() => {
    let alive = true
    void trySources('sources:list-playing-failed', () => window.notula.sources.listPlaying()).then((items) => {
      if (alive) setPlaying((items ?? []).filter((i) => i.draft !== null))
    })
    const off = window.notula.sources.onPlayingChanged((items) => setPlaying(items.filter((i) => i.draft !== null)))
    return () => {
      alive = false
      off()
    }
  }, [])

  const parsed = useMemo(() => (url.trim() ? parseSourceUrl(url.trim()) : null), [url])
  const urlInvalid = url.trim() !== '' && parsed === null

  async function link(draft: SourceDraft, from: ParsedSourceUrl | null): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await window.notula.sources.link({ noteId, draft })
      offerCourseHost(from)
      showToast({ id: 'source-linked', kind: 'success', title: current ? 'Source changed' : 'Source linked' })
      onDone()
    } catch (err) {
      setError(failure(err, current ? 'Change the source' : 'Link the source'))
      setBusy(false)
    }
  }

  function onLinkUrl(e: FormEvent): void {
    e.preventDefault()
    if (!parsed || busy) return
    const match = playing?.find((i) => i.draft?.canonicalKey === parsed.canonicalKey)?.draft ?? null
    const name = title.trim() || match?.title || (current?.source.canonical_key === parsed.canonicalKey ? current.source.title : '') || parsed.url
    const draft = match
      ? { ...match, url: parsed.url, confidence: 'exact' as const, detectedVia: 'manual' as const, title: title.trim() || match.title }
      : draftFromUrl(parsed, name)
    void link(draft, parsed)
  }

  async function onSearch(e: FormEvent): Promise<void> {
    e.preventDefault()
    const q = query.trim()
    if (!q || searching || !lookups) return
    setSearching(true)
    setError(null)
    try {
      setResults(await window.notula.sources.search({ query: q }))
    } catch (err) {
      setResults(null)
      setError(failure(err, 'Search'))
    } finally {
      setSearching(false)
    }
  }

  return (
    <>
      <div className="src-dialog__body">
        <section className="src-section" aria-labelledby={`${urlId}-h`}>
          <h3 className="src-section__title" id={`${urlId}-h`}>
            Recently played
          </h3>
          {playing === null ? (
            <p className="src-section__empty">Loading…</p>
          ) : playing.length === 0 ? (
            <p className="src-section__empty">Nothing played recently. Videos you play in Edge or Chrome show up here.</p>
          ) : (
            <ul className="src-picks">
              {playing.slice(0, 20).map((i) => (
                <DraftRow
                  key={i.playback.id}
                  draft={i.draft as SourceDraft}
                  hint={i.noteId && i.noteId !== noteId ? 'Has a note' : undefined}
                  disabled={busy}
                  onPick={() => void link(i.draft as SourceDraft, i.draft?.url ? parseSourceUrl(i.draft.url) : null)}
                />
              ))}
            </ul>
          )}
        </section>

        <form className="src-section" onSubmit={onLinkUrl}>
          <label className="src-section__title" htmlFor={urlId}>
            Link
          </label>
          <div className="src-field-row">
            <input
              id={urlId}
              className="n-input"
              type="url"
              inputMode="url"
              placeholder="https://www.youtube.com/watch?v=…"
              value={url}
              aria-invalid={urlInvalid || undefined}
              aria-describedby={urlInvalid ? `${urlId}-hint` : undefined}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button type="submit" className="n-btn n-btn--primary" disabled={!parsed || busy}>
              {current ? 'Change source' : 'Link source'}
            </button>
          </div>
          {urlInvalid ? (
            <p className="src-field-hint src-field-hint--error" id={`${urlId}-hint`}>
              Enter a link that starts with https://.
            </p>
          ) : parsed ? (
            <p className="src-field-hint">
              {PROVIDER_LABEL[parsed.provider]} {KIND_LABEL[parsed.kind]}
              {parsed.series?.title ? ` in “${parsed.series.title}”` : ''}
            </p>
          ) : null}
          {parsed ? (
            <>
              <label className="src-field-label" htmlFor={titleId}>
                Title (optional)
              </label>
              <input
                id={titleId}
                className="n-input"
                type="text"
                placeholder="The video or lesson title"
                value={title}
                maxLength={300}
                onChange={(e) => setTitle(e.target.value)}
              />
            </>
          ) : null}
        </form>

        <form className="src-section" onSubmit={(e) => void onSearch(e)}>
          <label className="src-section__title" htmlFor={queryId}>
            Search by title
          </label>
          <div className="src-field-row">
            <input
              id={queryId}
              className="n-input"
              type="search"
              placeholder="Video title and channel"
              value={query}
              disabled={!lookups}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button type="submit" className="n-btn" disabled={!lookups || !query.trim() || searching}>
              {searching ? 'Searching…' : 'Search'}
            </button>
          </div>
          {!lookups ? (
            <p className="src-field-hint">
              Search needs online lookups.{' '}
              <button type="button" className="src-inline-link" onClick={() => (onCancel(), navigateToSettings('sources'))}>
                Open source settings
              </button>
            </p>
          ) : null}
          {results !== null ? (
            results.length === 0 ? (
              <p className="src-section__empty">No matching videos found.</p>
            ) : (
              <ul className="src-picks">
                {results.map((r) => (
                  <DraftRow key={r.draft.canonicalKey} draft={r.draft} disabled={busy} onPick={() => void link(r.draft, r.draft.url ? parseSourceUrl(r.draft.url) : null)} />
                ))}
              </ul>
            )
          ) : null}
        </form>

        {error ? (
          <p className="src-dialog__error" role="alert" id={errorId}>
            {error}
          </p>
        ) : null}
      </div>
      <div className="src-dialog__footer">
        <button type="button" className="n-btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </>
  )
}

function EditBody({ noteId, current, onDone, onCancel }: { noteId: string; current: NoteSourceView; onDone(): void; onCancel(): void }): JSX.Element {
  const s = current.source
  const [title, setTitle] = useState(s.title)
  const [channel, setChannel] = useState(s.channel ?? '')
  const [seriesId, setSeriesId] = useState(s.series_id ?? '')
  const [lesson, setLesson] = useState(s.lesson_number !== null ? String(s.lesson_number) : '')
  const [series, setSeries] = useState<SeriesListItem[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ids = { title: useId(), channel: useId(), series: useId(), lesson: useId() }

  useEffect(() => {
    let alive = true
    void trySources('sources:list-series-failed', () => window.notula.sources.listSeries()).then((list) => {
      if (alive) setSeries(list)
    })
    return () => {
      alive = false
    }
  }, [])

  const lessonValue = lesson.trim() === '' ? null : Number(lesson)
  const lessonInvalid = lessonValue !== null && (!Number.isInteger(lessonValue) || lessonValue < 1 || lessonValue > 9999)
  const titleInvalid = title.trim() === ''

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (busy || lessonInvalid || titleInvalid) return
    const patch: NoteSourcePatch = {}
    if (title.trim() !== s.title) patch.title = title.trim()
    const ch = channel.trim() || null
    if (ch !== s.channel) patch.channel = ch
    const sid = seriesId || null
    if (sid !== s.series_id) patch.series_id = sid
    if (lessonValue !== s.lesson_number) {
      patch.lesson_number = lessonValue
      patch.lesson_label = null
    }
    if (Object.keys(patch).length === 0) {
      onCancel()
      return
    }
    setBusy(true)
    setError(null)
    try {
      await window.notula.sources.update({ noteId, patch })
      showToast({ id: 'source-updated', kind: 'success', title: 'Source updated' })
      onDone()
    } catch (err) {
      setError(failure(err, 'Save the changes'))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void save(e)}>
      <div className="src-dialog__body">
        <label className="src-field-label" htmlFor={ids.title}>
          Title
        </label>
        <input id={ids.title} className="n-input" value={title} maxLength={300} aria-invalid={titleInvalid || undefined} onChange={(e) => setTitle(e.target.value)} />
        <label className="src-field-label" htmlFor={ids.channel}>
          Channel or author
        </label>
        <input id={ids.channel} className="n-input" value={channel} maxLength={200} onChange={(e) => setChannel(e.target.value)} />
        {series && series.length > 0 ? (
          <>
            <label className="src-field-label" htmlFor={ids.series}>
              Series
            </label>
            <select id={ids.series} className="n-input" value={seriesId} onChange={(e) => setSeriesId(e.target.value)}>
              <option value="">No series</option>
              {series.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.title}
                </option>
              ))}
            </select>
          </>
        ) : null}
        <label className="src-field-label" htmlFor={ids.lesson}>
          Lesson number
        </label>
        <input
          id={ids.lesson}
          className="n-input src-field-number"
          inputMode="numeric"
          placeholder="—"
          value={lesson}
          aria-invalid={lessonInvalid || undefined}
          aria-describedby={lessonInvalid ? `${ids.lesson}-hint` : undefined}
          onChange={(e) => setLesson(e.target.value)}
        />
        {lessonInvalid ? (
          <p className="src-field-hint src-field-hint--error" id={`${ids.lesson}-hint`}>
            Use a whole number from 1 to 9999.
          </p>
        ) : (
          <p className="src-field-hint">A number you set here is never replaced by a catalog.</p>
        )}
        {error ? (
          <p className="src-dialog__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="src-dialog__footer">
        <button type="button" className="n-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="n-btn n-btn--primary" disabled={busy || lessonInvalid || titleInvalid}>
          Save
        </button>
      </div>
    </form>
  )
}

function UnlinkBody({ noteId, onDone, onCancel }: { noteId: string; onDone(): void; onCancel(): void }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function unlink(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await window.notula.sources.unlink({ noteId })
      showToast({ id: 'source-unlinked', title: 'Source unlinked' })
      onDone()
    } catch (err) {
      setError(failure(err, 'Unlink the source'))
      setBusy(false)
    }
  }
  return (
    <>
      <div className="src-dialog__body">
        <p className="src-dialog__text">The note keeps its text and timestamps. It’s no longer linked to this video, its series or its folder rules.</p>
        {error ? (
          <p className="src-dialog__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="src-dialog__footer">
        <button type="button" className="n-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="n-btn n-btn--danger" autoFocus disabled={busy} onClick={() => void unlink()}>
          Unlink source
        </button>
      </div>
    </>
  )
}

const TITLES: Record<LinkDialogMode, { link: string; change: string }> = {
  link: { link: 'Link a source', change: 'Change source' },
  edit: { link: 'Edit source details', change: 'Edit source details' },
  unlink: { link: 'Unlink this source?', change: 'Unlink this source?' }
}

export function LinkSourceDialog({
  noteId,
  current,
  mode,
  onClose,
  onDone
}: {
  noteId: string
  current: NoteSourceView | null
  mode: LinkDialogMode
  onClose(): void
  onDone(): void
}): JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const effective: LinkDialogMode = current ? mode : 'link'

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('input:not(:disabled), button.n-btn--danger')?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="src-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="src-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef}>
        <h2 className="src-dialog__title" id={titleId}>
          {current ? TITLES[effective].change : TITLES[effective].link}
        </h2>
        {effective === 'edit' && current ? (
          <EditBody noteId={noteId} current={current} onDone={onDone} onCancel={onClose} />
        ) : effective === 'unlink' ? (
          <UnlinkBody noteId={noteId} onDone={onDone} onCancel={onClose} />
        ) : (
          <LinkBody noteId={noteId} current={current} onDone={onDone} onCancel={onClose} />
        )}
      </div>
    </div>,
    document.body
  )
}
