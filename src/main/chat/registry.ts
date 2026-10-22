// SPDX-License-Identifier: Apache-2.0
// The chat tool registry (`ChatApi`). It holds
// Notula's local tools and the providers other modules register at runtime (the MCP
// client's tools), builds the tool set of one answer (fixed for all of its rounds), runs a
// call on whichever side owns it, and serves the read-only library tools to the local MCP
// server with the same implementation, caps and shapes as chat.

import { randomUUID } from 'node:crypto'
import { parseError } from '@shared/errors'
import { CHAT_CORE_TOOLS, CHAT_AGENTIC_TOOLS, type ChatPlace } from '@shared/types/chat'
import type { MainContext } from '../context'
import type { LlmToolDef } from '../llm/types'
import { log } from '../log'
import { allRecipes } from '../recipes'
import { folders, PAYLOAD_SOURCE_SCHEMA } from './library'
import type { ChatApi, ChatToolProvider, ChatToolResult, ChatToolSpec, LibraryToolName } from './tool-api'
import { CALENDAR_TOOLS } from './tools-calendar'
import { FOLDER_TOOLS } from './tools-folders'
import { NOTE_TOOLS_P3 } from './tools-notes'
import { PEOPLE_TOOLS } from './tools-people'
import { QUESTION_TOOLS } from './tools-questions'
import {
  APPROVAL_FIXTURE_TOOL,
  fail,
  P2_TOOLS,
  runLocalTool,
  type LocalTool,
  type ToolAvailability,
  type ToolEnv,
  type ToolOutcome
} from './tools'

/** A provider's tool list may take this long per answer before it is skipped. */
const PROVIDER_TOOLS_TIMEOUT_MS = 5_000
/** Folders checked for files when a library chat decides on listFolderAttachments. */
const FOLDER_FILES_SCAN = 50

/** The fixed order of the local tools: the core tools, then the agentic ones, the dev fixture last. */
const ORDER: readonly string[] = [...CHAT_CORE_TOOLS, ...CHAT_AGENTIC_TOOLS, APPROVAL_FIXTURE_TOOL]

const LOCAL: readonly LocalTool[] = [...P2_TOOLS, ...NOTE_TOOLS_P3, ...CALENDAR_TOOLS, ...PEOPLE_TOOLS, ...FOLDER_TOOLS, ...QUESTION_TOOLS].sort(
  (a, b) => rank(a.def.name) - rank(b.def.name)
)

function rank(name: string): number {
  const i = ORDER.indexOf(name)
  return i === -1 ? ORDER.length : i
}

export interface ToolEntry {
  spec: ChatToolSpec
  local: LocalTool | null
  provider: ChatToolProvider | null
}

/** One answer's tools: the definitions the model sees and who runs each name. */
export interface AnswerTools {
  defs: LlmToolDef[]
  entries: Map<string, ToolEntry>
}

export interface ProviderTools {
  provider: ChatToolProvider
  specs: ChatToolSpec[]
}

function localSpec(t: LocalTool): ChatToolSpec {
  return { def: t.def, category: t.category, needsApproval: t.needsApproval, readOnly: t.readOnly, title: t.title }
}

/** What decides the tool set, read once per answer. Every lookup fails soft (a module may not be wired). */
export async function toolAvailability(
  ctx: MainContext,
  input: { place: ChatPlace; noteId: string | null; noteEdit: boolean; rewrite: boolean }
): Promise<ToolAvailability> {
  const settings = await ctx.settings.getAll()
  const [sources, note, recipes] = await Promise.all([
    ctx.storage.listCalendarSources().catch(() => []),
    input.noteId ? ctx.storage.getNote(input.noteId).catch(() => null) : Promise.resolve(null),
    allRecipes(ctx).catch(() => [])
  ])
  let brief = false
  if (note?.event_id && settings['prepBrief.enabled']) {
    const b = await ctx.storage.getBrief(note.event_id).catch(() => null)
    brief = b?.status === 'completed'
  }
  return {
    place: input.place,
    noteId: input.noteId,
    noteEdit: input.noteEdit,
    rewrite: input.rewrite,
    settings,
    calendar: sources.length > 0,
    captures: input.noteId ? !!note?.attachments?.some((a) => a.screen_capture_info) : true,
    brief,
    folderFiles: await hasFolderFiles(ctx, input.place),
    recipes: recipes.length > 0
  }
}

async function hasFolderFiles(ctx: MainContext, place: ChatPlace): Promise<boolean> {
  const has = async (folderId: string): Promise<boolean> =>
    (await ctx.attachments.list({ type: 'folder', id: folderId }).catch(() => [])).some((f) => f.kind === 'file')
  if (place.kind === 'list') return has(place.folderId)
  if (place.kind !== 'global') return false
  const state = await folders(ctx)
  for (const f of (state?.folders ?? []).slice(0, FOLDER_FILES_SCAN)) if (await has(f.id)) return true
  return false
}

// ---------- the local MCP server's library tools ----------

const meetingRowSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    date: { type: 'string', description: 'ISO 8601' },
    attendees: { type: 'array', items: { type: 'string' } }
  },
  required: ['id', 'title', 'date', 'attendees']
}
const meetingListSchema = {
  type: 'object',
  properties: { count: { type: 'integer' }, meetings: { type: 'array', items: meetingRowSchema } },
  required: ['count', 'meetings']
}

const LIBRARY_OUTPUT: Record<LibraryToolName, Record<string, unknown>> = {
  getCurrentTime: {
    type: 'object',
    properties: { iso: { type: 'string' }, timeZone: { type: 'string' }, local: { type: 'string' } },
    required: ['iso', 'timeZone', 'local']
  },
  listMeetings: meetingListSchema,
  findMeetingsByTerms: meetingListSchema,
  findMeetingsWithPeople: meetingListSchema,
  gatherMeetingContext: meetingListSchema,
  getMeetings: {
    type: 'object',
    properties: {
      found: { type: 'integer' },
      notFound: { type: 'array', items: { type: 'string' } },
      meetings: { type: 'array', items: meetingRowSchema }
    },
    required: ['found', 'notFound', 'meetings']
  },
  readMeetings: {
    type: 'object',
    properties: {
      read: { type: 'integer' },
      notFound: { type: 'array', items: { type: 'string' } },
      meetings: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, title: { type: 'string' }, date: { type: 'string' }, source: PAYLOAD_SOURCE_SCHEMA },
          required: ['id', 'title', 'date', 'source']
        }
      }
    },
    required: ['read', 'notFound', 'meetings']
  },
  readTranscript: {
    type: 'object',
    properties: {
      windows: { type: 'integer' },
      meeting: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } }, required: ['id', 'title'] }
    },
    required: ['windows', 'meeting']
  },
  findFolders: {
    type: 'object',
    properties: {
      folders: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, title: { type: 'string' }, noteCount: { type: 'integer' }, parentId: { type: ['string', 'null'] } },
          required: ['id', 'title', 'noteCount', 'parentId']
        }
      }
    },
    required: ['folders']
  },
  locateNotes: {
    type: 'object',
    properties: {
      notes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            folders: {
              type: 'array',
              items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } }, required: ['id', 'title'] }
            }
          },
          required: ['id', 'folders']
        }
      }
    },
    required: ['notes']
  }
}

const LIBRARY_NAMES = Object.keys(LIBRARY_OUTPUT) as LibraryToolName[]

// ---------- the registry ----------

export class ToolRegistry {
  private readonly providers = new Map<string, ChatToolProvider>()

  constructor(private readonly ctx: MainContext) {}

  register(p: ChatToolProvider): () => void {
    if (!p || typeof p.id !== 'string' || typeof p.tools !== 'function' || typeof p.run !== 'function') {
      throw new Error('A chat tool provider needs an id, tools() and run().')
    }
    this.providers.set(p.id, p)
    log('info', 'chat:tool-provider-registered', { id: p.id })
    return () => {
      if (this.providers.get(p.id) === p) {
        this.providers.delete(p.id)
        log('info', 'chat:tool-provider-unregistered', { id: p.id })
      }
    }
  }

  /** Each provider's tools for one answer (called once per answer; a slow or failing provider is skipped). */
  async providerTools(ctx: { place: ChatPlace; noteId: string | null }): Promise<ProviderTools[]> {
    const out: ProviderTools[] = []
    for (const provider of this.providers.values()) {
      try {
        const specs = await Promise.race([
          provider.tools(ctx),
          new Promise<never>((_r, reject) => setTimeout(() => reject(new Error('timed out')), PROVIDER_TOOLS_TIMEOUT_MS))
        ])
        out.push({ provider, specs: Array.isArray(specs) ? specs : [] })
      } catch (err) {
        log('warn', 'chat:tool-provider-failed', { id: provider.id, err: parseError(err).message })
      }
    }
    return out
  }

  /** The local tools whose rule holds, then the providers' (a name already taken is skipped). */
  build(a: ToolAvailability, providers: ProviderTools[]): AnswerTools {
    const entries = new Map<string, ToolEntry>()
    for (const t of LOCAL) {
      if (t.available(a)) entries.set(t.def.name, { spec: localSpec(t), local: t, provider: null })
    }
    for (const { provider, specs } of providers) {
      for (const spec of specs) {
        const name = spec?.def?.name
        if (typeof name !== 'string' || !name || entries.has(name)) continue
        entries.set(name, { spec, local: null, provider })
      }
    }
    return { defs: [...entries.values()].map((e) => e.spec.def), entries }
  }

  /** A tool by name whatever its availability rule (a decision that outlived its answer). */
  async find(name: string, ctx: { place: ChatPlace; noteId: string | null }): Promise<ToolEntry | null> {
    const t = LOCAL.find((x) => x.def.name === name)
    if (t) return { spec: localSpec(t), local: t, provider: null }
    for (const { provider, specs } of await this.providerTools(ctx)) {
      const spec = specs.find((x) => x?.def?.name === name)
      if (spec) return { spec, local: null, provider }
    }
    return null
  }

  /** Runs one call on its owner. A failure is a tool error for the model, never a crash. */
  async run(entry: ToolEntry, name: string, args: Record<string, unknown> | null, env: ToolEnv, onProgress?: (m: string) => void): Promise<ToolOutcome> {
    if (entry.local) return runLocalTool(entry.local, args, env)
    if (!entry.provider) return fail(`Unknown tool ${name}.`)
    if (args === null) return fail('The tool input was not valid JSON. Send the arguments again as one JSON object.')
    try {
      const r = await entry.provider.run(name, args, { signal: env.signal, threadId: env.threadId, ...(onProgress ? { onProgress } : {}) })
      return { content: typeof r.content === 'string' ? r.content : '', isError: r.isError === true, result: r.data ?? null }
    } catch (err) {
      log('warn', 'chat:provider-tool-failed', { provider: entry.provider.id, tool: name, err: parseError(err).message })
      return fail(parseError(err).message || 'The tool failed.')
    }
  }

  /** `ctx.chat`. */
  api(): ChatApi {
    return {
      registerToolProvider: (p) => this.register(p),
      libraryTools: () =>
        LIBRARY_NAMES.map((name) => {
          const t = LOCAL.find((x) => x.def.name === name) as LocalTool
          return { name, title: t.title, description: t.def.description, inputSchema: t.def.inputSchema, outputSchema: LIBRARY_OUTPUT[name] }
        }),
      runLibraryTool: async (name, args, signal): Promise<ChatToolResult> => {
        const t = LIBRARY_NAMES.includes(name) ? LOCAL.find((x) => x.def.name === name) : undefined
        if (!t) return { content: `Unknown tool ${String(name)}.`, isError: true }
        const env: ToolEnv = {
          ctx: this.ctx,
          place: { kind: 'global' },
          threadId: `mcp:${randomUUID()}`,
          signal,
          noteId: null,
          target: null,
          latestSummaryPanelId: null,
          rewriteStarted: false,
          scanned: new Map(),
          windows: new Map()
        }
        const out = await runLocalTool(t, args && typeof args === 'object' && !Array.isArray(args) ? args : null, env)
        return { content: out.content, data: out.result, isError: out.isError }
      }
    }
  }
}
