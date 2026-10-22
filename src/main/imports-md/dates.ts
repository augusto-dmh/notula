// SPDX-License-Identifier: Apache-2.0
// Dates of imported notes. Pure. Accepted: ISO dates and date-times, `Sun, 26 Jul 26`
// (the en-GB short form Notula's own header uses), `26 Jul 2026`, `Jul 26, 2026`, the yearless
// `Aug 8`, Portuguese `26 de julho de 2026`, and `dd/mm/yyyy` only when the day is over 12 or the
// locale puts the day first. Month names in English and Portuguese.
//
// A date without a time is stored at 12:00 local time, so it never moves to another day across
// time zones. A yearless date takes the latest year that puts it on or before the file's
// modified time.

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, janeiro: 0,
  feb: 1, february: 1, fev: 1, fevereiro: 1,
  mar: 2, march: 2, março: 2, marco: 2,
  apr: 3, april: 3, abr: 3, abril: 3,
  may: 4, mai: 4, maio: 4,
  jun: 5, june: 5, junho: 5,
  jul: 6, july: 6, julho: 6,
  aug: 7, august: 7, ago: 7, agosto: 7,
  sep: 8, sept: 8, september: 8, set: 8, setembro: 8,
  oct: 9, october: 9, out: 9, outubro: 9,
  nov: 10, november: 10, novembro: 10,
  dec: 11, december: 11, dez: 11, dezembro: 11
}

const WEEKDAY = /^(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|seg|ter|qua|qui|sex|sáb|sab|dom)[a-zçáéíóú-]*\.?,?\s+/i

function month(name: string): number | null {
  const m = MONTHS[name.toLowerCase().replace(/\.$/, '')]
  return m === undefined ? null : m
}

/** Local noon of a calendar date; null when the day doesn't exist. */
function noon(y: number, m: number, d: number): Date | null {
  if (!(y >= 1970 && y <= 2200) || m < 0 || m > 11 || d < 1 || d > 31) return null
  const out = new Date(y, m, d, 12, 0, 0, 0)
  return out.getMonth() === m && out.getDate() === d ? out : null
}

/** The latest year that puts month/day on or before `ref`. */
function yearless(m: number, d: number, ref: number): Date | null {
  const refYear = new Date(ref).getFullYear()
  for (const y of [refYear, refYear - 1]) {
    const out = noon(y, m, d)
    if (out && out.getTime() <= ref + 12 * 3_600_000) return out
  }
  return noon(refYear - 1, m, d)
}

function year2(y: string): number {
  const n = Number(y)
  return y.length === 2 ? 2000 + n : n
}

export interface DateOpts {
  /** The file's modified time (epoch ms), for yearless dates. */
  refMs: number
  /** The OS locale puts the day first (`dd/mm`). */
  dayFirst: boolean
}

/** A date written in text, or null (also for `unknown (…)`). */
export function parseDateText(raw: string, opts: DateOpts): Date | null {
  let s = raw.trim().replace(/\s+/g, ' ')
  if (!s || /^unknown\b/i.test(s)) return null
  s = s.replace(/^["']|["']$/g, '')

  // ISO date or date-time.
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (m) return noon(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(s)
  if (m) {
    if (m[7]) {
      const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}${m[7].length === 5 ? `${m[7].slice(0, 3)}:${m[7].slice(3)}` : m[7]}`)
      return Number.isNaN(t) ? null : new Date(t)
    }
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0))
    return Number.isNaN(d.getTime()) ? null : d
  }

  s = s.replace(WEEKDAY, '')
  // `26 Jul 26`, `26 Jul 2026`, `26 de julho de 2026`, `26 Jul`
  m = /^(\d{1,2})(?:\s+de)?\s+([A-Za-zçÇ.]+)(?:,?\s+(?:de\s+)?(\d{4}|\d{2}))?$/.exec(s)
  if (m) {
    const mo = month(m[2]!)
    if (mo === null) return null
    return m[3] ? noon(year2(m[3]), mo, Number(m[1])) : yearless(mo, Number(m[1]), opts.refMs)
  }
  // `Jul 26, 2026`, `Jul 26 2026`, `Aug 8`
  m = /^([A-Za-zçÇ.]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/.exec(s)
  if (m) {
    const mo = month(m[1]!)
    if (mo === null) return null
    return m[3] ? noon(Number(m[3]), mo, Number(m[2])) : yearless(mo, Number(m[2]), opts.refMs)
  }
  // `dd/mm/yyyy` only when unambiguous or the locale is day-first.
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(s)
  if (m) {
    const a = Number(m[1])
    const b = Number(m[2])
    if (a > 12 || opts.dayFirst) return noon(Number(m[3]), b - 1, a)
    return null
  }
  return null
}

/** A leading `YYYY-MM-DD` in a file name (daily notes). */
export function dateFromFileName(name: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(name)
  return m ? noon(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}

/** True when the OS locale writes the day before the month. */
export function localeDayFirst(): boolean {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'numeric', year: 'numeric' }).formatToParts(new Date(2026, 0, 31))
    const di = parts.findIndex((p) => p.type === 'day')
    const mi = parts.findIndex((p) => p.type === 'month')
    return di >= 0 && mi >= 0 && di < mi
  } catch {
    return false
  }
}
