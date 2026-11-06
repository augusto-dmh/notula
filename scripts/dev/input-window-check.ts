// SPDX-License-Identifier: Apache-2.0
// Dev-only check for the known input windows and the budgets derived from them
// (src/main/llm/input-window.ts), and for the token-usage mappings (src/main/llm/usage.ts).
// Pure: no provider, no network.
// Run: node scripts/dev/input-window-check.ts   (Node's type stripping; exits 1 on a failure)

const { knownInputWindow, transcriptBudgetChars, digestBudgetChars } = await import('../../src/main/llm/input-window.ts')
const { openAiUsage, anthropicUsage } = await import('../../src/main/llm/usage.ts')

let failed = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}

const MILLION = 1_048_576
for (const id of [
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
  'gemini-2.5-pro',
  'models/gemini-3.8-flash',
  'google/gemini-3.8-flash',
  'gemini-3.8-flash-preview',
  'gemini-3.5-flash-lite-preview-06-17',
  'gemini-2.0-flash-001',
  'gemini-1.5-pro-latest',
  'gemini-4-pro-exp'
]) {
  check(`knownInputWindow('${id}')`, knownInputWindow(id), MILLION)
}
for (const id of [
  'gemini-3.8-flash-image',
  'gemini-3.8-flash-image-preview',
  'gemini-3.8-flash-preview-tts',
  'gemini-3.8-flash-live-001',
  'gemini-embedding-001',
  'gpt-5',
  'gemma3',
  ''
]) {
  check(`knownInputWindow('${id}')`, knownInputWindow(id), null)
}

check('transcriptBudgetChars(1,048,576)', transcriptBudgetChars(MILLION), 600_000)
check('transcriptBudgetChars(null)', transcriptBudgetChars(null), 56_000)
check('transcriptBudgetChars(8,192)', transcriptBudgetChars(8_192), 14_336)
check('transcriptBudgetChars(200,000)', transcriptBudgetChars(200_000), 350_000)
check('transcriptBudgetChars(1,000)', transcriptBudgetChars(1_000), 4_000)
check('digestBudgetChars(1,048,576)', digestBudgetChars(MILLION), 400_000)
check('digestBudgetChars(null)', digestBudgetChars(null), 96_000)

check(
  'openAiUsage, full',
  openAiUsage({
    prompt_tokens: 1200,
    completion_tokens: 300,
    completion_tokens_details: { reasoning_tokens: 120 },
    prompt_tokens_details: { cached_tokens: 800 }
  }),
  { in: 1200, out: 300, reasoning: 120, cached: 800 }
)
check('openAiUsage, no details', openAiUsage({ prompt_tokens: 50, completion_tokens: 7 }), { in: 50, out: 7, reasoning: null, cached: null })
check(
  'anthropicUsage',
  anthropicUsage({ input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 512, cache_creation_input_tokens: 0 }),
  { in: 900, out: 40, reasoning: null, cached: 512 }
)
const none = { in: null, out: null, reasoning: null, cached: null }
check('openAiUsage(undefined)', openAiUsage(undefined), none)
check('anthropicUsage(undefined)', anthropicUsage(undefined), none)

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
