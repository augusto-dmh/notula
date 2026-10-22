// SPDX-License-Identifier: Apache-2.0
// The template registry. The
// default "Summary" is a prompt slug, not a template record. A UUID slug is a note
// template: one of the nine built-ins or a stored user template, run on
// `custom-template-notes`; an unknown one fails with `unknown-template`.

import {
  BLANK_TEMPLATE_SLUG,
  BUILTIN_SUMMARY_SLUGS,
  DEFAULT_TEMPLATE_SLUG,
  USER_TEMPLATE_PROMPT_SLUG
} from '@shared/types/enhance'
import type { NoteTemplate } from '@shared/types/templates'
import type { MainContext } from '../context'
import { findTemplate } from '../templates'
import { enhanceError } from './errors'

export interface TemplateSection {
  heading: string
  description: string
}

export interface Template {
  slug: string
  title: string
  description: string
  sections: TemplateSection[]
}

export interface ResolvedTemplate {
  /** The prompt Notula runs (prompts/index.ts). */
  promptSlug: string
  template: Template
  /** The built-in prompt slug the template runs on, or null for a note template. */
  builtinPromptSlug: string | null
}

/** The panel title when a template has none. */
export const DEFAULT_PANEL_TITLE = 'Summary'

const DEFAULT_TEMPLATE: Template = {
  slug: DEFAULT_TEMPLATE_SLUG,
  title: DEFAULT_PANEL_TITLE,
  description: '',
  sections: []
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isBuiltinSummarySlug(slug: string): boolean {
  return slug === DEFAULT_TEMPLATE_SLUG || (BUILTIN_SUMMARY_SLUGS as readonly string[]).includes(slug)
}

export function isTemplateId(slug: string): boolean {
  return UUID_V4.test(slug)
}

/**
 * A note template as the prompts see it. Sections without a heading have nothing to
 * write as a heading, so they are left out (the editor hides them read-only too).
 */
export function promptTemplate(t: NoteTemplate): Template {
  return {
    slug: t.id,
    title: t.title.trim(),
    description: t.description.trim(),
    sections: t.sections
      .map((s) => ({ heading: s.heading.trim(), description: s.section_hint.trim() }))
      .filter((s) => s.heading.length > 0)
  }
}

/**
 * A leading `v2:` is ignored when testing the slug; an empty or
 * built-in slug runs the default prompt; a UUID is a note template; `blank` cannot
 * generate; anything else is a custom prompt slug, passed through. A `v2:` prefix on
 * a slug that is not built-in is an error.
 */
export async function resolveTemplate(ctx: MainContext, slug: string | null | undefined): Promise<ResolvedTemplate> {
  const raw = (slug ?? '').trim()
  if (raw.toLowerCase() === BLANK_TEMPLATE_SLUG) throw enhanceError('blank-template', 'A blank panel has no template to generate from.')
  const versioned = raw.startsWith('v2:')
  const bare = versioned ? raw.slice(3) : raw
  if (!bare || isBuiltinSummarySlug(bare)) {
    return { promptSlug: DEFAULT_TEMPLATE_SLUG, template: DEFAULT_TEMPLATE, builtinPromptSlug: DEFAULT_TEMPLATE_SLUG }
  }
  if (versioned) throw enhanceError('unknown-template', `"${raw}" is not a summary template.`)
  if (isTemplateId(bare)) {
    const found = await findTemplate(ctx, bare)
    if (!found) throw enhanceError('unknown-template', 'That template does not exist on this device.')
    return { promptSlug: USER_TEMPLATE_PROMPT_SLUG, template: promptTemplate(found), builtinPromptSlug: null }
  }
  return {
    promptSlug: bare,
    template: { slug: bare, title: DEFAULT_PANEL_TITLE, description: '', sections: [] },
    builtinPromptSlug: bare
  }
}

/** The title a new panel gets from its template. */
export function panelTitleFor(template: Template): string {
  return template.title.trim() || DEFAULT_PANEL_TITLE
}
