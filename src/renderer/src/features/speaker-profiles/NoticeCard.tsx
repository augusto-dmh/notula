// SPDX-License-Identifier: Apache-2.0
// The one-time notice card at the top of Home: shown while
// `speakers.noticeSeen` is false; Got it or its close button sets it, and it never returns.
// It's a card in the page, not a modal: the layers run whether or not it's read.

import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import type { SpeakerNoticeLanguage } from '@shared/types/speakers'
import { navigateToSettings } from '../../app/navigation'
import { debugLog, isMac } from '../../app/platform'
import { showToast } from '../../app/toast'
import { usePrefs } from '../settings/prefs-store'
import { useLocalModelState } from '../transcript/speech-state'
import * as S from './strings'
import './speaker-profiles.css'

const LEAVE_MS = 200

/** A button that opens a small menu of languages. */
export function LanguageMenuButton({
  label,
  onPick,
  className
}: {
  label: string
  onPick(language: SpeakerNoticeLanguage): void
  className?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    ref.current?.querySelector<HTMLElement>('.nt-menu__list button')?.focus()
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  const item = (language: SpeakerNoticeLanguage, text: string): ReactNode => (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        setOpen(false)
        onPick(language)
      }}
    >
      {text}
    </button>
  )
  return (
    <span className="nt-menu" ref={ref}>
      <button type="button" className={className ?? 'n-btn n-btn--sm'} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {label}
      </button>
      {open ? (
        <span className="nt-menu__list" role="menu">
          {item('en', S.languageEnglish())}
          {item('pt', S.languagePortuguese())}
        </span>
      ) : null}
    </span>
  )
}

/** Copy a notice for participants: main builds the text (with the provider sentence when it applies). */
export async function copyParticipantNotice(language: SpeakerNoticeLanguage): Promise<void> {
  try {
    const { text } = await window.notula.speakers.participantNotice({ language })
    await window.notula.clipboard.writeText({ text })
    showToast({ id: 'speaker-participant-notice', kind: 'success', title: S.noticeCopied() })
  } catch {
    showToast({ id: 'speaker-participant-notice', kind: 'error', title: S.couldnt('copy the notice') })
  }
}

/** Appends the speaker-names sentence to the meeting notice, once. */
export async function addChatNoticeLine(language: SpeakerNoticeLanguage): Promise<void> {
  try {
    await window.notula.speakers.addChatNoticeLine({ language })
    showToast({ id: 'speaker-chat-notice', kind: 'success', title: S.noticeAdded() })
  } catch {
    showToast({ id: 'speaker-chat-notice', kind: 'error', title: S.couldnt('change the meeting notice') })
  }
}

function IconSpeakers(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M17 7.5v5M20 6v8" />
    </svg>
  )
}

function IconClose(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

export function NoticeCard(): JSX.Element | null {
  const prefs = usePrefs()
  const diarization = useLocalModelState('diarization-en')
  const [leaving, setLeaving] = useState(false)
  const [gone, setGone] = useState(false)

  useEffect(() => {
    if (prefs && !prefs['speakers.noticeSeen'] && !gone) debugLog('speaker-notice-shown')
  }, [prefs === null])

  if (!prefs || prefs['speakers.noticeSeen'] || gone) return null

  const dismiss = (): void => {
    setLeaving(true)
    void window.notula.speakers.dismissNotice().catch(() => undefined)
    setTimeout(() => setGone(true), LEAVE_MS)
  }

  const separationOn = prefs['transcription.diarization']
  const modelMissing = separationOn && (diarization?.state === 'missing' || diarization?.state === 'error')
  const download = (): void => {
    window.notula.asr.downloadLocalModel({ modelId: 'diarization-en' }).catch(() =>
      showToast({ id: 'diarization-download', kind: 'error', title: 'Couldn’t start the model download. Try again.' })
    )
  }

  return (
    <section className={`nt-notice${leaving ? ' is-leaving' : ''}`} aria-labelledby="nt-notice-title">
      <div className="nt-notice__head">
        <span className="nt-notice__glyph">
          <IconSpeakers />
        </span>
        <h2 className="nt-notice__title" id="nt-notice-title">
          {S.noticeTitle()}
        </h2>
      </div>
      <button type="button" className="n-icon-btn n-icon-btn--sm nt-notice__close" aria-label={S.noticeClose()} onClick={dismiss}>
        <IconClose />
      </button>
      <p className="nt-notice__body">{S.noticeBody(!isMac)}</p>
      <div className="nt-notice__actions">
        {modelMissing && diarization ? (
          <button type="button" className="n-btn n-btn--sm" onClick={download}>
            {S.noticeDownloadModels(Math.round(diarization.totalBytes / 1_000_000) || 33)}
          </button>
        ) : null}
        <LanguageMenuButton label={S.noticeCopyForParticipants()} onPick={(l) => void copyParticipantNotice(l)} />
        {prefs['consent.enabled'] ? <LanguageMenuButton label={S.noticeAddToChatNotice()} onPick={(l) => void addChatNoticeLine(l)} /> : null}
        <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => navigateToSettings('speaker-tags')}>
          {S.noticeSpeakerSettings()}
        </button>
        <span className="nt-notice__spacer" />
        <button type="button" className="n-btn n-btn--sm n-btn--primary" onClick={dismiss}>
          {S.noticeGotIt()}
        </button>
      </div>
    </section>
  )
}

