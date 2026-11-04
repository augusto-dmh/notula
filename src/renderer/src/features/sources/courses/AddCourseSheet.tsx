// SPDX-License-Identifier: Apache-2.0
// The Add course sheet, also Course settings: course, name, where you watch it, the history and
// window switch, lesson list, when a lesson plays, when it ends, audio, captions.
//
// - Opened with nothing to go on (Courses ▸ Add course), it first lists Recently played and a
//   link field; a pick asks `sources:course-candidates` for the prefilled sheet.
// - Opened from a card, a chip menu or the importer, it goes straight to the form. Courses with
//   no site or app yet (added from the vault) are offered as "Link to <course>".
// - The address found for a Chrome app is shown for the user to confirm; nothing is kept on
//   Cancel, because nothing is sent until Add course.
// - Settings saves through `sources:update-course`; the lesson list is the course page's.
// Every field stacks, so the sheet works in the narrow side window.

import { useEffect, useId, useState, type FormEvent, type JSX } from 'react'
import type {
  CourseBehavior,
  CourseCandidates,
  CourseLessonListInput,
  CourseListItem,
  CourseMatch,
  PlayingItem,
  SeriesKind,
  SourceProvider
} from '@shared/types/sources'
import { IconClose } from '../../../app/icons'
import { showToast } from '../../../app/toast'
import { Modal } from '../../folders/Modal'
import { Segmented, Switch } from '../../settings/controls'
import { refreshCourses } from './courses-store'
import { BROWSER_NAME, failure, listVaultCourses, pickVaultFolder, plural, type VaultCourse } from './helpers'
import './courses.css'

export interface AddCourseSheetProps {
  /** `settings`: Course settings for `seriesId`. */
  mode: 'add' | 'settings'
  /** Settings, or Add for a series already in Sources (a chip menu, the importer). */
  seriesId?: string | null
  /** Opened from a card or Recently played. */
  playbackId?: string | null
  /** A course or lesson URL typed into the link field. */
  url?: string | null
  /** The importer: the course's name from its folder. */
  title?: string | null
  /** The importer: the lesson list it found (an outline file handle). */
  lessonList?: CourseLessonListInput | null
  /** The course added or saved; null when cancelled. */
  onClose(result: CourseListItem | null): void
}

type ListKind = CourseLessonListInput['kind']

const LIST_LABEL: Record<ListKind, string> = {
  vault: 'From your study vault',
  paste: 'Paste a list',
  playlist: 'From the playlist',
  later: 'Later'
}

/** What the form is about: from a proposal, a series, or the course being edited. */
interface Base {
  seriesId: string | null
  kind: SeriesKind
  provider: SourceProvider
  canonicalKey: string | null
  title: string
  match: CourseMatch
  playsIn: string | null
  foundHost: string | null
  windowReadOffered: boolean
  lessonListOptions: ListKind[]
  behavior: CourseBehavior
  playbackId: string | null
}

const EMPTY_MATCH: CourseMatch = { apps: [], hosts: [], titles: [], keys: [], windowRead: false }
const DEFAULT_BEHAVIOR: CourseBehavior = { onPlay: 'record', onEnd: 'notes' }

type Load =
  | { status: 'pick' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'none' }
  | { status: 'ready'; base: Base; unlinked: CourseListItem[] }

function listOptions(kind: SeriesKind, offered?: readonly ListKind[]): ListKind[] {
  return offered ? [...offered] : ['vault', 'paste', ...(kind === 'playlist' ? (['playlist'] as const) : []), 'later']
}

async function seriesBase(seriesId: string): Promise<Omit<Base, 'playbackId'> | null> {
  const list = await window.notula.sources.listSeries()
  const s = list.find((x) => x.id === seriesId)
  if (!s) return null
  return {
    seriesId: s.id,
    kind: s.kind,
    provider: s.provider,
    canonicalKey: s.canonical_key,
    title: s.title,
    match: s.match ?? { ...EMPTY_MATCH, windowRead: s.provider !== 'youtube' },
    playsIn: s.provider === 'youtube' ? 'YouTube' : (s.match?.hosts[0] ?? null),
    foundHost: null,
    windowReadOffered: s.provider !== 'youtube',
    lessonListOptions: listOptions(s.kind),
    behavior: { onPlay: s.on_play, onEnd: s.on_end }
  }
}

async function loadBase(p: AddCourseSheetProps, source: { playbackId: string | null; url: string | null }): Promise<Load> {
  if (p.mode === 'settings') {
    if (!p.seriesId) return { status: 'none' }
    const view = await window.notula.sources.getCourse({ seriesId: p.seriesId })
    if (!view) return { status: 'none' }
    const s = view.detail.series
    return {
      status: 'ready',
      unlinked: [],
      base: {
        seriesId: s.id,
        kind: s.kind,
        provider: s.provider,
        canonicalKey: s.canonical_key,
        title: s.title,
        match: s.match ?? EMPTY_MATCH,
        playsIn: view.playsIn,
        foundHost: null,
        windowReadOffered: s.provider !== 'youtube',
        lessonListOptions: [],
        behavior: { onPlay: s.on_play, onEnd: s.on_end },
        playbackId: null
      }
    }
  }
  let candidates: CourseCandidates = { unlinked: [], proposal: null }
  if (source.playbackId || source.url) candidates = await window.notula.sources.courseCandidates({ playbackId: source.playbackId, url: source.url })
  const fromSeries = p.seriesId ? await seriesBase(p.seriesId) : null
  const pr = candidates.proposal
  const unlinked = candidates.unlinked.filter((c) => c.id !== p.seriesId)
  if (pr) {
    return {
      status: 'ready',
      unlinked: fromSeries ? [] : unlinked,
      base: {
        seriesId: fromSeries?.seriesId ?? null,
        kind: fromSeries?.kind ?? pr.kind,
        provider: fromSeries?.provider ?? pr.provider,
        canonicalKey: pr.canonicalKey,
        title: p.title?.trim() || fromSeries?.title || pr.title,
        match: pr.match,
        playsIn: pr.playsIn,
        foundHost: pr.foundHost,
        windowReadOffered: pr.windowReadOffered,
        lessonListOptions: listOptions(fromSeries?.kind ?? pr.kind, pr.lessonListOptions),
        behavior: DEFAULT_BEHAVIOR,
        playbackId: source.playbackId
      }
    }
  }
  if (fromSeries) {
    return {
      status: 'ready',
      unlinked: [],
      base: { ...fromSeries, title: p.title?.trim() || fromSeries.title, behavior: DEFAULT_BEHAVIOR, playbackId: source.playbackId }
    }
  }
  // The importer, for a course Sources doesn't know yet: a new course with no site or app, linked
  // on its first playback.
  if (p.title?.trim() && p.lessonList) {
    return {
      status: 'ready',
      unlinked: [],
      base: {
        seriesId: null,
        kind: 'course',
        provider: 'web',
        canonicalKey: `course:${crypto.randomUUID()}`,
        title: p.title.trim(),
        match: { ...EMPTY_MATCH, windowRead: true },
        playsIn: null,
        foundHost: null,
        windowReadOffered: true,
        lessonListOptions: listOptions('course'),
        behavior: DEFAULT_BEHAVIOR,
        playbackId: null
      }
    }
  }
  return { status: 'none' }
}

// ---------- the first step: Recently played and a link ----------

function playbackLine(item: PlayingItem): string {
  const p = item.playback
  return [p.app?.name ?? null, p.site, p.artist].filter((x): x is string => !!x).join(' · ')
}

function PickStep({ onPick, onClose }: { onPick(source: { playbackId: string | null; url: string | null }): void; onClose(): void }): JSX.Element {
  const [items, setItems] = useState<PlayingItem[] | null>(null)
  const [link, setLink] = useState('')
  const [invalid, setInvalid] = useState(false)
  const linkId = useId()

  useEffect(() => {
    let alive = true
    void window.notula.sources
      .listPlaying()
      .then((list) => alive && setItems([...list].sort((a, b) => (b.playback.seenAt ?? b.playback.updatedAt) - (a.playback.seenAt ?? a.playback.updatedAt)).slice(0, 20)))
      .catch(() => alive && setItems([]))
    return () => {
      alive = false
    }
  }, [])

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    const v = link.trim()
    if (!/^https?:\/\/\S+\.\S+/i.test(v)) {
      setInvalid(true)
      return
    }
    onPick({ playbackId: null, url: v })
  }

  return (
    <div className="h-modal__body course-sheet__body">
      <SheetHeader title="Add course" subtitle="Pick a lesson you played, or paste a link to the course or one of its lessons." onClose={onClose} />
      <section className="course-sheet__field" aria-labelledby="course-sheet-recent-label">
        <h3 className="course-sheet__label" id="course-sheet-recent-label">
          Recently played
        </h3>
        {items === null ? (
          <p className="course-sheet__hint">Loading…</p>
        ) : items.length === 0 ? (
          <p className="course-sheet__hint">Nothing played lately. Play a lesson, or paste its link.</p>
        ) : (
          <ul className="course-sheet__recent">
            {items.map((item) => {
              const line = playbackLine(item)
              return (
                <li key={item.playback.id}>
                  <button
                    type="button"
                    id={`course-sheet-recent-${item.playback.id}`}
                    className="course-sheet__recent-row"
                    onClick={() => onPick({ playbackId: item.playback.id, url: item.draft?.url ?? item.playback.url ?? null })}
                  >
                    <span className="course-sheet__recent-title">{item.playback.title || 'Untitled video'}</span>
                    {line ? <span className="course-sheet__recent-meta">{line}</span> : null}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>
      <form className="course-sheet__field" onSubmit={submit}>
        <label className="course-sheet__label" htmlFor={linkId}>
          Link
        </label>
        <div className="course-sheet__inline">
          <input
            id={linkId}
            className="n-input"
            type="url"
            placeholder="https://community.example.com/c/…"
            value={link}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? `${linkId}-error` : undefined}
            data-autofocus
            onChange={(e) => {
              setLink(e.target.value)
              setInvalid(false)
            }}
          />
          <button type="submit" id="course-sheet-link-continue" className="n-btn n-btn--sm" disabled={!link.trim()}>
            Continue
          </button>
        </div>
        {invalid ? (
          <p className="course-sheet__error" id={`${linkId}-error`}>
            Enter a link that starts with https://.
          </p>
        ) : null}
      </form>
      <footer className="h-modal__footer">
        <button type="button" id="course-sheet-cancel" className="n-btn" onClick={onClose}>
          Cancel
        </button>
      </footer>
    </div>
  )
}

function SheetHeader({ title, subtitle, onClose }: { title: string; subtitle?: string; onClose(): void }): JSX.Element {
  return (
    <header className="h-modal__header">
      <div>
        <h2 className="h-modal__title">{title}</h2>
        {subtitle ? <p className="h-modal__subtitle">{subtitle}</p> : null}
      </div>
      <button type="button" className="n-icon-btn n-icon-btn--sm" aria-label="Close" onClick={onClose}>
        <IconClose size={15} />
      </button>
    </header>
  )
}

// ---------- the lesson list field ----------

interface VaultState {
  root: { handle: string; name: string } | null
  courses: VaultCourse[] | null
  /** The course folder's handle. */
  picked: string | null
  pickedTitle: string | null
  error: string | null
  busy: boolean
}

function VaultPicker({ state, set }: { state: VaultState; set(patch: Partial<VaultState>): void }): JSX.Element {
  const choose = async (): Promise<void> => {
    set({ busy: true, error: null })
    try {
      const root = await pickVaultFolder()
      if (!root) {
        set({ busy: false })
        return
      }
      const courses = await listVaultCourses(root.handle)
      set({
        busy: false,
        root,
        courses,
        picked: courses.length === 1 ? (courses[0]?.folder ?? null) : null,
        pickedTitle: courses.length === 1 ? (courses[0]?.title ?? null) : null,
        error: courses.length === 0 ? 'No course folders found there. Choose the vault’s courses folder or a course folder.' : null
      })
    } catch (err) {
      set({ busy: false, error: failure(err, 'read that folder') })
    }
  }
  return (
    <div className="course-sheet__sub">
      <div className="course-sheet__inline">
        <button type="button" id="course-sheet-vault-choose" className="n-btn n-btn--sm" disabled={state.busy} onClick={() => void choose()}>
          {state.busy ? 'Reading…' : state.root ? 'Choose another folder…' : 'Choose folder…'}
        </button>
        {state.root ? <span className="course-sheet__hint course-sheet__ellipsis">{state.root.name}</span> : null}
        {!state.root && state.pickedTitle ? <span className="course-sheet__hint course-sheet__ellipsis">{state.pickedTitle}</span> : null}
      </div>
      {state.courses && state.courses.length > 0 ? (
        <fieldset className="course-sheet__choices">
          <legend className="course-sheet__hint">Course folder</legend>
          {state.courses.map((c) => (
            <label key={c.folder} className="course-sheet__choice">
              <input
                type="radio"
                name="course-sheet-vault-course"
                id={`course-sheet-vault-${c.folder}`}
                checked={state.picked === c.folder}
                onChange={() => set({ picked: c.folder, pickedTitle: c.title })}
              />
              <span className="course-sheet__choice-text">
                <span>{c.title}</span>
                <span className="course-sheet__hint">
                  {plural(c.items, 'lesson', 'lessons')}
                  {c.urls > 0 ? `, ${plural(c.urls, 'link', 'links')}` : ''}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      {state.error ? (
        <p className="course-sheet__error" role="alert">
          {state.error}
        </p>
      ) : null}
    </div>
  )
}

// ---------- the form ----------

function CourseForm({ props, base, unlinked, onClose }: { props: AddCourseSheetProps; base: Base; unlinked: CourseListItem[]; onClose(result: CourseListItem | null): void }): JSX.Element {
  const settings = props.mode === 'settings'
  const nameId = useId()
  const pasteId = useId()
  const switchLineId = useId()
  const [linkTo, setLinkTo] = useState<string | null>(null)
  const [title, setTitle] = useState(base.title)
  const [confirmHost, setConfirmHost] = useState(true)
  const [windowRead, setWindowRead] = useState(settings ? base.match.windowRead : true)
  const options = base.lessonListOptions
  const preset = props.lessonList ?? null
  // A channel has no list to read: Later, so Add course isn't held up by a folder it doesn't need.
  const [list, setList] = useState<ListKind>(preset?.kind ?? (base.kind === 'channel' && options.includes('later') ? 'later' : (options[0] ?? 'later')))
  const [paste, setPaste] = useState(preset?.kind === 'paste' ? preset.text : '')
  const [vault, setVaultState] = useState<VaultState>({
    root: null,
    courses: null,
    picked: preset?.kind === 'vault' ? preset.handle : null,
    pickedTitle: preset?.kind === 'vault' ? (props.title ?? null) : null,
    error: null,
    busy: false
  })
  const [onPlay, setOnPlay] = useState<CourseBehavior['onPlay']>(base.behavior.onPlay)
  const [onEnd, setOnEnd] = useState<CourseBehavior['onEnd']>(base.behavior.onEnd)
  const [captions, setCaptions] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const linking = linkTo !== null
  const youtube = base.provider === 'youtube'
  const hosts = base.foundHost && !confirmHost ? base.match.hosts.filter((h) => h !== base.foundHost) : base.match.hosts
  const browser = BROWSER_NAME[base.match.apps[0]?.browser ?? 'chrome'] ?? 'the browser'
  const hostWord = hosts[0] ?? 'this course’s'
  const showList = !settings && !linking && (options.length > 0 || preset !== null)
  const listOptionsShown: ListKind[] = preset && !options.includes(preset.kind) ? [preset.kind, ...options] : options
  const listReady = !showList || list === 'later' || list === 'playlist' || (list === 'paste' && paste.trim().length > 0) || (list === 'vault' && vault.picked !== null)
  const canSubmit = !busy && title.trim().length > 0 && listReady

  const lessonList = (): CourseLessonListInput => {
    if (!showList) return { kind: 'later' }
    switch (list) {
      case 'vault':
        return { kind: 'vault', handle: vault.picked as string }
      case 'paste':
        return { kind: 'paste', text: paste }
      case 'playlist':
        return { kind: 'playlist' }
      case 'later':
        return { kind: 'later' }
    }
  }

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    const behavior: CourseBehavior = { onPlay, onEnd }
    try {
      let result: CourseListItem
      if (settings) {
        result = await window.notula.sources.updateCourse({
          seriesId: base.seriesId as string,
          patch: {
            ...(title.trim() !== base.title ? { title: title.trim() } : {}),
            behavior,
            ...(base.windowReadOffered && windowRead !== base.match.windowRead ? { match: { windowRead } } : {})
          }
        })
        showToast({ kind: 'success', title: 'Course settings saved', durationMs: 3_000 })
      } else {
        const seriesId = linkTo ?? base.seriesId
        result = await window.notula.sources.addCourse({
          seriesId,
          draft: seriesId || !base.canonicalKey ? null : { kind: base.kind, provider: base.provider, canonicalKey: base.canonicalKey },
          title: title.trim(),
          behavior,
          match: { ...base.match, hosts, windowRead: base.windowReadOffered && windowRead },
          lessonList: lessonList(),
          captions: youtube && captions,
          playbackId: base.playbackId
        })
        showToast({ kind: 'success', title: `Added “${result.title}” to Courses`, durationMs: 4_000 })
      }
      refreshCourses()
      onClose(result)
    } catch (err) {
      setBusy(false)
      setError(failure(err, settings ? 'save the course' : 'add the course'))
    }
  }

  return (
    <form className="h-modal__body course-sheet__body" onSubmit={(e) => void submit(e)}>
      <SheetHeader title={settings ? 'Course settings' : 'Add course'} onClose={() => onClose(null)} />

      {!settings && unlinked.length > 0 ? (
        <fieldset className="course-sheet__field course-sheet__choices">
          <legend className="course-sheet__label">Course</legend>
          <label className="course-sheet__choice">
            <input type="radio" name="course-sheet-course" id="course-sheet-course-new" checked={!linking} onChange={() => setLinkTo(null)} />
            <span className="course-sheet__choice-text">New course</span>
          </label>
          {unlinked.map((c) => (
            <label key={c.id} className="course-sheet__choice">
              <input
                type="radio"
                name="course-sheet-course"
                id={`course-sheet-course-${c.id}`}
                checked={linkTo === c.id}
                onChange={() => {
                  setLinkTo(c.id)
                  setTitle(c.title)
                }}
              />
              <span className="course-sheet__choice-text">Link to {c.title}</span>
            </label>
          ))}
        </fieldset>
      ) : null}

      <div className="course-sheet__field">
        <label className="course-sheet__label" htmlFor={nameId}>
          Name
        </label>
        <input id={nameId} className="n-input" value={title} maxLength={500} data-autofocus onChange={(e) => setTitle(e.target.value)} />
      </div>

      <div className="course-sheet__field">
        <span className="course-sheet__label">Where you watch it</span>
        <p className="course-sheet__value">{base.playsIn ?? (hosts[0] || 'Not known yet. Notula links it the first time a lesson plays.')}</p>
        {base.foundHost ? (
          <label className="course-sheet__choice">
            <input type="checkbox" id="course-sheet-found-host" checked={confirmHost} onChange={(e) => setConfirmHost(e.target.checked)} />
            <span className="course-sheet__choice-text">
              <span>Its lessons are on {base.foundHost}</span>
              <span className="course-sheet__hint">Found in this app’s recent history.</span>
            </span>
          </label>
        ) : null}
      </div>

      {base.windowReadOffered ? (
        <div className="course-sheet__field course-sheet__switch-row">
          <div className="course-sheet__switch-text">
            <span className="course-sheet__label" id="course-sheet-recognize-label">
              Recognize its lessons using this browser’s history and the course window
            </span>
            <p className="course-sheet__hint" id={switchLineId}>
              Notula reads {hostWord} rows from a copy of {browser}’s history, and the lesson’s title, module and number from the course window while a
              lesson plays. On this PC only; the history copy is deleted right away.
            </p>
          </div>
          <Switch label="Recognize its lessons using this browser’s history and the course window" checked={windowRead} onChange={setWindowRead} />
        </div>
      ) : null}

      {showList ? (
        <fieldset className="course-sheet__field course-sheet__choices">
          <legend className="course-sheet__label">Lesson list</legend>
          {listOptionsShown.map((k) => (
            <div key={k}>
              <label className="course-sheet__choice">
                <input type="radio" name="course-sheet-list" id={`course-sheet-list-${k}`} checked={list === k} onChange={() => setList(k)} />
                <span className="course-sheet__choice-text">{LIST_LABEL[k]}</span>
              </label>
              {list === 'vault' && k === 'vault' ? <VaultPicker state={vault} set={(patch) => setVaultState((v) => ({ ...v, ...patch }))} /> : null}
              {list === 'paste' && k === 'paste' ? (
                <div className="course-sheet__sub">
                  <label className="visually-hidden" htmlFor={pasteId}>
                    Lessons
                  </label>
                  <textarea
                    id={pasteId}
                    className="n-input course-sheet__paste"
                    rows={6}
                    value={paste}
                    spellCheck={false}
                    placeholder={'## Module 1\n1. Welcome (04:12)\n2. Setting up https://…'}
                    onChange={(e) => setPaste(e.target.value.slice(0, 2 * 1024 * 1024))}
                  />
                  <p className="course-sheet__hint">One lesson per line, with an optional number, duration and link. Headings become sections.</p>
                </div>
              ) : null}
            </div>
          ))}
        </fieldset>
      ) : null}

      <div className="course-sheet__field">
        <span className="course-sheet__label" id="course-sheet-play-label">
          When a lesson plays
        </span>
        <Segmented<CourseBehavior['onPlay']>
          label="When a lesson plays"
          value={onPlay}
          options={[
            { value: 'record', label: 'Record automatically' },
            { value: 'ask', label: 'Ask me' }
          ]}
          onChange={setOnPlay}
        />
      </div>

      <div className="course-sheet__field">
        <span className="course-sheet__label" id="course-sheet-end-label">
          When it ends
        </span>
        <Segmented<CourseBehavior['onEnd']>
          label="When it ends"
          value={onEnd}
          options={[
            { value: 'notes', label: 'Write lesson notes' },
            { value: 'button', label: 'Show the button' }
          ]}
          onChange={setOnEnd}
        />
      </div>

      <div className="course-sheet__field">
        <span className="course-sheet__label">Audio</span>
        <p className="course-sheet__value">Video audio only (not your microphone)</p>
      </div>

      {youtube && !settings ? (
        <div className="course-sheet__field course-sheet__switch-row">
          <div className="course-sheet__switch-text">
            <span className="course-sheet__label">Use the video’s captions</span>
            <p className="course-sheet__hint">Notula asks YouTube for them.</p>
          </div>
          <Switch label="Use the video’s captions" checked={captions} onChange={setCaptions} />
        </div>
      ) : null}

      {error ? (
        <p className="course-sheet__error" role="alert">
          {error}
        </p>
      ) : null}
      <footer className="h-modal__footer">
        <button type="button" id="course-sheet-cancel" className="n-btn" disabled={busy} onClick={() => onClose(null)}>
          Cancel
        </button>
        <button type="submit" id="course-sheet-submit" className="n-btn n-btn--primary" disabled={!canSubmit}>
          {busy ? (settings ? 'Saving…' : 'Adding…') : settings ? 'Save' : 'Add course'}
        </button>
      </footer>
    </form>
  )
}

export function AddCourseSheet(props: AddCourseSheetProps): JSX.Element | null {
  const { mode, seriesId, playbackId, url, onClose } = props
  const startsWithPick = mode === 'add' && !seriesId && !playbackId && !url && !props.lessonList
  const [source, setSource] = useState<{ playbackId: string | null; url: string | null } | null>(startsWithPick ? null : { playbackId: playbackId ?? null, url: url ?? null })
  const [load, setLoad] = useState<Load>(startsWithPick ? { status: 'pick' } : { status: 'loading' })

  useEffect(() => {
    if (!source) return
    let alive = true
    setLoad({ status: 'loading' })
    loadBase(props, source)
      .then((l) => alive && setLoad(l))
      .catch((err: unknown) => alive && setLoad({ status: 'error', message: failure(err, 'read this course') }))
    return () => {
      alive = false
    }
    // The props are fixed while the sheet is open; a new source reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source])

  const close = (result: CourseListItem | null): void => onClose(result)
  const label = mode === 'settings' ? 'Course settings' : 'Add course'

  return (
    <Modal label={label} className="course-sheet" onClose={() => close(null)}>
      {load.status === 'pick' ? (
        <PickStep onPick={setSource} onClose={() => close(null)} />
      ) : load.status === 'ready' ? (
        <CourseForm props={props} base={load.base} unlinked={load.unlinked} onClose={close} />
      ) : (
        <div className="h-modal__body course-sheet__body">
          <SheetHeader title={label} onClose={() => close(null)} />
          {load.status === 'loading' ? (
            <p className="course-sheet__hint" role="status">
              Loading…
            </p>
          ) : (
            <p className="course-sheet__error" role="alert">
              {load.status === 'error'
                ? load.message
                : 'Notula can’t tell which course this is. Paste a link to the course or one of its lessons.'}
            </p>
          )}
          <footer className="h-modal__footer">
            {startsWithPick && load.status !== 'loading' ? (
              <button type="button" id="course-sheet-back" className="n-btn" onClick={() => (setSource(null), setLoad({ status: 'pick' }))}>
                Back
              </button>
            ) : null}
            <button type="button" id="course-sheet-cancel" className="n-btn" onClick={() => close(null)}>
              Cancel
            </button>
          </footer>
        </div>
      )}
    </Modal>
  )
}
