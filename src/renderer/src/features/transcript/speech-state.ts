// SPDX-License-Identifier: Apache-2.0
// Renderer state for the speech settings: a preferences mirror read through the
// `prefs` bridge, and the local model state (`asr:get-local-model-state`,
// `asr:local-model-state-changed`).

import { useEffect, useState, useSyncExternalStore } from 'react'
import { MULTI_LANGUAGE_SETS } from '@shared/types/languages'
import type { Settings, SettingsPatch } from '@shared/types/settings'
import {
  LOCAL_ASR_MODELS,
  localModelCovers,
  type LocalAsrModelId,
  type LocalModelId,
  type LocalModelState
} from '@shared/types/transcript'

const listeners = new Set<() => void>()
let snapshot: Settings | null = null
let started = false

function emit(): void {
  for (const l of listeners) l()
}

function start(): void {
  if (started) return
  started = true
  window.notula.prefs.onChanged(({ settings }) => {
    snapshot = settings
    emit()
  })
  window.notula.prefs
    .get()
    .then((s) => {
      snapshot ??= s
      emit()
    })
    .catch(() => undefined)
}

function subscribe(cb: () => void): () => void {
  start()
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** The preferences, or null until the first load. */
export function useSpeechPrefs(): Settings | null {
  return useSyncExternalStore(subscribe, () => snapshot)
}

/** Shown at once, then sent to main, which answers with `prefs:changed`. */
export function setSpeechPrefs(patch: SettingsPatch): void {
  if (snapshot) {
    snapshot = { ...snapshot, ...patch }
    emit()
  }
  window.notula.prefs.set(patch)
}

/** The model's state: read once, then kept current by the push (`asr:local-model-state-changed`). */
export function useLocalModelState(modelId: LocalModelId): LocalModelState | null {
  const [state, setState] = useState<LocalModelState | null>(null)
  useEffect(() => {
    let alive = true
    const off = window.notula.asr.onLocalModelStateChanged((s) => {
      if (alive && s.modelId === modelId) setState(s)
    })
    window.notula.asr
      .getLocalModelState({ modelId })
      .then((s) => {
        if (alive) setState((prev) => prev ?? s)
      })
      .catch(() => undefined)
    return () => {
      alive = false
      off()
    }
  }, [modelId])
  return state
}

/** Every on-device speech model's state, kept current like `useLocalModelState`. */
export function useLocalAsrStates(): Partial<Record<LocalAsrModelId, LocalModelState>> {
  const [states, setStates] = useState<Partial<Record<LocalAsrModelId, LocalModelState>>>({})
  useEffect(() => {
    let alive = true
    const ids = new Set<string>(LOCAL_ASR_MODELS.map((m) => m.id))
    const off = window.notula.asr.onLocalModelStateChanged((s) => {
      if (alive && ids.has(s.modelId)) setStates((prev) => ({ ...prev, [s.modelId]: s }))
    })
    for (const m of LOCAL_ASR_MODELS) {
      window.notula.asr
        .getLocalModelState({ modelId: m.id })
        .then((s) => {
          if (alive) setStates((prev) => (prev[m.id] ? prev : { ...prev, [m.id]: s }))
        })
        .catch(() => undefined)
    }
    return () => {
      alive = false
      off()
    }
  }, [])
  return states
}

/** Whether an installed on-device model covers the language (`pt-BR`, `multi`). */
export function localLanguageInstalled(states: Partial<Record<LocalAsrModelId, LocalModelState>>, language: string): boolean {
  return LOCAL_ASR_MODELS.some((m) => states[m.id]?.state === 'ready' && localModelCovers(m.id, language))
}

/**
 * The recommended model's one-click "Download and use": the download starts now, and on-device
 * transcription with this model turns on once it is ready, even if Settings closed.
 */
const useWhenReady = new Set<LocalAsrModelId>()
let useWatch: (() => void) | null = null

export async function downloadAndUse(modelId: LocalAsrModelId): Promise<void> {
  useWhenReady.add(modelId)
  useWatch ??= window.notula.asr.onLocalModelStateChanged((s) => {
    const id = s.modelId as LocalAsrModelId
    if (!useWhenReady.has(id)) return
    if (s.state === 'ready') {
      useWhenReady.delete(id)
      setSpeechPrefs({ 'asr.provider': 'local', 'asr.local.model': id })
    } else if (s.state === 'error') useWhenReady.delete(id)
  })
  try {
    const s = await window.notula.asr.downloadLocalModel({ modelId })
    if (s.state === 'ready') {
      useWhenReady.delete(modelId)
      setSpeechPrefs({ 'asr.provider': 'local', 'asr.local.model': modelId })
    }
  } catch (err) {
    useWhenReady.delete(modelId)
    throw err
  }
}

/** "108 MB" (decimal, as download sizes are usually shown). */
export function formatBytes(bytes: number): string {
  const mb = bytes / 1_000_000
  if (mb >= 1000) return `${(mb / 1000).toFixed(1)} GB`
  if (mb >= 10) return `${Math.round(mb)} MB`
  return `${mb.toFixed(1)} MB`
}

/** The number of languages the active cloud provider's `multi` model covers (shown in the copy). */
export function multiLanguageCount(prefs: Settings | null): number {
  if (!prefs) return MULTI_LANGUAGE_SETS['nova-3'].length
  const provider = prefs['asr.provider']
  if (provider === 'assemblyai') return MULTI_LANGUAGE_SETS[prefs['asr.assemblyai.multilingualModel']].length
  return MULTI_LANGUAGE_SETS[prefs['asr.deepgram.multilingualVersion'] === '58-lang-beta' ? 'nova-3-mega' : 'nova-3'].length
}

/** The base codes of the active cloud provider's `multi` model. */
export function multiLanguageCodes(prefs: Settings | null): readonly string[] {
  if (prefs?.['asr.provider'] === 'assemblyai') return MULTI_LANGUAGE_SETS[prefs['asr.assemblyai.multilingualModel']]
  return MULTI_LANGUAGE_SETS[prefs?.['asr.deepgram.multilingualVersion'] === '58-lang-beta' ? 'nova-3-mega' : 'nova-3']
}

/** Rejections arrive as "Error invoking remote method …: Error: <code>: <message>". */
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const m = /(?:^|: )(?:busy|internal|invalid-input|provider-error): ([\s\S]*)$/.exec(raw)
  return (m?.[1] ?? raw).trim()
}
