// SPDX-License-Identifier: Apache-2.0
// Dev-only fixture: inline code and bare filenames (`AGENTS.md`, `README.md`,
// `package.json`, `config.ts`) survive the markdown → editor → copy path. Bundles
// `markdown-fixture-page.ts` with Vite and runs it in a hidden Electron window (the editor
// needs a DOM); no app, no storage.
// Run: npx electron scripts/dev/markdown-fixture.mjs   (exits 1 on a failure)

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'
import { build } from 'vite'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))

async function main() {
  const out = mkdtempSync(join(tmpdir(), 'notula-md-fixture-'))
  let code = 1
  try {
    await build({
      configFile: false,
      logLevel: 'warn',
      root,
      resolve: { alias: { '@shared': resolve(root, 'src/shared') }, dedupe: ['yjs'] },
      define: { 'import.meta.env.DEV': 'false' },
      build: {
        outDir: out,
        emptyOutDir: false,
        minify: false,
        lib: { entry: resolve(root, 'scripts/dev/markdown-fixture-page.ts'), formats: ['iife'], name: 'fixture', fileName: () => 'fixture.js' }
      }
    })
    writeFileSync(join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><body><script src="./fixture.js"></script></body>')

    await app.whenReady()
    const win = new BrowserWindow({ show: false })
    const result = new Promise((done) => {
      win.webContents.on('console-message', (e) => {
        const line = e.message
        if (line.startsWith('FIXTURE-RESULT ')) done(JSON.parse(line.slice('FIXTURE-RESULT '.length)))
        else if (line.startsWith('FIXTURE-')) console.log(line)
        else if (e.level === 'error') console.log(`[page] ${line}`)
      })
    })
    await win.loadFile(join(out, 'index.html'))
    const timeout = new Promise((_, fail) => setTimeout(() => fail(new Error('the fixture page timed out')), 20_000))
    const results = await Promise.race([result, timeout])
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.detail ?? ''}`}`)
    const failed = results.filter((r) => !r.ok).length
    console.log(failed ? `\n${failed} of ${results.length} checks failed` : `\nall ${results.length} checks passed`)
    code = failed ? 1 : 0
  } catch (err) {
    console.error(err)
  } finally {
    rmSync(out, { recursive: true, force: true })
    app.exit(code)
  }
}

// Not a top-level await: Electron fires `ready` only once the entry module has evaluated.
void main()
