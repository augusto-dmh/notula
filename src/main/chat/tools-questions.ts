// SPDX-License-Identifier: Apache-2.0
// `askUser` and `loadRecipe` (a skill is one of the user's recipes, by slug).
//
// askUser never runs on its own: a valid call waits as a pending approval whose
// `proposedArgs` are the questions, the turn ends, and the user's Send or Skip arrives as
// the decision (engine.ts). Its limits are checked here, in main.

import { ASK_USER_LIMITS, type AskUserQuestion } from '@shared/types/chat'
import { findRecipe } from '../recipes'
import { okJson, type LocalTool } from './tools'

const L = ASK_USER_LIMITS

/** 1–3 questions, 2–4 options each, unique labels per question, unique question ids. */
export function questionsProblem(v: unknown): string | null {
  if (!Array.isArray(v)) return '"questions" must be a list.'
  if (v.length < L.questionsMin || v.length > L.questionsMax) return `Ask ${L.questionsMin}–${L.questionsMax} questions.`
  const ids = new Set<string>()
  for (const [i, raw] of v.entries()) {
    const q = raw as Partial<AskUserQuestion> | null
    if (!q || typeof q !== 'object') return `questions[${i}] must be an object.`
    if (typeof q.id !== 'string' || !q.id.trim()) return `questions[${i}].id is missing.`
    if (ids.has(q.id)) return `Two questions share the id "${q.id}".`
    ids.add(q.id)
    if (typeof q.question !== 'string' || !q.question.trim()) return `questions[${i}].question is missing.`
    if (q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean') return `questions[${i}].multiSelect must be true or false.`
    const options = q.options
    if (!Array.isArray(options) || options.length < L.optionsMin || options.length > L.optionsMax) {
      return `questions[${i}] needs ${L.optionsMin}–${L.optionsMax} options.`
    }
    const labels = new Set<string>()
    for (const [j, o] of options.entries()) {
      const opt = o as { label?: unknown; description?: unknown } | null
      if (!opt || typeof opt.label !== 'string' || !opt.label.trim()) return `questions[${i}].options[${j}].label is missing.`
      if (opt.description !== undefined && typeof opt.description !== 'string') return `questions[${i}].options[${j}].description must be text.`
      if (labels.has(opt.label)) return `questions[${i}] has two options labeled "${opt.label}".`
      labels.add(opt.label)
    }
  }
  return null
}

/** The decision's answers: question id → the chosen labels, then the custom text. */
export function answersProblem(questions: AskUserQuestion[], v: unknown): string | null {
  if (v === undefined) return null
  if (!v || typeof v !== 'object' || Array.isArray(v)) return '"answers" must be an object.'
  for (const [id, list] of Object.entries(v as Record<string, unknown>)) {
    if (!questions.some((q) => q.id === id)) return `"answers" names an unknown question "${id}".`
    if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) return `The answers to "${id}" must be a list of strings.`
  }
  return null
}

/** The questions as the user's decision may carry them (whatever the model sent, cleaned). */
export function cleanQuestions(v: unknown): AskUserQuestion[] {
  return (Array.isArray(v) ? v : []).map((raw) => {
    const q = raw as AskUserQuestion
    return {
      id: String(q.id),
      question: String(q.question),
      options: (q.options ?? []).map((o) => ({ label: String(o.label), description: typeof o.description === 'string' ? o.description : '' })),
      ...(q.multiSelect ? { multiSelect: true } : {})
    }
  })
}

export const ASK_USER_QUESTION = 'askUser'

const askUser: LocalTool = {
  def: {
    name: ASK_USER_QUESTION,
    description:
      'Asks the user up to three multiple-choice questions in a card and waits for the answers. ' +
      'Use it only when the request is ambiguous in a way that changes the result and the context cannot settle it. ' +
      'Keep options short.',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: L.questionsMin,
          maxItems: L.questionsMax,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'A short id for the question, unique in this call.' },
              question: { type: 'string', description: 'The question, in one sentence.' },
              options: {
                type: 'array',
                minItems: L.optionsMin,
                maxItems: L.optionsMax,
                items: {
                  type: 'object',
                  properties: { label: { type: 'string' }, description: { type: 'string' } },
                  required: ['label', 'description']
                }
              },
              multiSelect: { type: 'boolean', description: 'Whether the user may pick more than one option.' }
            },
            required: ['id', 'question', 'options']
          }
        },
        answers: {
          type: 'object',
          properties: {},
          description: "Filled in by the app with the user's answers; leave it out."
        }
      },
      required: ['questions'],
      additionalProperties: false
    }
  },
  category: 'generic',
  title: 'Ask the user',
  needsApproval: true,
  readOnly: true,
  available: () => true,
  validate: (args) => questionsProblem(args['questions']) ?? answersProblem(cleanQuestions(args['questions']), args['answers']),
  run: async (args) => okJson({ answers: (args['answers'] as Record<string, string[]> | undefined) ?? {} })
}

const loadRecipe: LocalTool = {
  def: {
    name: 'loadRecipe',
    description:
      "Loads one of the user's saved recipes: instructions they wrote for a recurring kind of request. " +
      'Follow the instructions it returns for the rest of the answer.',
    inputSchema: {
      type: 'object',
      properties: { skillName: { type: 'string', minLength: 1, maxLength: 200, description: "The recipe's name, as listed in the system prompt." } },
      required: ['skillName'],
      additionalProperties: false
    }
  },
  category: 'generic',
  title: 'Load a recipe',
  needsApproval: false,
  readOnly: true,
  available: (a) => a.recipes,
  run: async (args, env) => {
    const name = String(args['skillName']).trim().replace(/^\//, '')
    const recipe = await findRecipe(env.ctx, name)
    if (!recipe) return okJson(false)
    return okJson({ skillName: recipe.slug, instructions: recipe.config.instructions })
  }
}

export const QUESTION_TOOLS: readonly LocalTool[] = [loadRecipe, askUser]
