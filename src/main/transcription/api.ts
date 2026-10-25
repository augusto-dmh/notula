// SPDX-License-Identifier: Apache-2.0
// TranscriptionControl: the seam between the capture controller and the transcription
// sessions. Capture imports only from `../transcription`, never from `manager.ts`;
// `transcriptionControl(ctx)` in index.ts returns this API. It also carries
// `startSimulated` (the demo); the SpeechApi (dictation) is returned by
// `createSpeechApi(ctx)` in index.ts.

import type { AudioSource, IsoTime, SourceState } from '@shared/types/common'
import type { TranscriptionLanguage } from '@shared/types/settings'
import type { AsrProviderId, TranscriptChunk } from '@shared/types/transcript'

export interface StartOptions {
  noteId: string
  language: string
  keywords: string[]
  asr: AsrProviderId
  /**
   * The sources to transcribe; absent = both (every meeting). A source note's system-only
   * capture passes `['system']`: no microphone ASR stream is opened at all.
   */
  sources?: readonly AudioSource[]
}

export type SourceStateListener = (noteId: string, source: AudioSource, state: SourceState) => void

export interface TranscriptionControl {
  /** Starts the note's session; the sockets connect in the background. */
  start(opts: StartOptions): { sessionId: string; startedAt: IsoTime }
  /** s16le mono PCM. */
  feed(noteId: string, source: AudioSource, pcm: Buffer, captureTimeMs: number): void
  updateKeywords(noteId: string, keywords: string[]): void
  retryNow(noteId: string): void
  isActive(noteId: string): boolean
  /** Drains and flushes. Resolves with the stopped session, or null if none ran. */
  stop(noteId: string, reason: string): Promise<{ sessionId: string; startedAt: IsoTime } | null>
  /** `capture:await-session-stopped`: waits for the note's session, at most 30 s. */
  awaitStopped(noteId: string): Promise<{ waited: boolean; timedOut: boolean }>
  flush(noteId: string): Promise<void>
  /**
   * Resolves once the note's final speaker labels are stored: the drain of its
   * last session (as awaitStopped) and, when diarization is on, the diarization pass at
   * stop (done, skipped or capped). Resolves at once when nothing is pending.
   */
  awaitSpeakerLabels(noteId: string): Promise<void>
  liveChunks(noteId: string): TranscriptChunk[]
  getTranscript(noteId: string): Promise<TranscriptChunk[]>
  onSourceState(listener: SourceStateListener): void
  /**
   * Restarts the session in place on a language, provider or model change (the
   * old session ends with `config_changed`, capture keeps running); applies a
   * keywords-only change in place.
   */
  reconfigure(
    noteId: string,
    opts: { language: TranscriptionLanguage; asr: AsrProviderId; keywords: string[] }
  ): Promise<void>
  /**
   * Inactivity recovery: the `reconfigure` swap with the session's current settings, run
   * even though nothing changed (the old session ends with `inactivity_recovery`). Resolves
   * once the new session has started, while the old one drains; false when the note has no
   * running session.
   */
  restartSession(noteId: string): Promise<boolean>
  /**
   * Writes each line as a final `system` chunk of a new session (provider `simulated`) with
   * `detected_speaker_name` = the line's speaker, through the same store-and-push path as
   * ASR finals. Never touches capture.
   */
  startSimulated(noteId: string, lines: SimulatedLine[]): SimulatedSession
}

// ---------- speech recognition for dictation ----------

export type RecognizerFailure = 'no-provider' | 'transcription_start' | 'connection' | 'connection_timeout' | 'offline'

export class RecognizerError extends Error {
  constructor(
    readonly reason: RecognizerFailure,
    message: string
  ) {
    super(message)
    this.name = 'RecognizerError'
  }
}

export interface RecognizerOptions {
  purpose: 'dictation' | 'chat-voice'
  choice: 'auto' | AsrProviderId
  /** `auto` or a language code. */
  language: string
  /** At most 100, each at most 50 characters. */
  keyterms: string[]
}

export interface SpeechRecognizer {
  readonly provider: AsrProviderId
  /** 6 s; 30 s for a cold local worker. Rejects `RecognizerError`. */
  ready: Promise<void>
  /** 16 kHz s16le mono, any size; segmented inside (see speech.ts). */
  feed(pcm: Buffer): void
  /** Rejects `RecognizerError`. */
  finish(): Promise<{ text: string; language: string | null; audioMs: number }>
  cancel(): void
}

export interface SpeechApi {
  /** `auto`: local when installed and covering the language, else `asr.provider`. */
  openRecognizer(opts: RecognizerOptions): SpeechRecognizer
  /** Keeps one dictation notula-asr worker warm; it unloads after 10 min idle. */
  setLocalWarm(on: boolean): void
}

// ---------- simulated sessions for the demo ----------

export interface SimulatedLine {
  atMs: number
  durationMs: number
  speaker: string
  text: string
}

export interface SimulatedSession {
  readonly sessionId: string
  pause(): void
  resume(): void
  /** Lines not yet played are not written. */
  stop(reason: 'demo_finished' | 'user_stopped' | 'window_closed'): Promise<void>
  onLine(cb: (index: number) => void): void
  onEnded(cb: (reason: string) => void): void
}
