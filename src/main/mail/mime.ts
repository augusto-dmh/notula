// SPDX-License-Identifier: Apache-2.0
// RFC 2822 / MIME for Gmail drafts: From, To, Cc, Bcc,
// Subject (RFC 2047 when not ASCII), MIME-Version, and multipart/alternative with a text/plain and a
// text/html part, both UTF-8 and quoted-printable. Header values never carry CR or LF.
// A forward reads the original raw message and adds its attachments as they were encoded.

export interface MimeMessage {
  from: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  text: string
  html: string
  inReplyTo?: string | null
  references?: string | null
}

const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ').trim()

function encodeWord(s: string): string {
  const v = oneLine(s)
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7E]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`
}

/** Quoted-printable (RFC 2045 section 6.7) over UTF-8, CRLF line breaks, soft breaks at 76. */
export function quotedPrintable(input: string): string {
  const lines = input.replace(/\r\n|\r|\n/g, '\n').split('\n')
  return lines
    .map((line) => {
      const bytes = Buffer.from(line, 'utf8')
      let out = ''
      let len = 0
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i] ?? 0
        const last = i === bytes.length - 1
        let tok: string
        if ((b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last)) tok = String.fromCharCode(b)
        else tok = `=${b.toString(16).toUpperCase().padStart(2, '0')}`
        if (len + tok.length > 75) {
          out += '=\r\n'
          len = 0
        }
        out += tok
        len += tok.length
      }
      return out
    })
    .join('\r\n')
}

/** The raw message, base64url-encoded for `message.raw`. */
export function buildRaw(m: MimeMessage, boundary: string): string {
  const head: string[] = [`From: ${oneLine(m.from)}`]
  if (m.to.length) head.push(`To: ${m.to.map(oneLine).join(', ')}`)
  if (m.cc.length) head.push(`Cc: ${m.cc.map(oneLine).join(', ')}`)
  if (m.bcc.length) head.push(`Bcc: ${m.bcc.map(oneLine).join(', ')}`)
  head.push(`Subject: ${encodeWord(m.subject)}`)
  if (m.inReplyTo) head.push(`In-Reply-To: ${oneLine(m.inReplyTo)}`)
  if (m.references) head.push(`References: ${oneLine(m.references)}`)
  head.push('MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`)
  const part = (type: string, body: string): string =>
    [`--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, 'Content-Transfer-Encoding: quoted-printable', '', quotedPrintable(body)].join('\r\n')
  const raw = [head.join('\r\n'), '', part('text/plain', m.text), part('text/html', m.html), `--${boundary}--`, ''].join('\r\n')
  return Buffer.from(raw, 'utf8').toString('base64url')
}

/** Plain text as minimal HTML paragraphs (for chat `email` blocks, whose body is text). */
export function textToHtml(text: string): string {
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n')
}

/** A message's own text, without the quoted earlier messages. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  for (const l of lines) {
    if (/^\s*>/.test(l)) continue
    if (/^On .{4,200}wrote:\s*$/.test(l.trim()) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l.trim()) || /^From: .+/.test(l) && out.length > 2) break
    out.push(l)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

// ---------- forwarding ----------

/** The size a forward may reach with its attachments. */
export const FORWARD_MAX_BYTES = 25 * 1024 * 1024

/** What a forward takes from the original message. Attachments stay as their encoded MIME parts. */
export interface ForwardSource {
  from: string
  date: string
  subject: string
  to: string
  text: string
  html: string | null
  /** Each attachment part as it appeared, headers and encoded body (binary-safe latin1). */
  attachments: string[]
}

type Headers = Record<string, string>

function splitPart(raw: string): { head: string; body: string } {
  const m = /\r?\n\r?\n/.exec(raw)
  return m ? { head: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) } : { head: raw, body: '' }
}

/** Header names lower-cased, folded lines joined; the first of a repeated header wins. */
function parseHeaders(head: string): Headers {
  const out: Headers = {}
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const name = line.slice(0, i).trim().toLowerCase()
    if (!(name in out)) out[name] = line.slice(i + 1).trim()
  }
  return out
}

function param(value: string, name: string): string | null {
  const m = new RegExp(`;\\s*${name}\\*?=\\s*("([^"]*)"|[^;\\s]+)`, 'i').exec(value)
  if (!m) return null
  return (m[2] ?? m[1] ?? '').replace(/^utf-8''/i, '')
}

function decodeBody(body: string, encoding: string): Buffer {
  const e = encoding.toLowerCase()
  if (e === 'base64') return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
  if (e === 'quoted-printable') {
    const s = body.replace(/=\r?\n/g, '')
    const bytes: number[] = []
    for (let i = 0; i < s.length; i++) {
      const hex = s[i] === '=' ? s.slice(i + 1, i + 3) : ''
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16))
        i += 2
      } else bytes.push(s.charCodeAt(i) & 0xff)
    }
    return Buffer.from(bytes)
  }
  return Buffer.from(body, 'latin1')
}

function decodeText(bytes: Buffer, charset: string | null): string {
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes)
  } catch {
    return bytes.toString('utf8')
  }
}

/** RFC 2047 encoded words in a header value, decoded for display. */
function decodeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, charset: string, kind: string, text: string) => {
    const bytes = kind.toUpperCase() === 'B' ? Buffer.from(text, 'base64') : decodeBody(text.replace(/_/g, ' '), 'quoted-printable')
    return decodeText(bytes, charset)
  })
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A raw RFC 822 message (as latin1, so every byte survives) read for forwarding. */
export function parseForwardSource(raw: string): ForwardSource {
  const { head, body } = splitPart(raw)
  const h = parseHeaders(head)
  const out: ForwardSource = { from: decodeWords(h['from'] ?? ''), date: h['date'] ?? '', subject: decodeWords(h['subject'] ?? ''), to: decodeWords(h['to'] ?? ''), text: '', html: null, attachments: [] }
  const walk = (headers: Headers, content: string, whole: string | null): void => {
    const type = (headers['content-type'] ?? 'text/plain').toLowerCase()
    const disposition = (headers['content-disposition'] ?? '').toLowerCase()
    if (type.startsWith('multipart/')) {
      const boundary = param(headers['content-type'] ?? '', 'boundary')
      if (!boundary) return
      const pieces = content.split(new RegExp(`(?:^|\\r?\\n)--${escapeRegExp(boundary)}(?:--)?[ \\t]*(?:\\r?\\n|$)`))
      // Before the first boundary is the preamble; after the closing one, the epilogue.
      for (const piece of pieces.slice(1, -1)) {
        if (!piece.trim()) continue
        const p = splitPart(piece)
        walk(parseHeaders(p.head), p.body, piece)
      }
      return
    }
    const named = !!(param(headers['content-disposition'] ?? '', 'filename') ?? param(headers['content-type'] ?? '', 'name'))
    const text = type.startsWith('text/plain') || type.startsWith('text/html')
    if (whole !== null && (disposition.startsWith('attachment') || (named && !disposition.startsWith('inline')) || !text)) {
      out.attachments.push(whole.replace(/\r?\n/g, '\r\n').replace(/(\r\n)+$/, ''))
      return
    }
    const decoded = decodeText(decodeBody(content, headers['content-transfer-encoding'] ?? ''), param(headers['content-type'] ?? '', 'charset'))
    if (type.startsWith('text/html')) out.html ??= decoded
    else if (!out.text) out.text = decoded
  }
  walk(h, body, null)
  if (!out.text && out.html) {
    out.text = out.html
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim()
  }
  return out
}

const SEPARATOR = '-------- Forwarded email --------'
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** "Fwd: " in front of a subject, once. */
export function forwardSubject(subject: string): string {
  return /^fwd:/i.test(subject.trim()) ? subject.trim() : `Fwd: ${subject.trim()}`
}

/**
 * The forward as a raw message, base64url-encoded: the user's text, a separator, the
 * original's From / Date / Subject / To and its body, then its attachments when asked. Null when
 * it would be larger than FORWARD_MAX_BYTES.
 */
export function buildForwardRaw(m: MimeMessage, original: ForwardSource, includeAttachments: boolean, boundary: string): string | null {
  const head: string[] = [`From: ${oneLine(m.from)}`]
  if (m.to.length) head.push(`To: ${m.to.map(oneLine).join(', ')}`)
  if (m.cc.length) head.push(`Cc: ${m.cc.map(oneLine).join(', ')}`)
  if (m.bcc.length) head.push(`Bcc: ${m.bcc.map(oneLine).join(', ')}`)
  head.push(`Subject: ${encodeWord(m.subject)}`, 'MIME-Version: 1.0')
  const block = [SEPARATOR, `From: ${original.from}`, `Date: ${original.date}`, `Subject: ${original.subject}`, `To: ${original.to}`]
  const text = `${m.text}\n\n${block.join('\n')}\n\n${original.text}`
  const inner = original.html ? (/<body[^>]*>([\s\S]*)<\/body>/i.exec(original.html)?.[1] ?? original.html) : textToHtml(original.text)
  const html = `${m.html}\n<br>\n<div>${block.map(esc).join('<br>')}</div>\n<br>\n${inner}`
  const alt = `${boundary}-alt`
  const part = (type: string, body: string): string =>
    [`--${alt}`, `Content-Type: ${type}; charset=UTF-8`, 'Content-Transfer-Encoding: quoted-printable', '', quotedPrintable(body)].join('\r\n')
  const alternative = [part('text/plain', text), part('text/html', html), `--${alt}--`].join('\r\n')
  const attachments = includeAttachments ? original.attachments : []
  const lines = attachments.length
    ? [
        ...head,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        `Content-Type: multipart/alternative; boundary="${alt}"`,
        '',
        alternative,
        ...attachments.flatMap((a) => [`--${boundary}`, a]),
        `--${boundary}--`,
        ''
      ]
    : [...head, `Content-Type: multipart/alternative; boundary="${alt}"`, '', alternative, '']
  // Notula's own lines are ASCII (quoted-printable, encoded words); the attachments keep their bytes.
  const bytes = Buffer.from(lines.join('\r\n'), 'latin1')
  if (bytes.length > FORWARD_MAX_BYTES) return null
  return bytes.toString('base64url')
}
