// SPDX-License-Identifier: Apache-2.0
// The browser extension's protocol, version 1, and the
// desktop-side status of the bridge. Compiled into both the extension package (`extension/`)
// and Notula main, so this file imports nothing at runtime and stays free of Electron and DOM.
//
// Unknown fields and unknown message types are ignored and counted on both sides. A new
// optional field doesn't bump PROTOCOL; a breaking change does, and both sides keep
// accepting the previous version for at least one extension release.

/** The current protocol and the oldest one still accepted. */
export const EXT_PROTOCOL = { current: 1, oldest: 1 } as const

export const EXT_BRIDGE = {
  hostName: 'app.notula.bridge',
  /** Under `<userData>`. */
  folder: 'ext-bridge',
  manifestFile: 'app.notula.bridge.json',
  launcherFile: 'notula-ext-host.cmd',
  scriptFile: 'notula-ext-host.cjs',
  endpointFile: 'endpoint.json',
  /** `\\.\pipe\notula-ext-bridge-<16 hex>`. */
  pipePrefix: 'notula-ext-bridge-',
  registryKeys: {
    chrome: 'Software\\Google\\Chrome\\NativeMessagingHosts\\app.notula.bridge',
    edge: 'Software\\Microsoft\\Edge\\NativeMessagingHosts\\app.notula.bridge'
  },
  command: 'mark-moment'
} as const

export const EXT_LIMITS = {
  frameBytes: 1_048_576,
  bufferBytes: 4_194_304,
  mediaBytes: 4_096,
  captionsPartBytes: 524_288,
  captionsParts: 200,
  messagesPerSecond: 20,
  connections: 32,
  feedIntervalMs: 1_000,
  candidatesIntervalMs: 5_000,
  idleDisconnectMs: 120_000,
  coveredQuietMs: 10_000,
  matchWindowMs: 3_000,
  markHoldMs: 10 * 60 * 1_000,
  hostRetries: 5,
  hostRetryMs: 2_000
} as const

/** `<browser session random>:<tabId>`; meaningless outside one browser run. */
export type ExtTabKey = string
export type ExtStore = 'cws' | 'edge' | 'dev'
export type ExtMode = 'none' | 'candidates' | 'feed'
export type ExtFieldConfidence = 'page' | 'heuristic'
export type ExtAdapter = 'youtube' | 'circle' | 'udemy' | 'coursera' | 'generic'

export interface ExtPolicy {
  incognito: boolean
  captions: boolean
  /** Off in local-only mode: a replay is a network request. */
  captions_replay: boolean
  outline: boolean
}

// ---------- relay → Notula ----------

/** The relay's first line on the pipe. */
export interface ExtAuth {
  type: 'auth'
  token: string
  /** `chrome-extension://<id>/`, argv 1 of the host. */
  origin: string
  host_version: string
}

// ---------- extension → Notula ----------

export interface ExtHello {
  type: 'hello'
  protocol: [min: number, max: number]
  ext: { version: string; store: ExtStore }
  browser: { brand: string; major: number }
}

export interface ExtMedia {
  type: 'media'
  tab: ExtTabKey
  /** 0 = top frame. */
  frame: number
  url: string
  canonical_url: string | null
  title: string
  site: string | null
  incognito: boolean
  audible: boolean
  media: {
    /** Seconds. */
    current_time: number
    duration: number | null
    rate: number
    paused: boolean
    ended: boolean
    live: boolean
    muted: boolean
  }
  /** While showing, `current_time` is the last content position, not the ad's. */
  ad: { showing: boolean }
  session: { title: string | null; artist: string | null; album: string | null } | null
  adapter: ExtAdapter
  /** Epoch ms. */
  observed_at: number
  seq: number
}

export interface ExtMediaGone {
  type: 'media.gone'
  tab: ExtTabKey
  reason: 'closed' | 'navigated' | 'stopped'
}

export interface ExtPage {
  type: 'page'
  tab: ExtTabKey
  adapter: ExtAdapter
  course: { id: string; title: string | null; url: string | null } | null
  section: { id: string | null; title: string | null; index: number | null } | null
  lesson: { id: string | null; title: string | null; index: number | null; count: number | null } | null
  playlist: { id: string; title: string | null; index: number | null; count: number | null } | null
  channel: { id: string | null; name: string | null } | null
  confidence: Partial<Record<'course' | 'section' | 'lesson' | 'playlist' | 'channel', ExtFieldConfidence>>
}

export interface ExtOutlineItem {
  number: number | null
  section: string | null
  title: string
  url: string | null
  /** Seconds. */
  duration: number | null
}

export interface ExtOutline {
  type: 'outline'
  tab: ExtTabKey
  items: ExtOutlineItem[]
}

/** One cue: start and end in ms, and its text. */
export interface ExtCue {
  s: number
  e: number
  t: string
}

export interface ExtCaptions {
  type: 'captions'
  tab: ExtTabKey
  /** The content source's canonical key. */
  video: string
  lang: string
  kind: 'manual' | 'asr'
  source: 'player' | 'replay' | 'texttrack' | 'dom'
  part: number
  parts: number
  cues: ExtCue[]
}

export interface ExtCaptionsUnavailable {
  type: 'captions-unavailable'
  tab: ExtTabKey
  video: string
  reason: 'token-required' | 'no-track' | 'policy' | 'failed'
}

export interface ExtChapters {
  type: 'chapters'
  tab: ExtTabKey
  video: string
  /** `start` in seconds. */
  items: { start: number; title: string }[]
  source: 'player' | 'description'
}

export interface ExtMark {
  type: 'mark'
  tab: ExtTabKey | null
  /** Seconds. */
  current_time: number | null
  observed_at: number
}

/** Counts only, never text. */
export interface ExtLog {
  type: 'log'
  event: string
  count: number
}

export type ExtToNotula =
  | ExtHello
  | ExtMedia
  | ExtMediaGone
  | ExtPage
  | ExtOutline
  | ExtCaptions
  | ExtCaptionsUnavailable
  | ExtChapters
  | ExtMark
  | ExtLog

// ---------- Notula → extension ----------

export interface ExtHelloAck {
  type: 'hello.ack'
  protocol: number
  app: { version: string }
  mode: ExtMode
  feed_tab: ExtTabKey | null
  policy: ExtPolicy
  min_ext: string
}

export interface ExtModeMessage {
  type: 'mode'
  mode: ExtMode
  feed_tab: ExtTabKey | null
}

export interface ExtPolicyMessage {
  type: 'policy'
  policy: ExtPolicy
}

export interface ExtCaptionsRequest {
  type: 'captions.request'
  tab: ExtTabKey
  video: string
  langs: string[]
}

export interface ExtOutlineRequest {
  type: 'outline.request'
  tab: ExtTabKey
}

export interface ExtMarkAck {
  type: 'mark.ack'
  ok: boolean
  /** `mm:ss`. */
  position: string | null
  reason: 'no-media' | 'no-position' | 'held' | null
}

/** From the relay when Notula isn't reachable. */
export interface ExtBridgeMessage {
  type: 'bridge'
  state: 'not-running'
}

export type NotulaToExt =
  | ExtHelloAck
  | ExtModeMessage
  | ExtPolicyMessage
  | ExtCaptionsRequest
  | ExtOutlineRequest
  | ExtMarkAck
  | ExtBridgeMessage

/** Every message type both sides emit or accept. */
export const EXT_MESSAGE_TYPES = [
  'auth',
  'hello',
  'hello.ack',
  'mode',
  'policy',
  'media',
  'media.gone',
  'page',
  'outline',
  'outline.request',
  'captions',
  'captions.request',
  'captions-unavailable',
  'chapters',
  'mark',
  'mark.ack',
  'log',
  'bridge'
] as const

// ---------- the desktop side ----------

/** The bridge's state, per browser where it applies. */
export type ExtBridgeState =
  | 'off'
  | 'not-installed'
  | 'waiting'
  | 'connected'
  | 'extension-outdated'
  | 'host-failed'
  | 'host-blocked'

/** `ext-bridge:get-status`. */
export interface ExtBridgeStatus {
  enabled: boolean
  /** False off Windows. */
  supported: boolean
  state: ExtBridgeState
  browsers: {
    brand: string
    state: ExtBridgeState
    extVersion: string | null
    store: ExtStore | null
    lastSeenAt: number | null
  }[]
  /** "Course details partly missing on <site>": sites with adapter misses. */
  adapterMisses: string[]
}

/** Bus `media:extension`: what the extension provider sees now. */
export interface ExtensionSnapshot {
  /** Browsers covered now: connected, with a `media` message in the last 10 s. */
  covered: string[]
  tabs: ExtMedia[]
  pages: ExtPage[]
}
