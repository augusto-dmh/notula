// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Feedback: a local report the user sends themselves.
// Nothing is uploaded. Main builds the mail and issue links and writes the zip;
// this page only collects the text, the attachments' paths and the two checkboxes.
// - Three modes, each with its prompts and validations, and Notula's categories.
// - Open email / Open issue appear only when the build has their address, and are off
//   while "Nothing leaves this machine" is on. Copy and Save report always work.
// - Attachments only go into a saved report: a mail link can't carry files.
// The form text lives only in this page's memory.

import { useEffect, useId, useRef, useState, type ClipboardEvent, type JSX } from 'react'
import { parseError } from '@shared/errors'
import { FEEDBACK_CATEGORIES, FEEDBACK_LIMITS, type FeedbackMode, type FeedbackSystemInfo } from '@shared/types/feedback'
import { LOCAL_ONLY_COPY } from '@shared/types/local-only'
import { navigateToSettings } from '../../app/navigation'
import { showToast } from '../../app/toast'
import { Group, Row, Segmented, Select } from '../settings/controls'
import { IconX } from '../settings/icons'
import { usePrefs } from '../settings/prefs-store'
import './feedback.css'

const MODES: readonly { value: FeedbackMode; label: string }[] = [
  { value: 'bug', label: 'Report a bug' },
  { value: 'question', label: 'Ask a question' },
  { value: 'feature', label: 'Suggest a feature' }
]

const PROMPTS: Record<FeedbackMode, string> = {
  bug: 'What went wrong, and what did you expect to happen? If you can, list the steps that lead to it.',
  question: 'Ask anything about using Notula. Include what you’ve tried so far.',
  feature: 'What would you like Notula to do? Describe the problem it would solve for you.'
}

const MODE_LABEL: Record<FeedbackMode, string> = { bug: 'Bug', question: 'Question', feature: 'Feature' }
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif'])
const MB = 1024 * 1024

interface Attachment {
  path: string
  name: string
  bytes: number
}

const sizeLabel = (n: number): string => (n < MB ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / MB).toFixed(1)} MB`)

export function FeedbackPage(): JSX.Element {
  const prefs = usePrefs()
  const localOnly = prefs?.['privacy.localOnly'] === true
  const ids = useId()
  const fileInput = useRef<HTMLInputElement>(null)
  const [info, setInfo] = useState<FeedbackSystemInfo | null>(null)
  const [mode, setMode] = useState<FeedbackMode>('bug')
  const [category, setCategory] = useState<string>('')
  const [message, setMessage] = useState('')
  const [includeSystemInfo, setIncludeSystemInfo] = useState(true)
  const [includeLogs, setIncludeLogs] = useState(false)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'email' | 'issue' | 'save' | null>(null)
  const [thanks, setThanks] = useState<string | null>(null)

  useEffect(() => {
    void window.notula.feedback.systemInfo().then(setInfo, () => setInfo(null))
  }, [])

  const validate = (): boolean => {
    if (!message.trim()) {
      setError('Add a message')
      return false
    }
    if (mode === 'feature' && !category) {
      setError('Choose a feature category')
      return false
    }
    setError(null)
    return true
  }

  const fields = { mode, category: mode === 'question' ? null : category || null, message, includeSystemInfo }

  const addFiles = (files: FileList | File[]): void => {
    const next = [...attachments]
    const problems: string[] = []
    for (const file of Array.from(files)) {
      if (!IMAGE_TYPES.has(file.type) && !file.type.startsWith('video/')) {
        problems.push('Only images and videos can be attached.')
        continue
      }
      if (file.size > FEEDBACK_LIMITS.fileMaxBytes) {
        problems.push(`${file.name} is larger than 20 MB`)
        continue
      }
      const path = window.notula.files.pathForFile(file)
      if (!path) {
        problems.push('Save pasted screenshots as a file first, then add the file')
        continue
      }
      if (next.some((a) => a.path === path)) continue
      if (next.reduce((n, a) => n + a.bytes, 0) + file.size > FEEDBACK_LIMITS.totalMaxBytes) {
        problems.push('Attachments can add up to 40 MB in total')
        continue
      }
      next.push({ path, name: file.name, bytes: file.size })
    }
    setAttachments(next)
    if (problems.length > 0) showToast({ kind: 'error', title: [...new Set(problems)].join('. ') })
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (e.clipboardData.files.length === 0) return
    e.preventDefault()
    addFiles(e.clipboardData.files)
  }

  const open = async (target: 'email' | 'issue'): Promise<void> => {
    if (!validate()) return
    setBusy(target)
    try {
      const res = await window.notula.feedback.open({ target, ...fields })
      if (res.opened) {
        setThanks(`Thanks! Your message is ready to send in your ${target === 'email' ? 'mail app' : 'browser'}.`)
        if (res.shortened) showToast({ kind: 'info', title: 'The message was shortened', description: 'Use Save report for the full text.' })
      } else if (res.reason === 'local-only') {
        showToast({ kind: 'error', title: `${LOCAL_ONLY_COPY.blocked} Save the report instead.` })
      }
    } catch (err) {
      showToast({ kind: 'error', title: parseError(err).message || 'Couldn’t open it' })
    } finally {
      setBusy(null)
    }
  }

  const copy = async (): Promise<void> => {
    if (!validate()) return
    const lines = [`[Notula] ${MODE_LABEL[mode]}${fields.category ? `: ${fields.category}` : ''}`, '', message.trim()]
    if (includeSystemInfo && info) lines.push('', '---', `Notula ${info.appVersion}`, `Electron ${info.electronVersion}`, `${info.os} (${info.arch})`)
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      showToast({ kind: 'success', title: 'Copied' })
    } catch {
      showToast({ kind: 'error', title: 'Couldn’t copy' })
    }
  }

  const save = async (): Promise<void> => {
    if (!validate()) return
    setBusy('save')
    try {
      const res = await window.notula.feedback.saveReport({ ...fields, includeLogs, attachmentPaths: attachments.map((a) => a.path) })
      if (res.saved) showToast({ kind: 'success', title: 'Report saved' })
    } catch (err) {
      showToast({ kind: 'error', title: parseError(err).message || 'Couldn’t save the report' })
    } finally {
      setBusy(null)
    }
  }

  const clear = (): void => {
    setMessage('')
    setCategory('')
    setAttachments([])
    setThanks(null)
    setError(null)
  }

  const handoff = !!info && (info.emailAvailable || info.issuesAvailable)

  return (
    <>
      <Group title="Send feedback" description="Write it here, then copy it or save it as a report file.">
        <div className="fb-form">
          <Segmented<FeedbackMode>
            label="Feedback type"
            value={mode}
            options={MODES}
            onChange={(m) => {
              setMode(m)
              setError(null)
            }}
          />
          {mode !== 'question' ? (
            <div className="fb-field">
              <span className="fb-field__label">{mode === 'feature' ? 'Feature category' : 'Category'}</span>
              <Select<string>
                wide
                value={category}
                label={mode === 'feature' ? 'Select feature category' : 'Category'}
                options={[
                  { value: '', label: mode === 'feature' ? 'Select feature category' : 'Select a category (optional)' },
                  ...FEEDBACK_CATEGORIES.map((c) => ({ value: c, label: c }))
                ]}
                onChange={(c) => {
                  setCategory(c)
                  setError(null)
                }}
              />
            </div>
          ) : null}
          <div className="fb-field">
            <label className="fb-field__label" htmlFor={`${ids}-message`}>
              Message
            </label>
            <textarea
              id={`${ids}-message`}
              className="n-input settings-textarea fb-message"
              value={message}
              rows={6}
              maxLength={20_000}
              placeholder={PROMPTS[mode]}
              aria-invalid={error === 'Add a message' || undefined}
              onChange={(e) => {
                setMessage(e.target.value)
                setThanks(null)
                if (error) setError(null)
              }}
              onPaste={onPaste}
            />
          </div>
          {error ? (
            <p className="fb-error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="fb-attachments">
            {attachments.map((a) => (
              <span key={a.path} className="fb-chip" title={a.path}>
                <span className="fb-chip__name">{a.name}</span>
                <span className="fb-chip__size">{sizeLabel(a.bytes)}</span>
                <button
                  type="button"
                  className="fb-chip__remove"
                  aria-label="Remove attachment"
                  title="Remove attachment"
                  onClick={() => setAttachments(attachments.filter((x) => x.path !== a.path))}
                >
                  <IconX size={12} />
                </button>
              </span>
            ))}
            <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => fileInput.current?.click()}>
              Add screenshot or video
            </button>
            <input
              ref={fileInput}
              type="file"
              hidden
              multiple
              accept="image/png,image/jpeg,image/gif,video/*"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files)
                e.target.value = ''
              }}
            />
          </div>
          {attachments.length > 0 ? <p className="fb-note">Attachments go into a saved report. A mail or issue link can’t carry files.</p> : null}

          <div className="fb-checks">
            <label className="fb-check">
              <input type="checkbox" checked={includeSystemInfo} onChange={(e) => setIncludeSystemInfo(e.target.checked)} />
              <span>
                Include app and system info
                {info ? (
                  <span className="fb-check__hint">
                    Notula {info.appVersion}, Electron {info.electronVersion}, {info.os} ({info.arch})
                  </span>
                ) : null}
              </span>
            </label>
            <label className="fb-check">
              <input type="checkbox" checked={includeLogs} onChange={(e) => setIncludeLogs(e.target.checked)} />
              <span>
                Include logs
                <span className="fb-check__hint">Saved reports only. Logs are redacted and never include your notes.</span>
              </span>
            </label>
          </div>

          <div className="fb-actions">
            {info?.emailAvailable ? (
              <button type="button" className="n-btn" disabled={localOnly || busy !== null} onClick={() => void open('email')}>
                Open email
              </button>
            ) : null}
            {info?.issuesAvailable ? (
              <button type="button" className="n-btn" disabled={localOnly || busy !== null} onClick={() => void open('issue')}>
                Open issue
              </button>
            ) : null}
            <button type="button" className="n-btn" disabled={busy !== null} onClick={() => void copy()}>
              Copy
            </button>
            <button type="button" className="n-btn n-btn--primary" disabled={busy !== null} onClick={() => void save()}>
              {busy === 'save' ? 'Saving…' : 'Save report…'}
            </button>
          </div>
          {handoff && localOnly ? <p className="fb-note">{LOCAL_ONLY_COPY.blocked} Save the report instead.</p> : null}
          {info?.emailAvailable && !localOnly ? <p className="fb-note">Attach files from Save report if you need them.</p> : null}
          {thanks ? (
            <p className="fb-thanks" role="status">
              {thanks}{' '}
              <button type="button" className="fb-link" onClick={clear}>
                Clear form
              </button>
            </p>
          ) : null}
        </div>
      </Group>
      <Group title="More help">
        <Row label="Troubleshooting" hint="Fix common problems and collect diagnostic logs.">
          <button type="button" className="n-btn n-btn--sm" onClick={() => navigateToSettings('troubleshooting')}>
            Open
          </button>
        </Row>
      </Group>
      <p className="fb-footnote">Notula never sends feedback, logs or attachments anywhere by itself. You choose where the report goes.</p>
    </>
  )
}
