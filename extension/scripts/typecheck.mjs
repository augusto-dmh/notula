// SPDX-License-Identifier: Apache-2.0
// Type-checks the extension with the repo's own TypeScript (no copy in extension/).
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc')

export function typecheck() {
  const r = spawnSync(process.execPath, [tsc, '--noEmit', '-p', join(here, '..', 'tsconfig.json')], { stdio: 'inherit' })
  return r.status === 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(typecheck() ? 0 : 1)
}
