// SPDX-License-Identifier: Apache-2.0
// The passive reader's line shapes and the pure helpers that read them: which OS app ids count
// as browsers, a `sessions` line → MediaSession[], and what a tab name and a window title say
// (site, audio marker, InPrivate/Incognito, profile). No Electron and type-only imports, so the
// dev harness (scripts/dev/media-replay.mjs) loads it directly.

import type { BrowserId, MediaSession, PlaybackStatus } from '../../shared/types/sources'

/**
 * Measured browser app ids only. Brave, Firefox and Arc join this
 * table after a measurement, not before. Media apps and PWAs with their own ids are ignored.
 */
export const BROWSER_APPS: Readonly<Record<string, BrowserId>> = { MSEdge: 'edge', Chrome: 'chrome' }

/** The process name the tab-strip read looks for. */
export const BROWSER_PROCESS: Readonly<Record<BrowserId, string>> = { edge: 'msedge', chrome: 'chrome', brave: 'brave' }

/** One session as `session.ps1` prints it (`ev: 'sessions'`). */
export interface ReaderSession {
  app: string
  cur: boolean
  title: string
  artist: string
  album: string
  status: string
  posMs: number
  endMs: number
  rate: number | null
  /** Epoch ms of the OS timeline sample. */
  updated: number
}

/** One window's match of a `locate` command. */
export interface ReaderTabMatch {
  /** The window title (profile and InPrivate markers live here). */
  window: string
  tab: string
  sel: boolean
  /** The address bar, only when asked and the matched tab is the selected one. */
  addr: string | null
}

function str(v: unknown, max = 2_000): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function status(s: string): PlaybackStatus {
  if (s === 'Playing') return 'playing'
  if (s === 'Paused') return 'paused'
  return 'stopped'
}

/**
 * What Chrome publishes for an Incognito tab instead of its metadata (measured on
 * Chrome 155, English UI, no artist): nothing to identify or stamp, and a private window. Other
 * UI languages are unmeasured.
 */
const WITHHELD_TITLES: ReadonlySet<string> = new Set(['A site is playing media'])

/**
 * A `sessions` record → the measured browsers' sessions. A session whose metadata the browser
 * withheld (an Incognito tab) is dropped, so that browser's next session can stand for it. `now` stands in for a missing or
 * implausible OS timestamp (more than a day away). Null for any other record.
 */
export function sessionsFromRecord(rec: Record<string, unknown>, now: number): MediaSession[] | null {
  if (rec['ev'] !== 'sessions' || !Array.isArray(rec['sessions'])) return null
  const out: MediaSession[] = []
  const seen = new Set<BrowserId>()
  // The current session first, so a second session of one browser never wins over it.
  const raw = (rec['sessions'] as unknown[]).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
  raw.sort((a, b) => Number(b['cur'] === true) - Number(a['cur'] === true))
  for (const s of raw) {
    const appId = str(s['app'], 200)
    const browser = BROWSER_APPS[appId]
    if (!browser || seen.has(browser)) continue
    if (WITHHELD_TITLES.has(str(s['title']).trim()) && !str(s['artist']).trim()) continue
    seen.add(browser)
    const st = str(s['status'], 40)
    // A closing session reports position 0, end 0 (which would read as live) and no timeline
    // time (seen at page start, soak-2026-10.jsonl): its timeline is unknown.
    const closed = st === 'Closed'
    const updated = closed ? null : num(s['updated'])
    const end = closed ? null : num(s['endMs'])
    const rate = num(s['rate'])
    out.push({
      appId,
      browser,
      title: str(s['title']).trim(),
      artist: str(s['artist']).trim() || null,
      album: str(s['album']).trim() || null,
      status: status(st),
      positionMs: closed ? null : num(s['posMs']),
      endMs: end,
      rate: rate !== null && rate > 0 && rate <= 16 ? rate : 1,
      lastUpdatedAt: updated !== null && Math.abs(updated - now) < 86_400_000 ? updated : now
    })
  }
  return out
}

/** A `locate` record → its matches. Null for any other record. */
export function matchesFromRecord(rec: Record<string, unknown>): { id: number; matches: ReaderTabMatch[] } | null {
  if (rec['ev'] !== 'locate' || typeof rec['id'] !== 'number') return null
  const list = Array.isArray(rec['matches']) ? (rec['matches'] as unknown[]) : []
  const matches: ReaderTabMatch[] = []
  for (const m of list.slice(0, 8)) {
    if (!m || typeof m !== 'object') continue
    const o = m as Record<string, unknown>
    const addr = str(o['addr'], 4096)
    matches.push({ window: str(o['window'], 1_000), tab: str(o['tab'], 2_000), sel: o['sel'] === true, addr: addr || null })
  }
  return { id: rec['id'], matches }
}

// ---------- tab names ----------

/**
 * Edge's tab-name state suffixes: ` - Audio playing`, ` - Muted`,
 * ` - Discarded`, ` - Memory usage - 418 MB`, plus the pt-BR wording. Localized, so the audio
 * marker is a fallback signal: a tab whose name starts with the playback title still matches
 * without it.
 */
const AUDIO_MARKERS = /^(audio playing|playing audio|reproduzindo áudio|áudio em reprodução|reproduciendo audio)$/i
const STATE_SUFFIXES =
  /^(audio playing|playing audio|reproduzindo áudio|áudio em reprodução|reproduciendo audio|muted|tab muted|sem áudio|silenciad[oa]|discarded|descartad[oa]|sleeping|suspens[oa]|memory usage|uso de memória|\d[\d.,]*\s*[mgk]b)$/i

/** A playback title's tab: the site label after the title and the audio marker. */
export interface TabFacts {
  /** `YouTube`, `Vimeo`, a course community's name, or null when the name carries nothing after the title. */
  siteLabel: string | null
  audio: boolean
}

/** Null when the tab name doesn't start with the title (after a leading `(N) ` count). */
export function tabFacts(tabName: string, title: string): TabFacts | null {
  const name = tabName.replace(/^\(\d+\+?\)\s+/, '')
  const t = title.replace(/^\(\d+\+?\)\s+/, '').trim()
  if (!t || !name.toLowerCase().startsWith(t.toLowerCase())) return null
  const rest = name.slice(t.length)
  const parts = rest
    .split(/\s+[-–—|]\s+/)
    .map((p) => p.trim())
    .filter(Boolean)
  const audio = parts.some((p) => AUDIO_MARKERS.test(p))
  const meaningful = parts.filter((p) => !STATE_SUFFIXES.test(p))
  return { siteLabel: meaningful[0] ?? null, audio }
}

/** Site labels Notula knows → hosts. Anything else is kept as the label. */
const SITE_HOSTS: Readonly<Record<string, string>> = {
  youtube: 'youtube.com',
  vimeo: 'vimeo.com',
  udemy: 'udemy.com',
  coursera: 'coursera.org',
  hotmart: 'hotmart.com',
  kiwify: 'kiwify.com.br',
  memberkit: 'memberkit.com.br'
}

export function siteFromLabel(label: string | null): string | null {
  if (!label) return null
  const l = label.trim().toLowerCase()
  return SITE_HOSTS[l] ?? (l.slice(0, 120) || null)
}

/** YouTube-like sites: where the yt-dlp search step applies and course time-correlation doesn't. */
export function isVideoSite(site: string | null): boolean {
  return site === 'youtube.com' || site === 'vimeo.com'
}

// ---------- window titles ----------

const BROWSER_SUFFIX: Readonly<Record<BrowserId, RegExp>> = {
  // Edge puts a zero-width space in its name.
  edge: /\s+-\s+Microsoft​?\s*Edge(?:\s+(?:Beta|Dev|Canary))?$/i,
  chrome: /\s+-\s+Google Chrome(?:\s+(?:Beta|Dev|Canary))?$/i,
  brave: /\s+-\s+Brave$/i
}
const PRIVATE_MARKERS = /\[InPrivate\]|\bInPrivate\b|\(Incognito\)|\bIncognito\b|\bAnônima\b|\bAnónim[oa]\b|\bIncógnito\b/i

/**
 * Browsers whose normal and private window titles were measured. A normal-looking title of any
 * other browser is still `unknown`: Chrome's Incognito and profile shapes are unmeasured.
 * Measured 2026-10-20 (Chrome 155, a throwaway profile): an Incognito window's title is
 * `<page> - Google Chrome`, the same shape as a normal window, so Chrome stays unmeasured.
 */
const MEASURED_WINDOWS: ReadonlySet<BrowserId> = new Set<BrowserId>(['edge'])

export interface WindowFacts {
  /**
   * True on an InPrivate/Incognito marker. False only when the title has a measured browser's
   * normal shape and no marker. Anything else is `unknown`.
   */
  privateWindow: boolean | 'unknown'
  /** The profile segment of the title (Edge shows `- Personal -`), else null. */
  profileName: string | null
}

export function windowFacts(browser: BrowserId, windowTitle: string | null): WindowFacts {
  if (!windowTitle) return { privateWindow: 'unknown', profileName: null }
  const suffix = BROWSER_SUFFIX[browser]
  const m = suffix.exec(windowTitle)
  if (PRIVATE_MARKERS.test(windowTitle.slice(Math.max(0, windowTitle.length - (m ? m[0].length + 40 : 60))))) {
    return { privateWindow: true, profileName: null }
  }
  if (!m || !MEASURED_WINDOWS.has(browser)) return { privateWindow: 'unknown', profileName: null }
  const head = windowTitle.slice(0, m.index)
  const segs = head.split(/\s+-\s+/)
  const profileName = segs.length >= 2 ? (segs[segs.length - 1] ?? '').trim() || null : null
  return { privateWindow: false, profileName }
}
