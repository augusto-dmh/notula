// SPDX-License-Identifier: Apache-2.0
// The hand-off text of a follow-up draft:
// placeholders, the plain-text body, the RFC 6068 `mailto:` URL, and the clipboard HTML.

import { marked } from 'marked'

const PLACEHOLDER = /<placeholder(\s+type\s*=\s*"attention")?\s*>([\s\S]*?)<\/placeholder>/gi

/** True when a placeholder without `type="attention"` is left: it blocks the hand-off. */
export function hasBlockingPlaceholder(body: string): boolean {
  for (const m of body.matchAll(PLACEHOLDER)) if (!m[1]) return true
  return false
}

/** Attention placeholders unwrapped to their text; any other placeholder kept as `[text]`. */
export function unwrapPlaceholders(body: string): string {
  return body.replace(PLACEHOLDER, (_m, attention: string | undefined, text: string) => (attention ? text : `[${text}]`))
}

/** Markdown → plain text: paragraphs separated by a blank line, list items as `- ` lines. */
export function markdownToPlain(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  for (const raw of lines) {
    let line = raw.replace(/\s+$/, '')
    const list = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line)
    if (list) line = `- ${list[1] ?? ''}`
    line = line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s{0,3}>\s?/, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => (text === url ? url : `${text} (${url})`))
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?=[^*\w]|$)/g, '$1$2')
      .replace(/`([^`]+)`/g, '$1')
    out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** The body as HTML for a rich clipboard flavor. */
export function markdownToHtml(md: string): string {
  return marked.parse(md, { async: false, gfm: true, breaks: false }) as string
}

/** RFC 6068: every value percent-encoded; addresses comma-separated (an `@` may stay as it is). */
export function mailtoUrl(d: { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string | null }): string {
  const enc = (s: string): string => encodeURIComponent(s).replace(/%40/g, '@')
  const params: string[] = []
  if (d.cc.length) params.push(`cc=${d.cc.map(enc).join(',')}`)
  if (d.bcc.length) params.push(`bcc=${d.bcc.map(enc).join(',')}`)
  if (d.subject) params.push(`subject=${encodeURIComponent(d.subject)}`)
  if (d.body) params.push(`body=${encodeURIComponent(d.body.replace(/\n/g, '\r\n'))}`)
  return `mailto:${d.to.map(enc).join(',')}${params.length ? `?${params.join('&')}` : ''}`
}

const EMAIL = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[^\s@<>(),;:"[\]]+$/

/** The valid addresses of a model's or the user's list, trimmed, de-duplicated. */
export function validAddresses(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of v) {
    if (typeof x !== 'string') continue
    const a = x.trim().replace(/^.*<([^>]+)>\s*$/, '$1').trim()
    if (!EMAIL.test(a) || a.length > 320 || seen.has(a.toLowerCase())) continue
    seen.add(a.toLowerCase())
    out.push(a)
  }
  return out
}
