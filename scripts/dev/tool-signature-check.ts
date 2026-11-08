// SPDX-License-Identifier: Apache-2.0
// Dev-only check that a streamed tool call's `extra_content` (Gemini's thought signature) comes
// back unchanged on that call when the turn is replayed (src/main/llm/openai-compatible.ts), and
// that a call without one replays exactly as before. A local OpenAI-compatible mock server on
// 127.0.0.1 answers each round; no real provider, no key. Logs go to a throwaway folder.
// Run: node scripts/dev/tool-signature-check.ts   (Node's type stripping; exits 1 on a failure)

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const scratch = mkdtempSync(join(tmpdir(), 'notula-tool-signature-'))

// The app's `@shared/…` alias and extensionless imports, resolved the way the build does;
// `electron` is a stub whose userData is the scratch folder, so `log` writes there.
const electronStub = `data:text/javascript,${encodeURIComponent(`export const app = { getPath: () => ${JSON.stringify(scratch)} }`)}`
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron') return { url: electronStub, format: 'module', shortCircuit: true }
    let r
    if (specifier.startsWith('@shared/')) r = next(pathToFileURL(resolve(root, 'src/shared', `${specifier.slice(8)}.ts`)).href, context)
    else if (specifier.startsWith('.') && context.parentURL?.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) r = next(new URL(`${specifier}.ts`, context.parentURL).href, context)
    else r = next(specifier, context)
    return r.url.endsWith('.ts') ? { ...r, format: 'module-typescript' } : r
  },
  // The error classes use parameter properties, which strip-only mode refuses: app files are transformed.
  load(url, context, next) {
    const r = next(url, context)
    if (!url.endsWith('.ts') || !url.startsWith(pathToFileURL(resolve(root, 'src')).href)) return r
    const source = typeof r.source === 'string' ? r.source : Buffer.from(r.source as Uint8Array).toString('utf8')
    return { ...r, format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform' }) }
  }
})

// A dev log line also goes to stdout: it is kept for the log case instead of printed.
let logText = ''
const write = process.stdout.write.bind(process.stdout)
process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
  const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
  if (s.startsWith('{"t":')) {
    logText += s
    return true
  }
  return (write as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest)
}) as typeof process.stdout.write

const { createOpenAiCompatibleProvider } = await import(pathToFileURL(resolve(root, 'src/main/llm/openai-compatible.ts')).href)
type ChatMessage = import('../../src/main/llm/types.ts').LlmChatMessage
type ChatEvent = import('../../src/main/llm/types.ts').LlmChatEvent

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `: ${detail}`}`)
}

// ---------- the mock server ----------

/** Synthetic signatures; the real ones are opaque base64. */
const SIG_A = 'c2lnLWV4YW1wbGUtQQ=='
const SIG_B = 'c2lnLWV4YW1wbGUtQg=='

/** The SSE chunks of the first round, per case; the second round always answers with text. */
let firstRound: unknown[] = []
const bodies: string[] = []

const server = createServer((req, res) => {
  let raw = ''
  req.setEncoding('utf8')
  req.on('data', (c: string) => (raw += c))
  req.on('end', () => {
    bodies.push(raw)
    const chunks =
      bodies.length % 2 === 1
        ? firstRound
        : [{ choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const c of chunks) res.write(`data: ${JSON.stringify({ model: 'example-model', ...(c as object) })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
})
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
const port = (server.address() as { port: number }).port

const provider = createOpenAiCompatibleProvider({
  id: 'local',
  baseUrl: `http://127.0.0.1:${port}/v1`,
  model: 'example-model',
  getKey: null,
  acceptsImages: false
})

const TOOLS = [
  {
    name: 'search_notes',
    description: 'Searches notes.',
    inputSchema: { type: 'object' as const, properties: { query: { type: 'string' } }, required: ['query'] }
  }
]

/** One answer the way the chat engine runs it: a tool round, the results, then the follow-up round. */
async function answer(chunks: unknown[]): Promise<{ first: string; second: string; ends: string[] }> {
  firstRound = chunks
  const transcript: ChatMessage[] = [{ role: 'user', content: 'Find the example notes.' }]
  const req = () => ({ purpose: 'chat' as const, system: 'You are a test.', messages: transcript, tools: TOOLS, maxTokens: 256 })
  const ends: string[] = []
  let replay: unknown
  let text = ''
  for await (const ev of provider.chat(req(), AbortSignal.timeout(10_000)) as AsyncIterable<ChatEvent>) {
    if (ev.type === 'tool_call_end') ends.push(ev.id)
    if (ev.type === 'text') text += ev.delta
    if (ev.type === 'stop') replay = ev.replay
  }
  transcript.push({ role: 'assistant', content: text, toolCalls: ends.map((id) => ({ id, name: 'search_notes', args: {} })), replay })
  for (const id of ends) transcript.push({ role: 'tool', toolCallId: id, name: 'search_notes', content: '[]' })
  for await (const _ of provider.chat(req(), AbortSignal.timeout(10_000))) void _
  return { first: bodies[bodies.length - 2], second: bodies[bodies.length - 1], ends }
}

const call = (index: number, id: string | undefined, name: string | undefined, args: string, extra?: unknown) => ({
  choices: [
    {
      index: 0,
      delta: {
        tool_calls: [{ index, ...(id ? { id, type: 'function' } : {}), function: { ...(name ? { name } : {}), arguments: args }, ...(extra !== undefined ? { extra_content: extra } : {}) }]
      }
    }
  ]
})
const finish = { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
const replayedCalls = (body: string) => (JSON.parse(body).messages as { role: string; tool_calls?: Record<string, unknown>[] }[]).find((m) => m.role === 'assistant')?.tool_calls ?? []

// ---------- case 1: one call with a signature ----------

const signed = await answer([call(0, 'call_1', 'search_notes', '{"query":', { google: { thought_signature: SIG_A } }), call(0, undefined, undefined, '"example"}'), finish])
const signedCalls = replayedCalls(signed.second)
check('a signed call runs', signed.ends.length === 1)
check(
  'the replayed call carries the identical extra_content',
  JSON.stringify(signedCalls[0]?.extra_content) === JSON.stringify({ google: { thought_signature: SIG_A } }),
  JSON.stringify(signedCalls[0]?.extra_content)
)
check('the replayed call keeps its id, name and raw arguments', signedCalls[0]?.id === 'call_1' && JSON.stringify(signedCalls[0]?.function) === JSON.stringify({ name: 'search_notes', arguments: '{"query":"example"}' }))

// ---------- case 2: the same call without one ----------

const plain = await answer([call(0, 'call_1', 'search_notes', '{"query":'), call(0, undefined, undefined, '"example"}'), finish])
// Today's follow-up request, written out field by field.
const today = JSON.stringify({
  model: 'example-model',
  messages: [
    { role: 'system', content: 'You are a test.' },
    { role: 'user', content: 'Find the example notes.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_notes', arguments: '{"query":"example"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '[]' }
  ],
  stream: true,
  stream_options: { include_usage: true },
  tools: [{ type: 'function', function: { name: 'search_notes', description: 'Searches notes.', parameters: TOOLS[0].inputSchema } }],
  tool_choice: 'auto',
  max_tokens: 256
})
check('an unsigned call replays as today, byte for byte', plain.second === today, plain.second)
check('the first request is the same with or without a signature', plain.first === signed.first)
const stripped = JSON.parse(signed.second) as { messages: { tool_calls?: Record<string, unknown>[] }[] }
for (const m of stripped.messages) for (const c of m.tool_calls ?? []) delete c.extra_content
check('the signed follow-up differs only by extra_content', JSON.stringify(stripped) === plain.second)

// ---------- case 3: a signature in parts, and a parallel call without one ----------

const parallel = await answer([
  call(0, 'call_1', 'search_notes', '', { google: { thought_signature: SIG_B } }),
  call(0, undefined, undefined, '{"query":"one"}', { google: { note: 'example' } }),
  call(1, 'call_2', 'search_notes', '{"query":"two"}'),
  finish
])
const parallelCalls = replayedCalls(parallel.second)
check(
  'parts of one extra_content merge on their call',
  JSON.stringify(parallelCalls[0]?.extra_content) === JSON.stringify({ google: { thought_signature: SIG_B, note: 'example' } }),
  JSON.stringify(parallelCalls[0]?.extra_content)
)
check('the parallel call without one sends no extra_content', parallelCalls.length === 2 && !('extra_content' in parallelCalls[1]))

// ---------- logs ----------

try {
  logText += readFileSync(join(scratch, 'logs', 'app.log'), 'utf8')
} catch {
  // No log file: only the stdout lines count.
}
check('the log saw the rounds', logText.includes('llm:usage'))
check('no signature reaches the log', !logText.includes(SIG_A) && !logText.includes(SIG_B) && !logText.includes('thought_signature'))

server.close()
rmSync(scratch, { recursive: true, force: true })
if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall passed')
