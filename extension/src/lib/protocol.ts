// SPDX-License-Identifier: Apache-2.0
// The wire protocol with Notula, on top of the shared types in src/shared.
// `parseFromNotula` is the only way a native-port message gets into the service worker: it rebuilds
// each known message from its known fields and rejects anything malformed. Unknown types are
// reported as `unknown` so the caller can count them, never acted on.

import {
  EXT_LIMITS,
  EXT_PROTOCOL,
  type ExtMode,
  type ExtPolicy,
  type NotulaToExt
} from '../../../src/shared/types/extension-protocol'
import { bool, int, isObj, oneOf, str, strOrNull, type Obj } from './check'

export * from '../../../src/shared/types/extension-protocol'

const MODES: readonly ExtMode[] = ['none', 'candidates', 'feed']
const TAB_MAX = 64
const VIDEO_MAX = 2_100

export type Parsed = { ok: true; msg: NotulaToExt } | { ok: false; reason: 'invalid' | 'unknown' }

function policy(v: unknown): ExtPolicy | undefined {
  if (!isObj(v)) return undefined
  const incognito = bool(v.incognito)
  const captions = bool(v.captions)
  const captions_replay = bool(v.captions_replay)
  const outline = bool(v.outline)
  if (incognito === undefined || captions === undefined || captions_replay === undefined || outline === undefined) {
    return undefined
  }
  return { incognito, captions, captions_replay, outline }
}

function feedTab(v: unknown): string | null | undefined {
  return strOrNull(v, TAB_MAX)
}

function build(m: Obj): NotulaToExt | undefined {
  switch (m.type) {
    case 'hello.ack': {
      const protocol = int(m.protocol, 0, 1_000)
      const version = isObj(m.app) ? str(m.app.version, 40) : undefined
      const mode = oneOf(m.mode, MODES)
      const feed_tab = feedTab(m.feed_tab)
      const pol = policy(m.policy)
      const min_ext = str(m.min_ext, 40)
      if (protocol === undefined || version === undefined || !mode || feed_tab === undefined || !pol || min_ext === undefined) {
        return undefined
      }
      return { type: 'hello.ack', protocol, app: { version }, mode, feed_tab, policy: pol, min_ext }
    }
    case 'mode': {
      const mode = oneOf(m.mode, MODES)
      const feed_tab = feedTab(m.feed_tab)
      if (!mode || feed_tab === undefined) return undefined
      return { type: 'mode', mode, feed_tab }
    }
    case 'policy': {
      const pol = policy(m.policy)
      return pol ? { type: 'policy', policy: pol } : undefined
    }
    case 'captions.request': {
      const tab = str(m.tab, TAB_MAX)
      const video = str(m.video, VIDEO_MAX)
      if (!tab || !video || !Array.isArray(m.langs) || m.langs.length > 20) return undefined
      const langs: string[] = []
      for (const l of m.langs) {
        const s = str(l, 35)
        if (!s || !/^[A-Za-z0-9_-]+$/.test(s)) return undefined
        langs.push(s)
      }
      return { type: 'captions.request', tab, video, langs }
    }
    case 'outline.request': {
      const tab = str(m.tab, TAB_MAX)
      return tab ? { type: 'outline.request', tab } : undefined
    }
    case 'mark.ack': {
      const ok = bool(m.ok)
      const position = m.position === null ? null : str(m.position, 12)
      const reason = m.reason === null ? null : oneOf(m.reason, ['no-media', 'no-position', 'held'] as const)
      if (ok === undefined || position === undefined || reason === undefined) return undefined
      if (position !== null && !/^\d{1,3}:\d{2}(:\d{2})?$/.test(position)) return undefined
      return { type: 'mark.ack', ok, position, reason }
    }
    case 'bridge': {
      return m.state === 'not-running' ? { type: 'bridge', state: 'not-running' } : undefined
    }
    default:
      return undefined
  }
}

const KNOWN = new Set(['hello.ack', 'mode', 'policy', 'captions.request', 'outline.request', 'mark.ack', 'bridge'])

export function parseFromNotula(raw: unknown): Parsed {
  if (!isObj(raw) || typeof raw.type !== 'string') return { ok: false, reason: 'invalid' }
  if (!KNOWN.has(raw.type)) return { ok: false, reason: 'unknown' }
  const msg = build(raw)
  return msg ? { ok: true, msg } : { ok: false, reason: 'invalid' }
}

/** True when Notula's chosen protocol is one this extension speaks. */
export function protocolSupported(chosen: number): boolean {
  return chosen >= EXT_PROTOCOL.oldest && chosen <= EXT_PROTOCOL.current
}

/** `1.2.3` style comparison; missing parts count as 0, anything non-numeric as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((p) => Number.parseInt(p, 10) || 0)
  const pb = b.split('.').map((p) => Number.parseInt(p, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/** The relay drops browser frames over this size; stay under it. */
export const MAX_FRAME_BYTES = EXT_LIMITS.frameBytes - 1_024
