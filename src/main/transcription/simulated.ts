// SPDX-License-Identifier: Apache-2.0
// Simulated transcription sessions for the demo meeting. Each scripted line becomes a final
// `system` chunk of a new session at its scripted time, with `detected_speaker_name` = the
// line's speaker, through the same store-and-push path as ASR finals. The session row is
// stored with provider `simulated`. Capture is never touched; no ASR provider runs.

import { randomUUID } from 'node:crypto'
import type { AsrProviderId, TranscriptChunk } from '@shared/types/transcript'
import type { MainContext } from '../context'
import { log } from '../log'
import type { SimulatedLine, SimulatedSession } from './api'
import type { ChunkStore } from './chunks'

/** The stored provider of a simulated session (not an ASR provider). */
const SIMULATED = 'simulated' as AsrProviderId
const MODEL = 'demo-script'

export function startSimulatedSession(ctx: MainContext, store: ChunkStore, noteId: string, lines: SimulatedLine[]): SimulatedSession {
  const sessionId = randomUUID()
  const startedAtMs = Date.now()
  const script = [...lines]
    .filter((l) => l && typeof l.text === 'string' && l.text.trim() && Number.isFinite(l.atMs))
    .sort((a, b) => a.atMs - b.atMs)
  const lineCbs: ((index: number) => void)[] = []
  const endCbs: ((reason: string) => void)[] = []
  let next = 0
  let timer: NodeJS.Timeout | null = null
  let pausedAt: number | null = null
  /** Total paused time so far: the script clock is wall time minus this. */
  let pausedMs = 0
  let ended = false
  let identity = { workspaceId: '', ownerId: '' }

  const ready = (async () => {
    try {
      identity = await ctx.storage.identity()
    } catch (err) {
      log('warn', 'asr:simulated-identity-unavailable', { err })
    }
    try {
      await ctx.storage.createSession({
        id: sessionId,
        document_id: noteId,
        provider: SIMULATED,
        model: MODEL,
        language: 'en',
        started_at: new Date(startedAtMs).toISOString()
      })
    } catch (err) {
      log('warn', 'asr:simulated-session-row-failed', { sessionId, err })
    }
  })()

  const scriptNow = (): number => Date.now() - startedAtMs - pausedMs - (pausedAt !== null ? Date.now() - pausedAt : 0)

  const write = (line: SimulatedLine): void => {
    // The line's wall-clock time: its scripted offset plus the pauses before it.
    const startMs = startedAtMs + pausedMs + line.atMs
    const endMs = startMs + Math.max(0, line.durationMs)
    const chunk: TranscriptChunk = {
      id: randomUUID(),
      document_id: noteId,
      workspace_id: identity.workspaceId,
      owner_id: identity.ownerId,
      transcription_session_id: sessionId,
      source: 'system',
      start_timestamp: new Date(startMs).toISOString(),
      end_timestamp: new Date(endMs).toISOString(),
      text: line.text.trim(),
      is_final: true,
      detected_speaker_name: line.speaker?.trim() || null,
      detectedSpeaker: null
    }
    store.upsert(chunk)
  }

  const finish = async (reason: string): Promise<void> => {
    if (ended) return
    ended = true
    if (timer) clearTimeout(timer)
    timer = null
    await ready
    await store.flush(noteId)
    try {
      await ctx.storage.endSession(sessionId, new Date().toISOString(), reason)
    } catch (err) {
      log('warn', 'asr:simulated-session-end-failed', { sessionId, err })
    }
    log('info', 'asr:simulated-ended', { noteId, sessionId, reason, written: next, lines: script.length })
    for (const cb of endCbs.splice(0)) {
      try {
        cb(reason)
      } catch (err) {
        log('warn', 'asr:simulated-callback-failed', { err })
      }
    }
  }

  const schedule = (): void => {
    if (ended || pausedAt !== null) return
    if (timer) clearTimeout(timer)
    timer = null
    if (next >= script.length) {
      const last = script[script.length - 1]
      const endAt = last ? last.atMs + Math.max(0, last.durationMs) : 0
      timer = setTimeout(() => void finish('demo_finished'), Math.max(0, endAt - scriptNow()))
      return
    }
    const line = script[next] as SimulatedLine
    timer = setTimeout(() => {
      timer = null
      if (ended || pausedAt !== null) return
      const index = next++
      write(line)
      for (const cb of lineCbs) {
        try {
          cb(index)
        } catch (err) {
          log('warn', 'asr:simulated-callback-failed', { err })
        }
      }
      schedule()
    }, Math.max(0, line.atMs - scriptNow()))
  }

  void ready.then(() => {
    log('info', 'asr:simulated-started', { noteId, sessionId, lines: script.length })
    schedule()
  })

  return {
    sessionId,
    pause: () => {
      if (ended || pausedAt !== null) return
      pausedAt = Date.now()
      if (timer) clearTimeout(timer)
      timer = null
    },
    resume: () => {
      if (ended || pausedAt === null) return
      pausedMs += Date.now() - pausedAt
      pausedAt = null
      schedule()
    },
    // Lines not yet played are not written.
    stop: (reason) => finish(reason),
    onLine: (cb) => {
      lineCbs.push(cb)
    },
    onEnded: (cb) => {
      endCbs.push(cb)
    }
  }
}
