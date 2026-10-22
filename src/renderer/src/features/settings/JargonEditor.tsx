// SPDX-License-Identifier: Apache-2.0
// Personal jargon (limits in JARGON_LIMITS):
// at most 30 terms, each 2–50 characters and at most 6 words, no duplicates.

import { useState, type JSX } from 'react'
import { JARGON_LIMITS } from '@shared/types/settings'
import { IconX } from './icons'

/** The U8b message for a term that can't be added, or null when it can. */
export function jargonError(term: string, terms: readonly string[]): string | null {
  if (terms.length >= JARGON_LIMITS.maxTerms) return `Up to ${JARGON_LIMITS.maxTerms} terms`
  if (term.length > JARGON_LIMITS.maxChars) return `Keep terms to ${JARGON_LIMITS.maxChars} characters or fewer`
  if (term.split(/\s+/).length > JARGON_LIMITS.maxWords) return `Keep terms to ${JARGON_LIMITS.maxWords} words or fewer`
  if (term.length < JARGON_LIMITS.minChars) return `Terms need at least ${JARGON_LIMITS.minChars} characters`
  const lower = term.toLocaleLowerCase()
  if (terms.some((t) => t.toLocaleLowerCase() === lower)) return 'That term is already added'
  return null
}

export function JargonEditor({
  terms,
  onChange,
  inputId
}: {
  terms: readonly string[]
  onChange(next: string[]): void
  inputId: string
}): JSX.Element {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  function add(): void {
    const term = draft.trim().replace(/\s+/g, ' ')
    if (!term) return
    const problem = jargonError(term, terms)
    if (problem) {
      setError(problem)
      return
    }
    onChange([...terms, term])
    setDraft('')
    setError(null)
  }

  return (
    <div className="jargon">
      <input
        id={inputId}
        className="n-input jargon__input"
        value={draft}
        placeholder="Add names, jargon or acronyms"
        spellCheck={false}
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${inputId}-error` : undefined}
        onChange={(e) => {
          setDraft(e.target.value)
          if (error) setError(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add()
          }
        }}
      />
      {error ? (
        <p className="jargon__error" id={`${inputId}-error`} role="alert">
          {error}
        </p>
      ) : null}
      {terms.length ? (
        <ul className="jargon__terms" aria-label="Your terms">
          {terms.map((t) => (
            <li key={t} className="jargon__term">
              <span>{t}</span>
              <button
                type="button"
                className="jargon__remove"
                aria-label={`Remove ${t}`}
                onClick={() => onChange(terms.filter((x) => x !== t))}
              >
                <IconX size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="jargon__count">
        {terms.length} of {JARGON_LIMITS.maxTerms}
      </p>
    </div>
  )
}
