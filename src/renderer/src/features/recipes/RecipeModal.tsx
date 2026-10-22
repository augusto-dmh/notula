// SPDX-License-Identifier: Apache-2.0
// The recipe modal: one dialog that shows a recipe
// (view), or edits a new or saved one (create / edit).
// - "Recipe name": a space becomes "-", other characters outside the slug pattern are
//   rejected as typed, a new name may be at most 48 characters, and other recipes
//   with the same prefix are counted;
// - "Made for": "Single meeting" or "Multiple meetings" (the control wiggles when Save
//   is pressed without a choice);
// - "Prompt" (required, ≤ 50,000 characters), "Description" (edit mode), "Advanced" →
//   "Model";
// - "Test recipe" streams a preview chat over the newest note (or the newest 3);
// - Save is optimistic; Delete is soft, with a 3 s "Deleted recipe" Undo.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { parseError } from '@shared/errors'
import { groupingKeyFor, type ChatEvent, type ChatPlace } from '@shared/types/chat'
import {
  RECIPE_NAME_MAX,
  RECIPE_PROMPT_MAX,
  type Recipe,
  type RecipeConfig,
  type RecipeUpsert
} from '@shared/types/recipes'
import { IconChevronDown, IconClose } from '../../app/icons'
import { debugLog } from '../../app/platform'
import { showToast } from '../../app/toast'
import { ChatMarkdown, ModelPicker } from '../chat'
import { IconCopy, IconPencilSmall, IconPlay, IconSlashTile, IconTrashSmall } from './icons'
import type { RecipeModalOptions } from './index'
import { displayName, isValidSlug, madeForOf, sanitizeSlugInput, viewsFor, type MadeFor } from './slug'
import { findRecipe, hideLocalRecipe, keepDraft, putLocalRecipe, setRecipesTab, useRecipes } from './store'
import { SaveToggle, UsageBadge } from './usage'
import './recipes.css'

const UNDO_MS = 3_000
const PLACEHOLDERS: Record<MadeFor, string> = {
  single: 'For example: List every decision made in this meeting, who made it, and what it depends on.',
  multi: 'For example: Across these meetings, what blockers keep coming up, and who raised each one?'
}
const MADE_FOR: { value: MadeFor; title: string; body: string }[] = [
  { value: 'single', title: 'Single meeting', body: 'Use during or after one meeting' },
  { value: 'multi', title: 'Multiple meetings', body: 'Ask across several meetings at once' }
]

// ---------- open state ----------

type ModalState = { opts: RecipeModalOptions; nonce: number } | null
let modal: ModalState = null
let nonce = 0
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

export function openModal(opts: RecipeModalOptions): void {
  modal = { opts, nonce: ++nonce }
  emit()
}

function closeModal(): void {
  modal = null
  emit()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function ModalHost(): JSX.Element | null {
  const state = useSyncExternalStore(subscribe, () => modal)
  if (!state) return null
  return <RecipeModal key={state.nonce} opts={state.opts} />
}

// ---------- the dialog ----------

interface Form {
  slug: string
  madeFor: MadeFor | null
  instructions: string
  description: string
  model: string | null
}

function formOf(r: Partial<RecipeUpsert> | Recipe | null): Form {
  const config: Partial<RecipeConfig> = r?.config ?? {}
  return {
    slug: r?.slug ?? '',
    madeFor: madeForOf(config.recipe_views),
    instructions: config.instructions ?? '',
    description: config.description ?? '',
    model: config.model ?? null
  }
}

/** A draft's "Made for" from where it was created, when it does not say. */
function madeForFromContext(d: Partial<RecipeUpsert> | undefined): MadeFor | null {
  const view = d?.creation_context?.activeView.view
  if (view === 'meeting' || view === 'live-meeting') return 'single'
  if (view) return 'multi'
  return null
}

function RecipeModal({ opts }: { opts: RecipeModalOptions }): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { recipes } = useRecipes()
  const [mode, setMode] = useState(opts.mode)
  const [recipeId, setRecipeId] = useState<string | null>(opts.mode === 'create' ? null : opts.recipeId)
  const recipe = recipeId ? (recipes.find((r) => r.id === recipeId) ?? null) : null
  const draft = opts.mode === 'create' ? opts.draft : undefined
  const [base, setBase] = useState<Partial<RecipeUpsert> | null>(draft ?? null)
  const [form, setForm] = useState<Form>(() => {
    if (opts.mode === 'create') {
      const f = formOf(opts.draft ?? null)
      return { ...f, madeFor: f.madeFor ?? madeForFromContext(opts.draft) }
    }
    return formOf(findRecipe(recipes, opts.recipeId))
  })
  const [wiggle, setWiggle] = useState(0)
  const [saving, setSaving] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [preview, setPreview] = useState<{ text: string; state: 'streaming' | 'done' | 'error'; error?: string } | null>(null)
  const [noteIds, setNoteIds] = useState<string[] | null>(null)
  const previewOff = useRef<(() => void) | null>(null)

  useEffect(() => {
    const d = dialogRef.current
    if (d && !d.open) d.showModal()
    return () => previewOff.current?.()
  }, [])

  // Test recipe needs at least one note.
  useEffect(() => {
    void window.notula.notes
      .list({ scope: 'own', limit: 3 })
      .then((p) => setNoteIds(p.items.map((i) => i.id)))
      .catch(() => setNoteIds([]))
  }, [])

  // A recipe opened for viewing follows the list; one opened for editing fills the form
  // once, when the list first has it.
  const filled = useRef(opts.mode !== 'create' && !!findRecipe(recipes, opts.recipeId))
  useEffect(() => {
    if (!recipe) return
    if (mode === 'view') setForm(formOf(recipe))
    else if (mode === 'edit' && !filled.current) setForm(formOf(recipe))
    filled.current = true
  }, [mode, recipe])

  const isNew = mode === 'create'
  const own = recipe ? !recipe.is_builtin : true
  const slugTooLong = (isNew || (recipe && recipe.slug !== form.slug)) && form.slug.length > RECIPE_NAME_MAX
  const slugValid = isValidSlug(form.slug)
  const instructionsOk = form.instructions.trim().length > 0 && form.instructions.length <= RECIPE_PROMPT_MAX
  const canSave = slugValid && instructionsOk && !saving && !slugTooLong
  const canTest = form.madeFor !== null && slugValid && instructionsOk && !slugTooLong && (noteIds?.length ?? 0) > 0
  const samePrefix = useMemo(() => {
    const key = form.slug.toLowerCase()
    if (!key) return 0
    return recipes.filter(
      (r) =>
        !r.is_builtin &&
        r.id !== recipeId &&
        (r.slug.toLowerCase() === key || r.slug.toLowerCase().startsWith(`${key}-`) || r.slug.toLowerCase().startsWith(`${key}_`))
    ).length
  }, [recipes, form.slug, recipeId])

  const update = (patch: Partial<Form>): void => {
    setForm((f) => {
      const next = { ...f, ...patch }
      if (isNew) keepDraft({ ...(base ?? {}), slug: next.slug, config: configOf(next, base?.config) })
      return next
    })
  }

  const close = (discardDraft: boolean): void => {
    if (discardDraft && isNew) keepDraft(null)
    closeModal()
  }

  const save = async (): Promise<void> => {
    if (form.madeFor === null) {
      setWiggle((w) => w + 1)
      return
    }
    if (!canSave) return
    setSaving(true)
    const previous = recipe
    const id = recipe && own ? recipe.id : crypto.randomUUID()
    const config = configOf(form, recipe?.config ?? base?.config)
    const upsert: RecipeUpsert = {
      id,
      slug: form.slug,
      config,
      ...(isNew ? { creation_context: base?.creation_context ?? null, source_recipe_id: base?.source_recipe_id ?? null } : {})
    }
    // Stored optimistically, shown in view mode on "My recipes".
    const now = new Date().toISOString()
    putLocalRecipe({
      id,
      slug: form.slug,
      owner_id: previous?.owner_id ?? 'local',
      workspace_id: previous?.workspace_id ?? null,
      config,
      visibility: 'private',
      creation_context: previous?.creation_context ?? base?.creation_context ?? null,
      source_recipe_id: previous?.source_recipe_id ?? base?.source_recipe_id ?? null,
      is_builtin: false,
      saved: previous?.saved ?? false,
      created_at: previous?.created_at ?? now,
      updated_at: now,
      deleted_at: null
    })
    setRecipesTab('mine')
    setRecipeId(id)
    setMode('view')
    try {
      putLocalRecipe(await window.notula.recipes.upsert(upsert))
      keepDraft(null)
    } catch (err) {
      debugLog('recipe-save-failed', { err: parseError(err) })
      showToast({ kind: 'error', title: 'Couldn’t save the recipe', description: parseError(err).message })
      if (previous) {
        putLocalRecipe(previous)
        setMode('edit')
      } else {
        hideLocalRecipe(id, true)
        setRecipeId(null)
        setMode('create')
      }
    } finally {
      setSaving(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!recipe || recipe.is_builtin) return
    const id = recipe.id
    hideLocalRecipe(id, true)
    closeModal()
    try {
      await window.notula.recipes.delete({ id })
    } catch (err) {
      hideLocalRecipe(id, false)
      showToast({ kind: 'error', title: 'Couldn’t delete the recipe', description: parseError(err).message })
      return
    }
    showToast({
      id: `recipe-deleted-${id}`,
      title: 'Recipe deleted',
      durationMs: UNDO_MS,
      action: {
        label: 'Undo',
        onClick: () => {
          window.notula.recipes
            .restore({ id })
            .then(() => {
              hideLocalRecipe(id, false)
              showToast({ id: `recipe-deleted-${id}`, title: 'Recipe restored', kind: 'success' })
            })
            .catch((err: unknown) => showToast({ kind: 'error', title: 'Couldn’t undo', description: parseError(err).message }))
        }
      }
    })
  }

  const editCopy = (): void => {
    if (!recipe) return
    const copy: Partial<RecipeUpsert> = {
      slug: `${recipe.slug}-copy`.slice(0, RECIPE_NAME_MAX),
      config: { ...recipe.config },
      source_recipe_id: recipe.id
    }
    setBase(copy)
    setForm(formOf(copy))
    setRecipeId(null)
    setMode('create')
  }

  /** A preview chat, streamed and never stored. */
  const test = async (): Promise<void> => {
    if (!canTest || !noteIds || form.madeFor === null) return
    previewOff.current?.()
    const ids = form.madeFor === 'single' ? noteIds.slice(0, 1) : noteIds.slice(0, 3)
    const place: ChatPlace = form.madeFor === 'single' && ids[0] ? { kind: 'meeting', noteId: ids[0] } : { kind: 'global' }
    const requestId = crypto.randomUUID()
    setPreview({ text: '', state: 'streaming' })
    const off = window.notula.chat.onEvent((e: ChatEvent) => {
      if (e.requestId !== requestId) return
      if (e.type === 'text_delta') setPreview((p) => ({ text: (p?.text ?? '') + e.delta, state: 'streaming' }))
      else if (e.type === 'stream_done') {
        const final = e.outputs
          .map((o) => (o.type === 'text' ? o.text : o.type === 'cited_text' ? o.plain_text : ''))
          .filter(Boolean)
          .join('\n\n')
        setPreview((p) => ({ text: final || p?.text || '', state: 'done' }))
        off()
      } else if (e.type === 'error') {
        setPreview((p) => ({ text: p?.text ?? '', state: 'error', error: e.error }))
        off()
      }
    })
    previewOff.current = off
    try {
      await window.notula.chat.sendMessage({
        requestId,
        threadId: null,
        groupingKey: groupingKeyFor(place),
        surface: 'floating',
        place,
        text: '',
        mentions: [],
        recipeId: null,
        selectedDocuments: [],
        target: null,
        selectionMarkdown: null,
        editWithAi: false,
        responseStyle: 'default',
        edit: null,
        approval: null,
        preview: { recipe: { slug: form.slug, config: configOf(form, recipe?.config ?? base?.config) }, noteIds: ids }
      })
    } catch (err) {
      off()
      const message = parseError(err).message
      setPreview({
        text: '',
        state: 'error',
        // Until chat is wired, the send channel has no handler.
        error: /no handler registered/i.test(message) ? 'Test recipe needs chat, which is not available in this build yet.' : message
      })
    }
  }

  const editing = mode !== 'view'
  const title = editing ? (isNew ? 'New recipe' : 'Edit recipe') : displayName(recipe?.slug ?? form.slug)

  return (
    <dialog
      ref={dialogRef}
      className={`rcp-modal${preview ? ' has-preview' : ''}`}
      aria-labelledby="rcp-modal-title"
      onCancel={(e) => {
        e.preventDefault()
        close(false)
      }}
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return
        const r = e.currentTarget.getBoundingClientRect()
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close(false)
      }}
    >
      <header className="rcp-modal__header">
        <IconSlashTile size={30} />
        <div className="rcp-modal__heading">
          <h2 id="rcp-modal-title" className="rcp-modal__title">
            {title}
          </h2>
          {!editing && recipe ? <span className="rcp-modal__slug">/{recipe.slug}</span> : null}
        </div>
        {!editing && recipe ? (
          own ? (
            <button type="button" className="n-btn n-btn--sm" onClick={() => setMode('edit')}>
              <IconPencilSmall size={14} />
              Edit
            </button>
          ) : (
            <button type="button" className="n-btn n-btn--sm" onClick={editCopy}>
              <IconCopy size={14} />
              Edit a copy
            </button>
          )
        ) : null}
        <button type="button" className="n-icon-btn" aria-label="Close" onClick={() => close(false)}>
          <IconClose size={18} />
        </button>
      </header>

      <div className="rcp-modal__body">
        <div className="rcp-modal__form">
          {editing ? (
            <>
              <label className="rcp-field">
                <span className="rcp-field__label">Recipe name</span>
                <span className="rcp-slug">
                  <span className="rcp-slug__prefix" aria-hidden="true">
                    /
                  </span>
                  <input
                    className="rcp-slug__input"
                    placeholder="New recipe"
                    value={form.slug}
                    autoFocus={isNew && !form.slug}
                    spellCheck={false}
                    onChange={(e) => update({ slug: sanitizeSlugInput(e.target.value) })}
                  />
                </span>
                {slugTooLong ? (
                  <span className="rcp-field__error" role="alert">
                    Recipe name must be {RECIPE_NAME_MAX} characters or fewer. {form.slug.length - RECIPE_NAME_MAX} characters too long.
                  </span>
                ) : samePrefix > 0 ? (
                  <span className="rcp-field__hint">
                    You have {samePrefix} other {samePrefix === 1 ? 'recipe' : 'recipes'} using the same prefix.
                  </span>
                ) : null}
              </label>

              <fieldset key={wiggle} className={`rcp-field rcp-madefor${wiggle > 0 && form.madeFor === null ? ' is-wiggling' : ''}`}>
                <legend className="rcp-field__label">Made for</legend>
                <div className="rcp-madefor__options" role="radiogroup">
                  {MADE_FOR.map((m) => (
                    <button
                      key={m.value}
                      type="button"
                      role="radio"
                      aria-checked={form.madeFor === m.value}
                      className="rcp-madefor__option"
                      onClick={() => update({ madeFor: m.value })}
                    >
                      <span className="rcp-madefor__dot" aria-hidden="true" />
                      <span className="rcp-madefor__text">
                        <span className="rcp-madefor__title">{m.title}</span>
                        <span className="rcp-madefor__body">{m.body}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </fieldset>

              <label className="rcp-field">
                <span className="rcp-field__label">Prompt</span>
                <textarea
                  className="n-input rcp-prompt"
                  placeholder={PLACEHOLDERS[form.madeFor ?? 'single']}
                  value={form.instructions}
                  maxLength={RECIPE_PROMPT_MAX}
                  onChange={(e) => update({ instructions: e.target.value })}
                />
                {form.instructions.length > RECIPE_PROMPT_MAX * 0.9 ? (
                  <span className="rcp-field__hint">
                    {form.instructions.length.toLocaleString('en-US')} / {RECIPE_PROMPT_MAX.toLocaleString('en-US')}
                  </span>
                ) : null}
              </label>

              {mode === 'edit' ? (
                <label className="rcp-field">
                  <span className="rcp-field__label">Description</span>
                  <input
                    className="n-input"
                    value={form.description}
                    maxLength={2_000}
                    placeholder="What this recipe is for"
                    onChange={(e) => update({ description: e.target.value })}
                  />
                </label>
              ) : null}

              <div className="rcp-advanced">
                <button type="button" className="rcp-advanced__toggle" aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)}>
                  <IconChevronDown size={14} className={advanced ? 'is-open' : undefined} />
                  Advanced
                </button>
                {advanced ? (
                  <div className="rcp-field rcp-advanced__body">
                    <span className="rcp-field__label">Model</span>
                    <ModelPicker kind="recipe" value={form.model} onChange={(v) => update({ model: v })} />
                    <span className="rcp-field__hint">Auto uses the model chosen for the chat.</span>
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <RecipeDetails recipe={recipe} form={form} />
          )}
        </div>

        {preview ? (
          <section className="rcp-preview" aria-label="Preview" aria-live="polite">
            <h3 className="rcp-preview__title">Preview</h3>
            {preview.state === 'error' ? (
              <p className="rcp-preview__error">{preview.error || 'The preview could not run.'}</p>
            ) : preview.text ? (
              <div className="rcp-preview__text">
                <ChatMarkdown markdown={preview.text} />
              </div>
            ) : (
              <p className="rcp-preview__pending">Running the recipe…</p>
            )}
          </section>
        ) : null}
      </div>

      {editing ? (
        <footer className="rcp-modal__footer">
          {mode === 'edit' && recipe && own ? (
            <span className="n-tooltip n-tooltip--start" data-tooltip="Delete recipe">
              <button type="button" className="n-icon-btn rcp-delete" aria-label="Delete recipe" onClick={() => void remove()}>
                <IconTrashSmall size={16} />
              </button>
            </span>
          ) : null}
          <span className="rcp-modal__spacer" />
          <span
            className="n-tooltip"
            data-tooltip={canTest ? undefined : 'Fill in the required fields and have a note to test on.'}
            {...(canTest ? {} : { tabIndex: 0 })}
          >
            <button type="button" className="n-btn n-btn--sm" disabled={!canTest} onClick={() => void test()}>
              <IconPlay size={13} />
              Test recipe
            </button>
          </span>
          <button
            type="button"
            className="n-btn n-btn--sm"
            onClick={() => {
              if (mode === 'edit' && recipe) {
                setForm(formOf(recipe))
                setMode('view')
              } else close(true)
            }}
          >
            Cancel
          </button>
          <button type="button" className="n-btn n-btn--primary n-btn--sm" disabled={!canSave} onClick={() => void save()}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </footer>
      ) : null}
    </dialog>
  )
}

function RecipeDetails({ recipe, form }: { recipe: Recipe | null; form: Form }): JSX.Element {
  if (!recipe) return <p className="rcp-modal__missing">This recipe no longer exists.</p>
  const madeFor = MADE_FOR.find((m) => m.value === form.madeFor)
  return (
    <div className="rcp-details">
      {recipe.config.description ? <p className="rcp-details__description">{recipe.config.description}</p> : null}
      <div className="rcp-details__meta">
        <span className="rcp-badge">{madeFor ? madeFor.title : 'Any meeting'}</span>
        {recipe.is_builtin ? <span className="rcp-badge rcp-badge--quiet">Notula</span> : null}
        {recipe.config.model ? <span className="rcp-badge rcp-badge--quiet">{recipe.config.model}</span> : null}
        <UsageBadge recipeId={recipe.id} />
        <span className="rcp-details__spacer" />
        <SaveToggle recipe={recipe} variant="button" />
      </div>
      <h3 className="rcp-field__label">Prompt</h3>
      <p className="rcp-details__prompt">{recipe.config.instructions}</p>
    </div>
  )
}

/** The config a save writes: the form's fields over what the recipe already had. */
function configOf(form: Form, prev: Partial<RecipeConfig> | undefined): RecipeConfig {
  const config: RecipeConfig = {
    ...(prev ?? {}),
    instructions: form.instructions,
    makes_artifact: prev?.makes_artifact ?? false,
    examples: prev?.examples ?? [],
    shared_tab_visible: prev?.shared_tab_visible ?? false
  }
  if (form.madeFor) config.recipe_views = viewsFor(form.madeFor)
  if (form.description.trim()) config.description = form.description
  else delete config.description
  if (form.model) config.model = form.model
  else delete config.model
  return config
}

