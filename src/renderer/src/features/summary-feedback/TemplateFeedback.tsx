// SPDX-License-Identifier: Apache-2.0
// "Your feedback" in the template editor: the ratings and
// comments on notes made with this template, newest first, with the count of each thumb, and
// "Suggest edits from my feedback" (from 3 comments): one `template-feedback` call, then a
// before/after preview that changes nothing until Apply. A built-in template gets a user copy.

import { useEffect, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import { SUMMARY_FEEDBACK_LIMITS, type SummaryFeedbackList, type TemplateEditSuggestion } from '@shared/types/summary-feedback'
import { navigate } from '../../app/navigation'
import { showToast } from '../../app/toast'
import { usePrefs } from '../settings/prefs-store'

function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '')
    return h === 'localhost' || h === '::1' || /^127\./.test(h)
  } catch {
    return false
  }
}

export function TemplateFeedbackSectionView({ templateSlug }: { templateSlug: string }): JSX.Element | null {
  const prefs = usePrefs()
  const [list, setList] = useState<SummaryFeedbackList | null>(null)
  const [suggesting, setSuggesting] = useState(false)
  const [suggestion, setSuggestion] = useState<Extract<TemplateEditSuggestion, { ok: true }> | null>(null)
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.notula.summaryFeedback
      .list({ templateSlug })
      .then((l) => {
        if (!cancelled) setList(l)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [templateSlug])

  if (!list || list.items.length === 0) return null

  const comments = list.items.filter((i) => i.comment).length
  const blocked = prefs?.['privacy.localOnly'] === true && !(prefs['llm.provider'] === 'local' && isLoopback(prefs['llm.local.baseUrl']))
  const canSuggest = comments >= SUMMARY_FEEDBACK_LIMITS.suggestMinComments && !blocked
  const reason = blocked
    ? 'Off while Nothing leaves this machine is on, unless you use a local AI model.'
    : comments < SUMMARY_FEEDBACK_LIMITS.suggestMinComments
      ? `Available once ${SUMMARY_FEEDBACK_LIMITS.suggestMinComments} ratings have comments.`
      : null

  const suggest = async (): Promise<void> => {
    setSuggesting(true)
    try {
      const r = await window.notula.summaryFeedback.suggestTemplateEdits({ templateSlug })
      if (r.ok) setSuggestion(r)
      else showToast({ title: 'No suggestions', description: r.error, kind: 'info' })
    } catch (err) {
      showToast({ title: "Couldn't get suggestions", description: parseError(err).message, kind: 'error' })
    } finally {
      setSuggesting(false)
    }
  }

  const apply = async (): Promise<void> => {
    if (!suggestion) return
    setApplying(true)
    try {
      const template = (await window.notula.templates.list()).find((t) => t.id === templateSlug)
      if (!template) throw new Error('This template no longer exists.')
      const sections = template.sections.map((s) => {
        const change = suggestion.sections.find((c) => c.heading === s.heading)
        return change ? { ...s, section_hint: change.after } : s
      })
      if (template.is_builtin) {
        await window.notula.templates.create({
          title: `${template.title} (my version)`,
          description: template.description,
          sections,
          category: template.category,
          icon: template.icon,
          copied_from: template.id
        })
        showToast({ title: 'Saved as your own copy', description: 'Built-in templates stay as they are.', kind: 'success' })
      } else {
        await window.notula.templates.update({ id: template.id, patch: { sections } })
        showToast({ title: 'Template updated', kind: 'success' })
      }
      setSuggestion(null)
    } catch (err) {
      showToast({ title: "Couldn't apply the edits", description: parseError(err).message, kind: 'error' })
    } finally {
      setApplying(false)
    }
  }

  return (
    <section className="sf-tpl" aria-label="Your feedback">
      <header className="sf-tpl__header">
        <h3 className="sf-tpl__title">Your feedback</h3>
        <span className="sf-tpl__counts">
          {list.counts.positive} good · {list.counts.negative} not good
        </span>
      </header>
      <ul className="sf-tpl__list">
        {list.items.slice(0, 20).map((i) => (
          <li key={i.id} className="sf-tpl__item">
            <span className={`sf-tpl__dir sf-tpl__dir--${i.direction ?? 'none'}`}>{i.direction === 'positive' ? 'Good' : 'Not good'}</span>
            <div className="sf-tpl__body">
              {i.comment ? <p className="sf-tpl__comment">{i.comment}</p> : null}
              <button type="button" className="sf-tpl__note" onClick={() => navigate(`/meeting/${i.document_id}`)}>
                {i.note_title || 'New note'} · {new Date(i.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {suggestion ? (
        <div className="sf-tpl__preview">
          {suggestion.sections.map((s) => (
            <div key={s.heading} className="sf-tpl__change">
              <p className="sf-tpl__heading">{s.heading}</p>
              <p className="sf-tpl__before">{s.before || 'No description'}</p>
              <p className="sf-tpl__after">{s.after}</p>
            </div>
          ))}
          <div className="sf-tpl__actions">
            <button type="button" className="n-btn n-btn--sm n-btn--ghost" disabled={applying} onClick={() => setSuggestion(null)}>
              Discard
            </button>
            <button type="button" className="n-btn n-btn--sm n-btn--primary" disabled={applying} onClick={() => void apply()}>
              Apply
            </button>
          </div>
        </div>
      ) : (
        <div className="sf-tpl__suggest">
          <button type="button" className="n-btn n-btn--sm" disabled={!canSuggest || suggesting} onClick={() => void suggest()}>
            {suggesting ? <span className="n-spinner" aria-hidden="true" /> : null}
            Suggest edits from my feedback
          </button>
          {reason ? <span className="sf-tpl__reason">{reason}</span> : null}
        </div>
      )}
    </section>
  )
}
