// SPDX-License-Identifier: Apache-2.0
// RFC 2822 / MIME for Gmail drafts: From, To, Cc, Bcc,
// Subject (RFC 2047 when not ASCII), MIME-Version, and multipart/alternative with a text/plain and a
// text/html part, both UTF-8 and quoted-printable. Header values never carry CR or LF.

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
