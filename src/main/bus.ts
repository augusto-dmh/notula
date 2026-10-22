// SPDX-License-Identifier: Apache-2.0
// The in-process event bus between main-side modules. Not IPC: renderer pushes
// are sent by their owning module with the channel literal at the send site.

import { EventEmitter } from 'node:events'
import type { UpdateDelayReason } from '@shared/types/app'
import type { AudioSource, IsoTime, StopReason } from '@shared/types/common'
import type { MicApp } from '@shared/types/meetings'
import type { ExtCaptions, ExtensionSnapshot } from '@shared/types/extension-protocol'
import type { SettingKey, Settings } from '@shared/types/settings'
import type { CanonicalKey, MediaSession, Playback, PlaybackProviderId, SourceMark } from '@shared/types/sources'
import type { StorageStatus } from '@shared/types/storage'
import type { AsrProviderId, TranscriptChanged } from '@shared/types/transcript'

/** Each event's comment names its emitter → its consumers. */
export interface BusEvents {
  /** `audioSources` only on a system-only run (a source note); absent = both, every meeting. */
  'capture:started': { noteId: string; sessionId: string; startedAt: IsoTime; audioSources?: AudioSource[] }
  /** Emitted only after the final chunks are flushed to storage. */
  'capture:stopped': {
    noteId: string
    sessionId: string
    reason: StopReason
    startedAt: IsoTime
    stoppedAt: IsoTime
  }
  'transcript:changed': TranscriptChanged
  'storage:changed': { tables: string[]; ids: string[] }
  'storage:status': StorageStatus
  'settings:changed': { keys: SettingKey[]; settings: Settings }

  /** power → enhance (defer end-of-meeting generation). */
  'power:suspended': { noteId: string | null; at: IsoTime }
  /** power → enhance (deferred generation), notify (notification re-check), calendar. */
  'power:resumed': { suspendedNoteId: string | null; suspendedAt: IsoTime | null; resumedAt: IsoTime }
  /** meetings → capture (inactivity app-left rule, dropout app name), notify. */
  'meetings:mic-apps': { apps: MicApp[]; previous: MicApp[] }
  /** lifecycle → updater, notify (notification rule 6). */
  'ui:viewing-note': { noteId: string | null }
  /** permissions → lifecycle, notify (notification suppression). */
  'ui:onboarding': { inOnboarding: boolean }
  /** chat (on every 5th streamed chunk while an answer streams), dictation → updater. */
  'update:delay': { reason: UpdateDelayReason }
  /** calendar → tray, notify (scheduled notifications). */
  'calendar:changed': { sourceIds: string[] }
  /**
   * enhance → folders (auto-add rules, AI folder suggestion). After the panel is stored; `ok` =
   * generation succeeded; `auto` = the end-of-meeting generation.
   */
  'enhance:completed': { noteId: string; panelId: string; ok: boolean; auto: boolean }
  /** folders → chat (chat directory cache). */
  'folders:changed': { folderIds: string[] }
  /**
   * enhance → speakers (speaker-name suggestions start alongside a summary). At each
   * generation start; `auto` = the end-of-meeting generation.
   */
  'enhance:started': { noteId: string; panelId: string; auto: boolean }
  /**
   * transcription → netdoctor (the automatic Network Doctor probe, once per app session, logged
   * only). Once per note and source.
   */
  'transcription:failover-exhausted': { noteId: string; source: AudioSource; providers: AsrProviderId[] }
  /** local-only, webhooks (a held send released) → the integrations scheduler. */
  'integrations:wake': { reason: 'held-released' }

  // ---------- content sources ----------
  /**
   * media (the passive reader, on every change) → media's own state machine, the extension
   * provider (liveness and title matching). Measured browsers only; memory only.
   */
  'media:sessions': { sessions: MediaSession[]; previous: MediaSession[] }
  /** The extension provider → media (covered browsers skip the passive pipeline), sources. */
  'media:extension': ExtensionSnapshot
  /** The extension provider → sources' transcript plan (video captions the player loaded). */
  'media:extension-captions': ExtCaptions
  /**
   * media (provider `media-session`) and the extension provider (`extension`) → sources (offer,
   * feed, spans, Recently played). Provider-neutral: one snapshot per provider, idempotent.
   */
  'sources:playback': { provider: PlaybackProviderId; playbacks: Playback[] }
  /** The extension provider, or the global mark shortcut → sources (append a stamped paragraph). */
  'sources:mark': { browser: string | null; tabKey: string | null; positionMs: number | null; observedAt: number; origin: SourceMark['origin'] }
  /** sources → the transcript plan, series, the extension provider. A note was created or continued from a source. */
  'sources:noted': { noteId: string; canonicalKey: CanonicalKey; playbackId: string | null; created: boolean }
  /** sources → the extension provider (desktop mode), capture (end of watching). Null = no source note bound. */
  'sources:feed': { noteId: string; canonicalKey: CanonicalKey; provider: PlaybackProviderId; tabKey: string | null } | null
}

export type BusEventName = keyof BusEvents

type BusEventArgs = { [E in BusEventName]: [payload: BusEvents[E]] }

/** A typed EventEmitter: `bus.on('capture:stopped', (e) => …)`, `bus.emit('capture:stopped', e)`. */
export class MainBus extends EventEmitter<BusEventArgs> {
  constructor() {
    super()
    this.setMaxListeners(50)
  }
}

export function createBus(): MainBus {
  return new MainBus()
}
