// SPDX-License-Identifier: Apache-2.0
// YouTube, main world, document_start. Runs in the page's own JavaScript world so it
// can see what the player already has: the player response (title, channel, length, caption
// tracks), chapter markers, and the caption files the player fetches itself.
//
// - It wraps `fetch` and `XMLHttpRequest` for `/api/timedtext` URLs only, keeping a copy of the
//   body the player received. It makes no request of its own except the one below.
// - On the isolated script's request, and only when Notula's policy allows it, it asks YouTube for
//   that video's caption track in another language, the same way the player does.
// - It talks to the isolated script with window.postMessage on a channel name chosen at each page
//   load. The name is no secret (the page sees the announcement), so the isolated side treats
//   whatever arrives on it as untrusted page data. It posts no page data except what the isolated
//   script asks for, plus the caption files the player fetched.
// - It is registered only after the first-run explanation is accepted (background/sites.ts).

type Json = Record<string, unknown>

;(() => {
  const w = window as unknown as Json & { __notulaMain?: boolean }
  if (w.__notulaMain) return
  w.__notulaMain = true

  const channel = `notula-yt-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  const BODY_MAX = 8 * 1024 * 1024
  const URLS_MAX = 10
  const origFetch = window.fetch.bind(window)
  const captured: string[] = []

  const post = (msg: Json): void => window.postMessage({ channel, dir: 'out', ...msg }, location.origin)
  const announce = (): void => window.postMessage({ __notula: 'ready', channel }, location.origin)

  const isTimedtext = (url: string): boolean => {
    try {
      const u = new URL(url, location.href)
      return u.origin === location.origin && u.pathname === '/api/timedtext'
    } catch {
      return false
    }
  }

  const keep = (url: string, body: string): void => {
    const abs = new URL(url, location.href).toString()
    captured.push(abs)
    if (captured.length > URLS_MAX) captured.shift()
    if (body && body.length <= BODY_MAX) post({ kind: 'timedtext', url: abs, body })
  }

  // ---------- the player's own caption requests ----------

  window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const p = origFetch(input, init)
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (isTimedtext(url)) {
        p.then((r) => r.clone().text())
          .then((body) => keep(url, body))
          .catch(() => undefined)
      }
    } catch {
      // Never break the page's request.
    }
    return p
  }

  const xhrOpen = XMLHttpRequest.prototype.open
  const xhrUrls = new WeakMap<XMLHttpRequest, string>()
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
    try {
      const url = String(args[1])
      if (isTimedtext(url)) {
        xhrUrls.set(this, url)
        this.addEventListener('load', () => {
          try {
            const t = this.responseType
            const body = t === '' || t === 'text' ? this.responseText : t === 'json' ? JSON.stringify(this.response) : ''
            keep(url, body)
          } catch {
            // Unreadable response type; skip it.
          }
        })
      }
    } catch {
      // Never break the page's request.
    }
    return (xhrOpen as (...a: unknown[]) => void).apply(this, args)
  } as typeof XMLHttpRequest.prototype.open

  // ---------- player data ----------

  const get = (o: unknown, ...path: (string | number)[]): unknown => {
    let cur = o
    for (const k of path) {
      if (typeof cur !== 'object' || cur === null) return undefined
      cur = (cur as Json)[k as string]
    }
    return cur
  }
  const text = (v: unknown): string | null =>
    typeof v === 'string' ? v : typeof get(v, 'simpleText') === 'string' ? (get(v, 'simpleText') as string) : null

  let navData: unknown = null
  let navPlayer: unknown = null

  const currentId = (): string | null => {
    try {
      const u = new URL(location.href)
      const v = u.searchParams.get('v')
      if (v) return v
      return /^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})/.exec(u.pathname)?.[1] ?? null
    } catch {
      return null
    }
  }

  const playerResponse = (): Json | null => {
    const id = currentId()
    const fits = (r: unknown): r is Json => !!r && get(r, 'videoDetails', 'videoId') === id
    try {
      const el = document.getElementById('movie_player') as unknown as { getPlayerResponse?: () => unknown } | null
      const r = el?.getPlayerResponse?.()
      if (fits(r)) return r
    } catch {
      // The player isn't ready.
    }
    if (fits(navPlayer)) return navPlayer
    const initial = w.ytInitialPlayerResponse
    return fits(initial) ? initial : null
  }

  interface Track {
    lang: string
    name: string | null
    kind: 'asr' | 'manual'
    baseUrl: string
  }

  const tracksOf = (pr: Json): Track[] => {
    const list = get(pr, 'captions', 'playerCaptionsTracklistRenderer', 'captionTracks')
    if (!Array.isArray(list)) return []
    return list
      .map((t) => ({
        lang: String(get(t, 'languageCode') ?? ''),
        name: text(get(t, 'name')) ?? (text(get(t, 'name', 'runs', 0, 'text')) || null),
        kind: get(t, 'kind') === 'asr' ? ('asr' as const) : ('manual' as const),
        baseUrl: String(get(t, 'baseUrl') ?? '')
      }))
      .filter((t) => t.lang && t.baseUrl)
  }

  /** Chapter markers from the watch page data; field paths unverified. */
  const chaptersOf = (id: string): { start: number; title: string }[] | null => {
    const sources = [navData, w.ytInitialData]
    for (const data of sources) {
      if (!data || get(data, 'currentVideoEndpoint', 'watchEndpoint', 'videoId') !== id) continue
      const markers = get(
        data,
        'playerOverlays',
        'playerOverlayRenderer',
        'decoratedPlayerBarRenderer',
        'decoratedPlayerBarRenderer',
        'playerBar',
        'multiMarkersPlayerBarRenderer',
        'markersMap'
      )
      if (!Array.isArray(markers)) continue
      for (const m of markers) {
        const chapters = get(m, 'value', 'chapters')
        if (!Array.isArray(chapters)) continue
        const items = chapters
          .map((c) => ({
            start: Number(get(c, 'chapterRenderer', 'timeRangeStartMillis')) / 1_000,
            title: text(get(c, 'chapterRenderer', 'title')) ?? ''
          }))
          .filter((c) => Number.isFinite(c.start) && c.title)
        if (items.length) return items
      }
    }
    return null
  }

  const sendPlayer = (): void => {
    const pr = playerResponse()
    if (!pr) return
    const id = String(get(pr, 'videoDetails', 'videoId'))
    post({
      kind: 'player',
      data: {
        videoId: id,
        title: text(get(pr, 'videoDetails', 'title')),
        author: text(get(pr, 'videoDetails', 'author')),
        channelId: text(get(pr, 'videoDetails', 'channelId')),
        lengthSeconds: Number(get(pr, 'videoDetails', 'lengthSeconds')) || null,
        isLive: get(pr, 'videoDetails', 'isLive') === true,
        tracks: tracksOf(pr).map((t) => ({ lang: t.lang, name: t.name, kind: t.kind, plain: !t.baseUrl.includes('exp=xpe') })),
        chapters: chaptersOf(id),
        description: text(get(pr, 'videoDetails', 'shortDescription'))
      }
    })
  }

  // ---------- replay ----------

  const fetchBody = async (url: URL): Promise<string> => {
    if (url.origin !== location.origin) return ''
    try {
      const r = await origFetch(url.toString(), { credentials: 'same-origin' })
      return r.ok ? await r.text() : ''
    } catch {
      return ''
    }
  }

  const replay = async (lang: string, allowPlain: boolean): Promise<{ body: string | null; reason: string | null; lang: string; trackKind: string }> => {
    const pr = playerResponse()
    const id = currentId()
    const tracks = pr ? tracksOf(pr) : []
    const base = lang.toLowerCase().split('-')[0]
    const track =
      tracks.find((t) => t.lang.toLowerCase() === lang.toLowerCase() && t.kind === 'manual') ??
      tracks.find((t) => t.lang.toLowerCase() === lang.toLowerCase()) ??
      tracks.find((t) => t.lang.toLowerCase().split('-')[0] === base)
    if (!track) return { body: null, reason: 'no-track', lang, trackKind: 'manual' }
    const withToken = [...captured].reverse().find((u) => {
      const p = new URL(u)
      return p.searchParams.get('v') === id && p.searchParams.has('pot')
    })
    if (withToken) {
      const u = new URL(withToken)
      u.searchParams.set('lang', track.lang)
      u.searchParams.delete('tlang')
      if (track.kind === 'asr') u.searchParams.set('kind', 'asr')
      else u.searchParams.delete('kind')
      u.searchParams.set('fmt', 'json3')
      const body = await fetchBody(u)
      if (body.trim()) return { body, reason: null, lang: track.lang, trackKind: track.kind }
    }
    if (allowPlain && !track.baseUrl.includes('exp=xpe')) {
      const u = new URL(track.baseUrl, location.href)
      u.searchParams.set('fmt', 'json3')
      const body = await fetchBody(u)
      if (body.trim()) return { body, reason: null, lang: track.lang, trackKind: track.kind }
    }
    return { body: null, reason: withToken ? 'failed' : 'token-required', lang: track.lang, trackKind: track.kind }
  }

  // ---------- wiring ----------

  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.source !== window || typeof ev.data !== 'object' || ev.data === null) return
    const d = ev.data as Json
    if (d.__notula === 'ping') return announce()
    if (d.channel !== channel || d.dir !== 'in') return
    if (d.kind === 'player') return sendPlayer()
    if (d.kind === 'replay' && typeof d.id === 'number' && typeof d.lang === 'string' && /^[A-Za-z0-9_-]{1,35}$/.test(d.lang)) {
      const id = d.id
      void replay(d.lang, d.plain === true).then((r) => post({ kind: 'replay', id, ...r }))
    }
  })

  // YouTube is a single-page app: refresh on its navigation events and on new media.
  document.addEventListener('yt-navigate-finish', (ev: Event) => {
    const detail = (ev as CustomEvent).detail
    navData = get(detail, 'response', 'response') ?? null
    navPlayer = get(detail, 'response', 'playerResponse') ?? null
    sendPlayer()
  })
  document.addEventListener('loadedmetadata', () => sendPlayer(), true)

  announce()
})()
