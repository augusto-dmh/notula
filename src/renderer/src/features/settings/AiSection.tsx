// SPDX-License-Identifier: Apache-2.0
// The AI section, shared by Settings and the
// onboarding AI-providers step.
//
// - Transcription: Cloud (Deepgram or AssemblyAI, the model or region, a key). On-device
//   transcription is the block below it (LocalAsrSettings): its switch turns it on once
//   the speech model is ready, and the cloud rows hide while it is on.
// - Notes AI: Cloud (Anthropic or an OpenAI-compatible service: model, key, base
//   URL) or Local (an OpenAI-compatible server such as Ollama: base URL and model).
// - Keys are write-only: they go to main through `asr:set-key` / `llm:set-key` and
//   come back only as "saved" (`*:has-key`). The field is cleared after saving.
//
// Provider and model are ordinary preference keys, saved as they change. The
// onboarding step also saves keys that were typed but not saved yet (KeyDrafts).

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import { GEMINI_PRESET, isGeminiBaseUrl, OPENAI_DEFAULT_BASE_URL, type CloudLlmProviderId, type LlmProviderId } from '@shared/types/enhance'
import type { AssemblyAiRegion, Settings, SettingsPatch } from '@shared/types/settings'
import type { CloudAsrProviderId } from '@shared/types/transcript'
import { LocalAsrSettings } from '../transcript'
import { Group, Row, Segmented, Select, StatusLine, type Status } from './controls'
import { IconLock, IconRefresh } from './icons'
import { setPrefs } from './prefs-store'

// ---------- helpers ----------

type KeyArea = 'asr' | 'llm'

const ASR_PROVIDERS: Record<CloudAsrProviderId, string> = { deepgram: 'Deepgram', assemblyai: 'AssemblyAI' }
const LLM_PROVIDERS: Record<CloudLlmProviderId, string> = { anthropic: 'Anthropic', openai: 'OpenAI-compatible' }

/** The Provider menu: the Gemini preset (Recommended, first) is OpenAI-compatible underneath. */
type LlmChoice = 'gemini' | CloudLlmProviderId
const LLM_CHOICES: readonly { value: LlmChoice; label: string }[] = [
  { value: 'gemini', label: 'Google Gemini (Recommended)' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI-compatible' }
]

/** Settings for a Provider menu choice. */
export function llmChoicePatch(choice: LlmChoice, prefs: Settings): SettingsPatch {
  if (choice === 'gemini') {
    return { 'llm.provider': 'openai', 'llm.openai.baseUrl': GEMINI_PRESET.baseUrl, 'llm.openai.model': GEMINI_PRESET.model }
  }
  if (choice === 'openai' && isGeminiBaseUrl(prefs['llm.openai.baseUrl'])) {
    return { 'llm.provider': 'openai', 'llm.openai.baseUrl': OPENAI_DEFAULT_BASE_URL, 'llm.openai.model': '' }
  }
  return { 'llm.provider': choice }
}

const DEEPGRAM_MODELS = ['nova-3', 'nova-2'] as const
const ASSEMBLYAI_REGIONS: readonly { value: AssemblyAiRegion; label: string }[] = [
  { value: 'edge', label: 'Nearest (edge)' },
  { value: 'us', label: 'United States' },
  { value: 'eu', label: 'European Union' }
]

const MODEL_KEY = {
  anthropic: 'llm.anthropic.model',
  openai: 'llm.openai.model',
  local: 'llm.local.model'
} as const satisfies Record<LlmProviderId, keyof Settings>

/** "A Deepgram key", "An OpenAI-compatible key", "An Anthropic key". */
function withArticle(name: string): string {
  return `${/^[aeiou]/i.test(name) ? 'An' : 'A'} ${name}`
}

/** A readable line for a failed call. A missing handler means that part isn't built yet. */
export function describeError(err: unknown): string {
  const { message } = parseError(err)
  if (/No handler registered/i.test(message)) return 'Not available in this build yet.'
  return message || 'Something went wrong.'
}

/** Keys typed but not saved yet, so the onboarding step can save them on "Save". */
export type KeyDrafts = Map<string, () => Promise<boolean>>
const DraftsContext = createContext<KeyDrafts | null>(null)

function keyApi(area: KeyArea): {
  has(provider: string): Promise<boolean>
  set(provider: string, key: string): Promise<void>
  clear(provider: string): Promise<void>
  test(provider: string): Promise<{ ok: boolean; error?: string }>
} {
  if (area === 'asr') {
    return {
      has: (p) => window.notula.asr.hasKey({ provider: p as CloudAsrProviderId }),
      set: (p, key) => window.notula.asr.setKey({ provider: p as CloudAsrProviderId, key }),
      clear: (p) => window.notula.asr.clearKey({ provider: p as CloudAsrProviderId }),
      test: (p) => window.notula.asr.test({ provider: p as CloudAsrProviderId })
    }
  }
  return {
    has: (p) => window.notula.llm.hasKey({ provider: p as CloudLlmProviderId }),
    set: (p, key) => window.notula.llm.setKey({ provider: p as CloudLlmProviderId, key }),
    clear: (p) => window.notula.llm.clearKey({ provider: p as CloudLlmProviderId }),
    test: (p) => window.notula.llm.test({ provider: p as LlmProviderId })
  }
}

// ---------- key field ----------

/** A write-only API key: Save, Remove and Test. The key is never shown back. */
function KeyField({
  area,
  provider,
  providerName,
  onKeyChanged
}: {
  area: KeyArea
  provider: string
  providerName: string
  /** After a save or a removal: what depends on the key (the model list) reloads. */
  onKeyChanged?(): void
}): JSX.Element {
  const api = keyApi(area)
  const inputId = useId()
  const [has, setHas] = useState<boolean | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<'save' | 'clear' | 'test' | null>(null)
  const [status, setStatus] = useState<Status>(null)
  /** has-key failed: the key API isn't there (yet), so nothing can be saved. */
  const [unavailable, setUnavailable] = useState(false)
  const drafts = useContext(DraftsContext)

  const refresh = useCallback(() => {
    keyApi(area)
      .has(provider)
      .then(setHas)
      .catch((err: unknown) => {
        setHas(null)
        setUnavailable(true)
        setStatus({ kind: 'error', text: describeError(err) })
      })
  }, [area, provider])

  useEffect(() => {
    setHas(null)
    setUnavailable(false)
    setDraft('')
    setStatus(null)
    refresh()
  }, [refresh])

  async function save(): Promise<boolean> {
    const key = draft.trim()
    if (!key) return true
    setBusy('save')
    setStatus(null)
    try {
      await api.set(provider, key)
      setDraft('')
      setStatus({ kind: 'ok', text: 'Key saved.' })
      refresh()
      onKeyChanged?.()
      return true
    } catch (err) {
      setStatus({ kind: 'error', text: describeError(err) })
      return false
    } finally {
      setBusy(null)
    }
  }

  // The onboarding step saves an unsaved draft on "Save".
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    if (!drafts) return
    const id = `${area}:${provider}`
    drafts.set(id, () => saveRef.current())
    return () => {
      drafts.delete(id)
    }
  }, [drafts, area, provider])

  async function clear(): Promise<void> {
    setBusy('clear')
    setStatus(null)
    try {
      await api.clear(provider)
      setStatus({ kind: 'info', text: 'Key removed.' })
      refresh()
      onKeyChanged?.()
    } catch (err) {
      setStatus({ kind: 'error', text: describeError(err) })
    } finally {
      setBusy(null)
    }
  }

  async function test(): Promise<void> {
    setBusy('test')
    setStatus({ kind: 'info', text: `Connecting to ${providerName}…` })
    try {
      const r = await api.test(provider)
      setStatus(r.ok ? { kind: 'ok', text: `Connected to ${providerName}.` } : { kind: 'error', text: r.error || 'The test failed.' })
    } catch (err) {
      setStatus({ kind: 'error', text: describeError(err) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Row
      label="API key"
      htmlFor={inputId}
      stacked
      hint={
        <span className="key-field__state">
          <IconLock size={13} />
          {unavailable
            ? 'Key status unavailable.'
            : has === null
              ? 'Checking…'
              : has
                ? `${withArticle(providerName)} key is saved on this computer.`
                : `No ${providerName} key yet.`}
        </span>
      }
    >
      <div className="key-field">
        <input
          id={inputId}
          className="n-input key-field__input"
          type="password"
          value={draft}
          disabled={unavailable}
          placeholder={has ? 'Enter a new key to replace it' : `Paste your ${providerName} API key`}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void save()
            }
          }}
        />
        <div className="key-field__actions">
          <button
            type="button"
            className="n-btn n-btn--sm n-btn--primary"
            disabled={!draft.trim() || busy !== null || unavailable}
            onClick={() => void save()}
          >
            {busy === 'save' ? 'Saving…' : 'Save key'}
          </button>
          <button type="button" className="n-btn n-btn--sm" disabled={!has || busy !== null} onClick={() => void test()}>
            {busy === 'test' ? 'Testing…' : 'Test'}
          </button>
          {has ? (
            <button type="button" className="n-btn n-btn--sm n-btn--ghost n-btn--danger" disabled={busy !== null} onClick={() => void clear()}>
              Remove
            </button>
          ) : null}
        </div>
        <StatusLine status={status} />
      </div>
    </Row>
  )
}

// ---------- text field saved on blur ----------

function PrefText({
  label,
  hint,
  value,
  placeholder,
  onCommit
}: {
  label: string
  hint?: string
  value: string
  placeholder?: string
  onCommit(next: string): void
}): JSX.Element {
  const id = useId()
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = (): void => {
    const next = draft.trim()
    if (next !== value) onCommit(next)
  }
  return (
    <Row label={label} hint={hint} htmlFor={id} stacked>
      <input
        id={id}
        className="n-input settings-text"
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
    </Row>
  )
}

// ---------- model picker ----------

/** The model for a Notes AI provider, from `llm:list-models`; typed by hand when the list is unavailable. */
function ModelPicker({ provider, prefs, refreshKey }: { provider: LlmProviderId; prefs: Settings; refreshKey: string }): JSX.Element {
  const id = useId()
  const settingKey = MODEL_KEY[provider]
  const value = prefs[settingKey]
  const [models, setModels] = useState<string[] | null>(null)
  const [status, setStatus] = useState<Status>(null)
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)

  const load = useCallback(() => {
    const mine = ++seq.current
    setLoading(true)
    setStatus(null)
    window.notula.llm
      .listModels({ provider })
      .then((list) => {
        if (mine !== seq.current) return
        setModels(list)
        if (!list.length) setStatus({ kind: 'info', text: 'No models found. Type a model name instead.' })
      })
      .catch((err: unknown) => {
        if (mine !== seq.current) return
        setModels(null)
        setStatus({ kind: 'error', text: `Couldn’t load models: ${describeError(err)}` })
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false)
      })
  }, [provider])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  const set = (next: string): void => setPrefs({ [settingKey]: next } as SettingsPatch)
  const options = models && models.length ? (value && !models.includes(value) ? [value, ...models] : models) : null

  return (
    <Row label="Model" htmlFor={id} stacked hint="Used for enhanced notes and titles.">
      <div className="model-picker">
        <div className="model-picker__line">
          {options ? (
            <Select
              id={id}
              label="Model"
              wide
              value={value}
              options={[
                ...(value ? [] : [{ value: '', label: 'Choose a model', disabled: true }]),
                ...options.map((m) => ({ value: m, label: m }))
              ]}
              onChange={set}
            />
          ) : (
            <ModelText id={id} value={value} onCommit={set} />
          )}
          <button
            type="button"
            className="n-icon-btn n-icon-btn--sm model-picker__refresh"
            aria-label="Refresh the model list"
            title="Refresh the model list"
            disabled={loading}
            onClick={load}
          >
            {loading ? <span className="n-spinner model-picker__spinner" /> : <IconRefresh size={15} />}
          </button>
        </div>
        <StatusLine status={status} />
      </div>
    </Row>
  )
}

function ModelText({ id, value, onCommit }: { id: string; value: string; onCommit(next: string): void }): JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = (): void => {
    const next = draft.trim()
    if (next && next !== value) onCommit(next)
  }
  return (
    <input
      id={id}
      className="n-input settings-text"
      value={draft}
      placeholder="Model name"
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
    />
  )
}

/** Test for the local server, which has no key. */
function LocalTest(): JSX.Element {
  const [status, setStatus] = useState<Status>(null)
  const [busy, setBusy] = useState(false)
  async function test(): Promise<void> {
    setBusy(true)
    setStatus({ kind: 'info', text: 'Connecting to the local server…' })
    try {
      const r = await window.notula.llm.test({ provider: 'local' })
      setStatus(r.ok ? { kind: 'ok', text: 'Connected to the local server.' } : { kind: 'error', text: r.error || 'The test failed.' })
    } catch (err) {
      setStatus({ kind: 'error', text: describeError(err) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Row label="Connection" hint="Checks that the server answers with the chosen model." stacked>
      <div className="key-field">
        <div className="key-field__actions">
          <button type="button" className="n-btn n-btn--sm" disabled={busy} onClick={() => void test()}>
            {busy ? 'Testing…' : 'Test'}
          </button>
        </div>
        <StatusLine status={status} />
      </div>
    </Row>
  )
}

// ---------- the section ----------

export function AiSection({ prefs, drafts }: { prefs: Settings; drafts?: KeyDrafts }): JSX.Element {
  const asrProvider = prefs['asr.provider']
  const llmProvider = prefs['llm.provider']
  const gemini = llmProvider === 'openai' && isGeminiBaseUrl(prefs['llm.openai.baseUrl'])
  const llmName = gemini ? 'Google Gemini' : llmProvider === 'local' ? '' : LLM_PROVIDERS[llmProvider]
  const lastCloudLlm = useRef<CloudLlmProviderId>(llmProvider === 'local' ? 'anthropic' : llmProvider)
  if (llmProvider !== 'local') lastCloudLlm.current = llmProvider
  /** Bumped when a Notes AI key is saved or removed, so the model list reloads with it. */
  const [llmKeyVersion, setLlmKeyVersion] = useState(0)

  const deepgramModels = DEEPGRAM_MODELS.includes(prefs['asr.deepgram.model'] as (typeof DEEPGRAM_MODELS)[number])
    ? DEEPGRAM_MODELS
    : [prefs['asr.deepgram.model'], ...DEEPGRAM_MODELS]

  return (
    <DraftsContext.Provider value={drafts ?? null}>
      <Group
        title="Transcription"
        description="Turns meeting audio into the live transcript. Cloud providers use your own API key."
      >
        {asrProvider === 'local' ? null : (
          <>
            <Row label="Provider">
              <Select
                label="Transcription provider"
                value={asrProvider}
                options={(Object.keys(ASR_PROVIDERS) as CloudAsrProviderId[]).map((p) => ({ value: p, label: ASR_PROVIDERS[p] }))}
                onChange={(p) => setPrefs({ 'asr.provider': p })}
              />
            </Row>
            {asrProvider === 'deepgram' ? (
              <Row label="Model">
                <Select
                  label="Deepgram model"
                  value={prefs['asr.deepgram.model']}
                  options={deepgramModels.map((m) => ({ value: m, label: m }))}
                  onChange={(m) => setPrefs({ 'asr.deepgram.model': m })}
                />
              </Row>
            ) : (
              <Row label="Region" hint="Where AssemblyAI processes your audio.">
                <Select
                  label="AssemblyAI region"
                  value={prefs['asr.assemblyai.region']}
                  options={ASSEMBLYAI_REGIONS}
                  onChange={(r) => setPrefs({ 'asr.assemblyai.region': r })}
                />
              </Row>
            )}
            <KeyField area="asr" provider={asrProvider} providerName={ASR_PROVIDERS[asrProvider]} />
          </>
        )}
        {/* Mount point: the local model rows. */}
        <LocalAsrSettings />
      </Group>

      <Group
        title="Notes AI"
        description="Writes enhanced notes and titles. Use a cloud model with your own key, or a model running on this computer."
      >
        <Row label="Engine">
          <Segmented
            label="Notes AI engine"
            value={llmProvider === 'local' ? 'local' : 'cloud'}
            options={[
              { value: 'cloud', label: 'Cloud' },
              { value: 'local', label: 'On this computer' }
            ]}
            onChange={(v) => setPrefs({ 'llm.provider': v === 'local' ? 'local' : lastCloudLlm.current })}
          />
        </Row>
        {llmProvider === 'local' ? (
          <>
            <PrefText
              label="Server URL"
              hint="An OpenAI-compatible server, such as Ollama."
              value={prefs['llm.local.baseUrl']}
              placeholder="http://127.0.0.1:11434/v1"
              onCommit={(v) => setPrefs({ 'llm.local.baseUrl': v })}
            />
            <ModelPicker provider="local" prefs={prefs} refreshKey={prefs['llm.local.baseUrl']} />
            <LocalTest />
          </>
        ) : (
          <>
            <Row label="Provider">
              <Select<LlmChoice>
                label="Notes AI provider"
                value={gemini ? 'gemini' : llmProvider}
                options={LLM_CHOICES}
                onChange={(c) => setPrefs(llmChoicePatch(c, prefs))}
              />
            </Row>
            {gemini ? (
              <Row
                label="Data use"
                stacked
                hint="Google’s free tier may use your data to improve its products. For meeting notes, use a key from a paid (billing-enabled) project."
              />
            ) : llmProvider === 'openai' ? (
              <PrefText
                label="Base URL"
                hint="The API address of OpenAI or a compatible service."
                value={prefs['llm.openai.baseUrl']}
                placeholder="https://api.openai.com/v1"
                onCommit={(v) => setPrefs({ 'llm.openai.baseUrl': v })}
              />
            ) : null}
            <KeyField
              area="llm"
              provider={llmProvider}
              providerName={llmName}
              onKeyChanged={() => setLlmKeyVersion((v) => v + 1)}
            />
            <ModelPicker
              provider={llmProvider}
              prefs={prefs}
              refreshKey={`${llmProvider === 'openai' ? prefs['llm.openai.baseUrl'] : ''}#${llmKeyVersion}`}
            />
          </>
        )}
      </Group>
    </DraftsContext.Provider>
  )
}
