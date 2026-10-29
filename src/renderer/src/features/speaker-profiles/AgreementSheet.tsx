// SPDX-License-Identifier: Apache-2.0
// The agreement sheet itself. It slides down from the top edge of
// the window over a dimmed page. A click outside doesn't close it (the sheet nudges instead),
// and Esc closes it only while nothing has been filled in, so the fields survive until Cancel
// or a decision. Pick the moment hides it while the transcript is in pick mode.
//
// What crosses IPC: Copy message sends the person id and the language (main writes the
// clipboard); Remember sends the method, the language, the notice version and the evidence that
// fits the method: the pasted reply (≤ 20,000 characters) for Email or Written, only the note id
// and the time for a picked moment. The preview is built here from the shared template, with the
// person's name as main records it (`speaker-people:get`) and the user's name as the sender.

import { useEffect, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { parseError } from '@shared/errors'
import { AGREEMENT_SENDER_REQUIRED, voiceAgreementMessage, VOICE_AGREEMENT_VERSION } from '@shared/lib/speaker-notices'
import { SPEAKER_PROFILE_LIMITS, type SpeakerAgreementMethod, type SpeakerNoticeLanguage } from '@shared/types/speakers'
import { currentRoute, navigate } from '../../app/navigation'
import { debugLog } from '../../app/platform'
import { getPrefs, setPrefs, subscribePrefs } from '../settings/prefs-store'
import { settleSheet, useOpenSheet, type AgreementSheetRequest, type AgreementSheetResult } from './agreement-sheet'
import { cancelPickMode, startPickMode, type PickedTurn } from './pick-mode'
import * as S from './strings'
import './speaker-profiles.css'

const MAX_REPLY = SPEAKER_PROFILE_LIMITS.evidenceTextMaxChars
/** The counter shows once fewer characters than this are left. */
const COUNTER_FROM = 2_000
const COPIED_MS = 2_000
/** How long Copy and Remember wait for main to store a newly typed sender name. */
const SENDER_SAVE_MS = 2_000
/** `profile.name`'s length cap (the profile form's). */
const MAX_SENDER = 500

const METHODS: { value: SpeakerAgreementMethod; label: () => string }[] = [
  { value: 'email', label: S.methodEmail },
  { value: 'spoken', label: S.methodSpoken },
  { value: 'written', label: S.methodWritten },
  { value: 'other', label: S.methodOther }
]

const LANGUAGES: { value: SpeakerNoticeLanguage; label: () => string }[] = [
  { value: 'en', label: S.languageEnglish },
  { value: 'pt', label: S.languagePortuguese }
]

function defaultLanguage(): SpeakerNoticeLanguage {
  return navigator.language.toLowerCase().startsWith('pt') ? 'pt' : 'en'
}

function userName(): string {
  return (getPrefs()?.['profile.name'] ?? '').trim()
}

/** Saves the sender's name to `profile.name` and resolves once main has stored it (or after a short wait). */
function saveUserName(value: string): Promise<void> {
  return new Promise((resolve) => {
    let off = (): void => undefined
    const done = (): void => {
      clearTimeout(timer)
      off()
      resolve()
    }
    const timer = setTimeout(done, SENDER_SAVE_MS)
    off = window.notula.prefs.onChanged(({ settings }) => {
      if (settings['profile.name'].trim() === value) done()
    })
    setPrefs({ 'profile.name': value })
  })
}

/** Rejections arrive as "Error invoking remote method …: Error: <code>: <message>". */
function errorMessage(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : String(err)
  const m = /(?:busy|stale|invalid-input|not-found): ([\s\S]*)$/.exec(raw)
  return m?.[1]?.trim() || fallback
}

function timeOf(atMs: number): string {
  return new Date(atMs).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

/** A segmented control of radio buttons: one choice, arrow keys move it. */
function Segmented<T extends string>({
  name,
  label,
  options,
  value,
  onChange
}: {
  name: string
  label: string
  options: { value: T; label: () => string }[]
  value: T | null
  onChange(v: T): void
}): JSX.Element {
  return (
    <div className="nt-ags-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label key={o.value} className={`nt-ags-seg__item${value === o.value ? ' is-on' : ''}`}>
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
          <span>{o.label()}</span>
        </label>
      ))}
    </div>
  )
}

function Sheet({ req, onDone }: { req: AgreementSheetRequest; onDone(r: AgreementSheetResult): void }): JSX.Element {
  const [agreed, setAgreed] = useState(false)
  const [method, setMethod] = useState<SpeakerAgreementMethod | null>(null)
  const [language, setLanguage] = useState<SpeakerNoticeLanguage>(defaultLanguage)
  const [showMessage, setShowMessage] = useState(false)
  const [copied, setCopied] = useState(false)
  const [reply, setReply] = useState('')
  const [picked, setPicked] = useState<PickedTurn | null>(null)
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState<'record' | 'ask' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nudged, setNudged] = useState(false)
  const [user, setUser] = useState(userName)
  // The sender's name, asked for while the profile has none: the message is signed with it.
  const [senderDraft, setSenderDraft] = useState('')
  const [senderRequired, setSenderRequired] = useState(false)
  // The name main records and copies, which may differ from the one typed or picked.
  const [personName, setPersonName] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const alive = useRef(true)

  const name = personName ?? req.name
  const askSender = !user || senderRequired
  const sender = (senderRequired ? '' : user) || senderDraft.trim()
  const pristine = !agreed && method === null && !reply && !picked
  const canRemember = agreed && method !== null && busy === null && !!sender
  const canAsk = req.canAskFirst && !!req.noteId && !!req.identityKey
  const proofKind = method === 'email' || method === 'written' ? 'reply' : method === 'spoken' ? 'moment' : null

  useEffect(() => subscribePrefs(() => setUser(userName())), [])

  useEffect(() => {
    let live = true
    void window.notula.speakerPeople
      .get({ personId: req.personId })
      .then((v) => {
        if (live && v.person.name.trim()) setPersonName(v.person.name)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [req.personId])

  // Focus moves into the sheet and comes back on close; Tab stays inside it.
  useEffect(() => {
    alive.current = true
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // The statement first: the copy step is optional when the person already agreed.
    ref.current?.querySelector<HTMLElement>('input[type="checkbox"]')?.focus()
    debugLog('agreement-sheet-opened', { fromNote: !!req.noteId, canAskFirst: canAsk })
    return () => {
      alive.current = false
      cancelPickMode()
      previous?.focus()
    }
  }, [])

  // Esc: leaves pick mode; closes the sheet as Cancel only while nothing is filled in.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (picking) {
        cancelPickMode()
        return
      }
      e.preventDefault()
      if (pristine && busy === null) onDone({ outcome: 'cancel' })
      else setNudged(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [picking, pristine, busy, onDone])

  const trapTab = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Tab' || !ref.current) return
    const items = [...ref.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea')].filter((el) => el.offsetParent !== null)
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  /** Main's refusal while the profile has no name brings the field back, with main's message. */
  const failed = (err: unknown, fallback: string): void => {
    const message = parseError(err).message
    if (message.startsWith(AGREEMENT_SENDER_REQUIRED)) {
      setSenderRequired(true)
      setError(message.slice(AGREEMENT_SENDER_REQUIRED.length).replace(/^:\s*/, '') || fallback)
    } else setError(errorMessage(err, fallback))
  }

  /** Stores a typed sender name before Copy and Remember, so main signs with it. */
  const ensureSender = async (): Promise<void> => {
    const typed = senderDraft.trim()
    if (!askSender || !typed) return
    await saveUserName(typed)
    if (alive.current) setSenderRequired(false)
  }

  const copy = async (): Promise<void> => {
    setError(null)
    try {
      await ensureSender()
      await window.notula.speakerPeople.copyAgreementMessage({ personId: req.personId, language })
      setCopied(true)
      setTimeout(() => {
        if (alive.current) setCopied(false)
      }, COPIED_MS)
    } catch (err) {
      if (alive.current) failed(err, S.sheetCouldntCopy())
    }
  }

  const pick = async (): Promise<void> => {
    const noteId = req.noteId
    if (!noteId) return
    setError(null)
    setPicking(true)
    const target = `/meeting/${encodeURIComponent(noteId)}`
    if (currentRoute().path !== target) navigate(target)
    const turn = await startPickMode({ noteId, personName: name })
    if (!alive.current) return
    setPicking(false)
    if (turn) setPicked(turn)
  }

  const remember = async (): Promise<void> => {
    if (!agreed || !method) return
    setBusy('record')
    setError(null)
    const evidence =
      proofKind === 'reply' && reply.trim()
        ? { evidenceText: reply.slice(0, MAX_REPLY) }
        : proofKind === 'moment' && picked
          ? // Only the note and the time: main reads the words itself.
            { evidenceNoteId: picked.noteId, evidenceAtMs: picked.atMs }
          : {}
    try {
      await ensureSender()
      await window.notula.speakerPeople.recordAgreement({
        personId: req.personId,
        method,
        language,
        noticeVersion: VOICE_AGREEMENT_VERSION,
        ...evidence
      })
      onDone({ outcome: 'recorded' })
    } catch (err) {
      if (!alive.current) return
      setBusy(null)
      failed(err, S.sheetCouldntRecord())
    }
  }

  const askFirst = async (): Promise<void> => {
    if (!req.noteId || !req.identityKey) return
    setBusy('ask')
    setError(null)
    try {
      await window.notula.speakerNames.askFirst({ noteId: req.noteId, identityKey: req.identityKey, personId: req.personId })
      onDone({ outcome: 'ask-first' })
    } catch (err) {
      if (!alive.current) return
      setBusy(null)
      setError(errorMessage(err, S.sheetCouldntAsk()))
    }
  }

  const left = MAX_REPLY - reply.length
  const preview = voiceAgreementMessage(language, { name, user: sender })

  return (
    <div className={`nt-ags-layer${picking ? ' is-away' : ''}`} aria-hidden={picking || undefined}>
      <div className="nt-ags-backdrop" onMouseDown={() => setNudged(true)} />
      {picking ? (
        <div className="nt-ags-away" role="status">
          <span>{S.sheetPicking(name)}</span>
          <button type="button" className="n-btn n-btn--sm" onClick={cancelPickMode}>
            {S.sheetBackToSheet()}
          </button>
        </div>
      ) : null}
      <div
        className={`nt-ags${nudged ? ' is-nudged' : ''}`}
        onAnimationEnd={(e) => {
          if (e.animationName === 'nt-ags-nudge') setNudged(false)
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="nt-ags-title"
        ref={ref}
        onKeyDown={trapTab}
      >
        <h2 className="nt-ags__title" id="nt-ags-title">
          {S.sheetTitle(name)}
        </h2>
        <p className="nt-ags__intro">{S.sheetIntro(name)}</p>

        <section className="nt-ags__block">
          {askSender ? (
            <div className="nt-ags__field nt-ags__sender">
              <label className="nt-ags__label" htmlFor="nt-ags-sender">
                {S.sheetYourName()}
              </label>
              <input
                id="nt-ags-sender"
                className="n-input"
                type="text"
                value={senderDraft}
                maxLength={MAX_SENDER}
                autoComplete="name"
                spellCheck={false}
                placeholder={S.sheetYourNamePlaceholder()}
                aria-describedby="nt-ags-sender-hint"
                onChange={(e) => setSenderDraft(e.target.value)}
              />
              <span className="nt-ags__hint" id="nt-ags-sender-hint">
                {S.sheetYourNameHint()}
              </span>
            </div>
          ) : null}
          <div className="nt-ags__row">
            <span className="nt-ags__label">{S.sheetMessageTo(name)}</span>
            <span className="nt-ags__row-end">
              <Segmented<SpeakerNoticeLanguage> name="nt-ags-lang" label={S.languageLabel()} options={LANGUAGES} value={language} onChange={setLanguage} />
              <button type="button" className="n-btn n-btn--sm" disabled={!sender || busy !== null} onClick={() => void copy()} aria-live="polite">
                {copied ? S.sheetCopied() : S.sheetCopyMessage()}
              </button>
            </span>
          </div>
          <button type="button" className="nt-ags__disclosure" aria-expanded={showMessage} onClick={() => setShowMessage((v) => !v)}>
            <span className="nt-ags__chevron" aria-hidden="true" />
            {showMessage ? S.sheetHideMessage() : S.sheetShowMessage()}
          </button>
          {showMessage ? (
            <blockquote className="nt-ags__preview" lang={language}>
              {preview}
            </blockquote>
          ) : null}
        </section>

        <section className="nt-ags__block">
          <label className="nt-ags__check">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>{S.sheetAgreed(name)}</span>
          </label>
          <div className="nt-ags__field">
            <span className="nt-ags__label" id="nt-ags-how">
              {S.sheetHow(name)}
            </span>
            <Segmented<SpeakerAgreementMethod> name="nt-ags-method" label={S.sheetHow(name)} options={METHODS} value={method} onChange={setMethod} />
          </div>
          {proofKind === 'reply' ? (
            <div className="nt-ags__field">
              <label className="nt-ags__label" htmlFor="nt-ags-reply">
                {S.sheetPasteReply()} <span className="nt-ags__optional">{S.sheetProof()}</span>
              </label>
              <textarea
                id="nt-ags-reply"
                className="n-input nt-ags__reply"
                value={reply}
                maxLength={MAX_REPLY}
                placeholder={S.sheetPastePlaceholder(name)}
                spellCheck={false}
                onChange={(e) => setReply(e.target.value.slice(0, MAX_REPLY))}
                aria-describedby={left < COUNTER_FROM ? 'nt-ags-left' : undefined}
              />
              {left < COUNTER_FROM ? (
                <span className="nt-ags__counter" id="nt-ags-left">
                  {S.sheetCharsLeft(left)}
                </span>
              ) : null}
            </div>
          ) : null}
          {proofKind === 'moment' ? (
            <div className="nt-ags__field">
              <span className="nt-ags__label">
                {S.sheetPickMoment()} <span className="nt-ags__optional">{S.sheetProof()}</span>
              </span>
              {!req.noteId ? (
                <p className="nt-ags__hint">{S.sheetPickNoNote()}</p>
              ) : picked ? (
                <div className="nt-ags__picked">
                  <div className="nt-ags__picked-text">
                    <span className="nt-ags__picked-who">
                      {picked.speaker ? S.sheetPicked(picked.speaker, timeOf(picked.atMs)) : S.sheetPickedAt(timeOf(picked.atMs))}
                    </span>
                    {picked.text ? <span className="nt-ags__picked-quote">{picked.text}</span> : null}
                  </div>
                  <span className="nt-ags__row-end">
                    <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => void pick()}>
                      {S.sheetChange()}
                    </button>
                    <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => setPicked(null)}>
                      {S.sheetRemove()}
                    </button>
                  </span>
                </div>
              ) : (
                <div className="nt-ags__pick">
                  <p className="nt-ags__hint">{S.sheetPickHint(name)}</p>
                  <button type="button" className="n-btn n-btn--sm" onClick={() => void pick()}>
                    {S.sheetPickMoment()}
                  </button>
                </div>
              )}
            </div>
          ) : null}
        </section>

        <p className="nt-ags__free">{S.sheetFreeChoice(name)}</p>
        {canAsk ? <p className="nt-ags__fine">{S.sheetAskFirstHint(name)}</p> : null}
        {error ? (
          <p className="nt-ags__error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="nt-ags__footer">
          <button type="button" className="n-btn" disabled={busy !== null} onClick={() => onDone({ outcome: 'cancel' })}>
            {S.cancel()}
          </button>
          <span className="nt-ags__spacer" />
          {canAsk ? (
            <button type="button" className="n-btn" disabled={busy !== null} onClick={() => void askFirst()}>
              {S.sheetAskFirst(name)}
            </button>
          ) : null}
          <button type="button" className="n-btn n-btn--primary" disabled={!canRemember} aria-busy={busy === 'record'} onClick={() => void remember()}>
            {S.sheetRemember(name)}
          </button>
        </div>
      </div>
    </div>
  )
}

function SheetHost(): JSX.Element | null {
  const open = useOpenSheet()
  if (!open) return null
  return <Sheet key={open.id} req={open.req} onDone={(r) => settleSheet(open.id, r)} />
}

let root: ReturnType<typeof createRoot> | null = null

/** Mounts the sheet's root once, on `document.body`, above the app and below the toasts. */
export function mountAgreementSheet(): void {
  if (root) return
  const el = document.createElement('div')
  el.className = 'nt-ags-root'
  document.body.appendChild(el)
  root = createRoot(el)
  root.render(<SheetHost />)
}
