// SPDX-License-Identifier: Apache-2.0
// The chat model picker: "Auto" first, then
// one group labelled with the active provider and its models from `llm:list-models`.
// Hidden while the list is empty. The button reads "Auto" or the model id; with Auto,
// its tooltip names the model Auto resolves to. The `single` and `multi` selections
// are settings (they persist); the recipe kind edits a recipe's own model.

import { useEffect, useRef, useState, type JSX } from 'react'
import { CHAT_MODEL_AUTO, MODEL_ALIASES, type LlmProviderId } from '@shared/types/enhance'
import type { Settings } from '@shared/types/settings'
import { IconCheck, IconChevronDown } from '../../app/icons'
import { debugLog } from '../../app/platform'
import { setPrefs, usePrefs } from '../settings/prefs-store'
import type { ModelPickerProps } from './index'
import { Popover } from './Popover'

const LIST_TTL_MS = 3_600_000
const cache = new Map<string, { at: number; models: string[] }>()
const PROVIDER_LABEL: Record<LlmProviderId, string> = { anthropic: 'Anthropic', openai: 'OpenAI-compatible', local: 'Local' }

function settingsModel(s: Settings): string {
  const p = s['llm.provider']
  return p === 'anthropic' ? s['llm.anthropic.model'] : p === 'openai' ? s['llm.openai.model'] : s['llm.local.model']
}

function listKey(s: Settings): string {
  const p = s['llm.provider']
  return `${p}|${p === 'openai' ? s['llm.openai.baseUrl'] : p === 'local' ? s['llm.local.baseUrl'] : ''}`
}

/** The active provider's models: undefined while loading, [] when unavailable. */
function useProviderModels(prefs: Settings | null): string[] | undefined {
  const key = prefs ? listKey(prefs) : ''
  const hit = cache.get(key)
  const [models, setModels] = useState<string[] | undefined>(hit && Date.now() - hit.at < LIST_TTL_MS ? hit.models : undefined)
  useEffect(() => {
    if (!prefs) return
    const fresh = cache.get(key)
    if (fresh && Date.now() - fresh.at < LIST_TTL_MS) {
      setModels(fresh.models)
      return
    }
    let cancelled = false
    setModels(undefined)
    window.notula.llm
      .listModels({ provider: prefs['llm.provider'] })
      .then((list) => {
        cache.set(key, { at: Date.now(), models: list })
        if (!cancelled) setModels(list)
      })
      .catch((err: unknown) => {
        debugLog('chat:model-list-failed', { err: String(err) })
        if (!cancelled) setModels([])
      })
    return () => {
      cancelled = true
    }
    // The key covers the provider and its base URL.
  }, [key])
  return models
}

function normalize(value: string | null | undefined): string {
  const v = (value ?? '').trim()
  return v === '' || v === CHAT_MODEL_AUTO ? CHAT_MODEL_AUTO : (MODEL_ALIASES[v] ?? v)
}

export function ModelPickerView(p: ModelPickerProps): JSX.Element | null {
  const prefs = usePrefs()
  const models = useProviderModels(prefs)
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  if (!prefs || !models || models.length === 0) return null

  const provider = prefs['llm.provider']
  const auto = settingsModel(prefs)
  const stored = p.kind === 'recipe' ? normalize(p.value) : normalize(prefs[p.kind === 'single' ? 'chat.model.single' : 'chat.model.multi'])
  // A selection the provider no longer lists shows (and runs) as Auto.
  const value = stored !== CHAT_MODEL_AUTO && models.includes(stored) ? stored : CHAT_MODEL_AUTO
  const label = value === CHAT_MODEL_AUTO ? 'Auto' : value
  const tooltip = value === CHAT_MODEL_AUTO && auto ? `Select AI model · Auto uses ${auto}` : 'Select AI model'

  const pick = (id: string): void => {
    setOpen(false)
    if (p.kind === 'recipe') p.onChange(id === CHAT_MODEL_AUTO ? null : id)
    else setPrefs(p.kind === 'single' ? { 'chat.model.single': id } : { 'chat.model.multi': id })
  }

  return (
    <>
      <span className="n-tooltip chat-model__tip" data-tooltip={tooltip}>
        <button
          ref={anchor}
          type="button"
          className={`chat-model${p.kind === 'recipe' ? ' chat-model--field' : ''}`}
          aria-label="Select model"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="chat-model__label">{label}</span>
          <IconChevronDown size={13} />
        </button>
      </span>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} align={p.kind === 'recipe' ? 'start' : 'end'} placement={p.kind === 'recipe' ? 'below' : 'above'} label="Models" className="chat-model-menu">
        <button type="button" role="menuitemradio" aria-checked={value === CHAT_MODEL_AUTO} className="chat-menu__item" title={auto ? `Uses ${auto}` : undefined} onClick={() => pick(CHAT_MODEL_AUTO)}>
          <span className="chat-menu__text">
            Auto
            {auto ? <span className="chat-menu__hint">{auto}</span> : null}
          </span>
          {value === CHAT_MODEL_AUTO ? <IconCheck size={14} /> : null}
        </button>
        <div className="chat-menu__heading">{PROVIDER_LABEL[provider]}</div>
        <div className="chat-model-menu__list">
          {models.map((m) => (
            <button key={m} type="button" role="menuitemradio" aria-checked={value === m} className="chat-menu__item" onClick={() => pick(m)}>
              <span className="chat-menu__text chat-menu__mono">{m}</span>
              {value === m ? <IconCheck size={14} /> : null}
            </button>
          ))}
        </div>
      </Popover>
    </>
  )
}
