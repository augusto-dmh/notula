// SPDX-License-Identifier: Apache-2.0
// Audio capture: the renderer engine, main's reconcile loop, and input devices.

import type { AudioSource, IsoTime, SourceState, StopReason } from './common'
import type { AsrProviderId } from './transcript'

export type DesiredCaptureState =
  | { capture: 'off'; reason: StopReason }
  | {
      capture: 'on'
      noteId: string
      /** Stable per note. */
      requestedAt: IsoTime
      language: string
      /** At most 100. */
      keywords: string[]
      asr: AsrProviderId
      /**
       * The sources the engine opens. Absent = both, which is every meeting; a source note's
       * `system-audio` plan sends `['system']` (no microphone stream at all).
       */
      audioSources?: AudioSource[]
    }

/** Every audio source, in the order the engine opens them; also the default of `audioSources`. */
export const AUDIO_SOURCES: readonly AudioSource[] = ['microphone', 'system']

/** The sources a desired `on` state asks for. */
export function audioSourcesOf(desired: { audioSources?: AudioSource[] }): readonly AudioSource[] {
  return desired.audioSources && desired.audioSources.length > 0 ? desired.audioSources : AUDIO_SOURCES
}

export interface CaptureSystemState {
  noteId: string | null
  /**
   * The sources this capture opened, only when not both (a source note's system-only capture).
   * An unrequested source stays `inactive` and never counts toward the combined state.
   */
  audioSources?: AudioSource[]
  microphoneCapture: SourceState
  systemCapture: SourceState
  microphoneTranscription: SourceState
  systemTranscription: SourceState
}

/** main → renderer engine. */
export type CaptureCommand =
  | {
      type: 'start'
      sampleRate: 16000
      pinnedDeviceId: string | null
      /** The sources to open; absent = both (every meeting). */
      audioSources?: AudioSource[]
    }
  | { type: 'stop' }
  | { type: 'use-input-device'; deviceId: string }
  | { type: 'release-input-device' }
  | { type: 'restart-system-audio' }

/** renderer engine → main. */
export type CaptureEngineEvent =
  | { type: 'initialized' }
  | { type: 'started'; sources: AudioSource[] }
  | { type: 'start-failed'; error: string }
  | { type: 'stopped' }
  | {
      type: 'buffer'
      source: AudioSource
      /** s16le mono, 3,200 bytes per 100 ms. */
      pcm: Uint8Array
      captureTimeMs: number
    }
  | { type: 'volume'; source: AudioSource; rms: number }
  | { type: 'source-error'; source: AudioSource; name: string; message: string }
  | { type: 'devices'; devices: InputDevice[] }
  | {
      type: 'active-device'
      deviceId: string | null
      label: string | null
      /** The pin the live microphone was opened for (null = the default); checked against the live device. */
      requestedDeviceId?: string | null
    }
  | { type: 'system-source'; label: string | null }
  | { type: 'restart-request'; scope: 'all' }
  | {
      type: 'log'
      level: 'info' | 'warn' | 'error'
      event: string
      data?: Record<string, string | number | boolean>
    }

export interface CaptureStatus {
  capturing: boolean
  noteId: string | null
  method: 'browser'
  sampleRate: 16000
  restartsUsed: number
}

export interface InputDevice {
  deviceId: string
  groupId: string
  label: string
  isDefault: boolean
}

export type InputPreference = { mode: 'auto' } | { mode: 'physical-device'; deviceId: string }

// ---------- audio health, inactivity, power (computed in main) ----------

/** The banner's inputs (`capture:get-health`, `capture:health`). */
export interface CaptureHealth {
  noteId: string | null
  /** System audio silent or stalled long enough to restart it (the dropout detector). */
  systemDropout: boolean
  /** The first meeting app holding the mic, for the system-audio dropout warning (W4). */
  dropoutApp: string | null
  /** Windows: a microphone `NotReadableError` with Kaspersky running (W2). */
  antivirusSuspected: boolean
  restartsThisStreak: number
  /** The microphone has sent only exact digital zero for 60 s (once per capture). */
  micSilent: boolean
  /** The silent microphone's label. */
  micSilentDevice: string | null
  /** System audio carried sound during that minute (others were talking). */
  micSilentWhileSystemSound: boolean
}

/** The warning card. `autoStopAt` null = auto-stop is off. */
export interface InactivityWarning {
  noteId: string
  shownAt: IsoTime
  autoStopAt: IsoTime | null
}

export type InactivityAction = 'keep' | 'stop'

/** A meeting stopped by sleep, offered for resume on wake. */
export interface PowerResumed {
  suspendedNoteId: string
  suspendedAt: IsoTime
  resumedAt: IsoTime
}

export interface InputSelectionState {
  /** The effective preference. */
  preference: InputPreference
  /** `'default'` unless the auto target is a device. */
  autoDeviceId: string
}
