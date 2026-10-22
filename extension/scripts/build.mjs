// SPDX-License-Identifier: Apache-2.0
// Builds the extension: type check, bundle each entry with the repo's own Vite (classic
// IIFE scripts: content scripts can't be modules), then one package per target:
//   chrome  Chrome Web Store upload, `store: cws`, no `key`
//   edge    Edge Add-ons upload, `store: edge`, no `key`
//   dev     load-unpacked build with the committed public `key`, so its id is fixed
// Store uploads must not carry `key`: each store assigns the id. The build checks that.
//
// The store packages need the publisher's contact email (store/publisher.json) for their privacy
// page. Without it, no store package is built: `build` makes the dev package only and says so
// loudly, and `build:store` (`--store`) fails. Only the dev package may ship without a contact.
//
// Output (git-ignored): extension/dist/<target>/ and extension/dist/notula-extension-<version>-<target>.zip,
// plus dist/ids.json with the extension ids Notula's host manifest must allow.
//
// Usage: npm --prefix extension run build [-- --no-typecheck]
//        npm --prefix extension run build:store [-- --no-typecheck]   (chrome and edge only; needs the email)

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { typecheck } from './typecheck.mjs'
import { zip, zipNames } from './zip.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const src = join(root, 'src')
const dist = join(root, 'dist')
const stage = join(dist, '.stage')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
/** Replaced per target after bundling, so the bundles are built once. */
const STORE_TOKEN = '__NOTULA_EXT_STORE_TOKEN__'

const TARGETS = [
  { name: 'chrome', store: 'cws', key: false },
  { name: 'edge', store: 'edge', key: false },
  { name: 'dev', store: 'dev', key: true }
]

const ENTRIES = [
  { entry: 'background/index.ts', out: 'background.js' },
  { entry: 'content/reader.ts', out: 'content/reader.js' },
  { entry: 'content/youtube-main.ts', out: 'content/youtube-main.js' },
  { entry: 'popup/popup.ts', out: 'popup.js' },
  { entry: 'options/options.ts', out: 'options.js' }
]

const STATIC = [
  ['popup/popup.html', 'popup.html'],
  ['popup/popup.css', 'popup.css'],
  ['options/options.html', 'options.html'],
  ['options/options.css', 'options.css'],
  ['ui/base.css', 'base.css']
]

/** Open Notula's deep link; the dev package uses a dev build's scheme (src/main/lifecycle/deeplinks.ts). */
const OPEN_LINK = 'notula://open'
const OPEN_LINK_DEV = 'notula-dev://open'

const YOUTUBE = ['https://www.youtube.com/*', 'https://m.youtube.com/*']
const storeOnly = process.argv.includes('--store')

function fail(msg) {
  console.error(`extension build: ${msg}`)
  process.exit(1)
}

if (!/^1\.\d+\.\d+$/.test(version)) fail(`version ${version} must be 1.<minor>.<patch>: the extension's own version track`)

function manifest(target, devKey) {
  const m = {
    manifest_version: 3,
    name: '__MSG_extName__',
    short_name: 'Notula',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    version,
    minimum_chrome_version: '116',
    icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
    action: {
      default_title: '__MSG_actionTitle__',
      default_popup: 'popup.html',
      default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' }
    },
    background: { service_worker: 'background.js' },
    permissions: ['nativeMessaging', 'storage', 'scripting', 'activeTab'],
    host_permissions: YOUTUBE,
    optional_host_permissions: ['https://*/*'],
    // The YouTube main-world script (content/youtube-main.js) isn't static: the service worker
    // registers it only after the first-run explanation is accepted (background/sites.ts).
    content_scripts: [
      { matches: YOUTUBE, js: ['content/reader.js'], run_at: 'document_start', all_frames: true }
    ],
    commands: {
      'mark-moment': { suggested_key: { default: 'Alt+Shift+M' }, description: '__MSG_commandMark__' }
    },
    options_ui: { page: 'options.html', open_in_tab: true }
  }
  if (target.key) m.key = devKey
  return m
}

/** Chromium's id for a public key: SHA-256 of the DER key, first 32 hex digits mapped to a–p. */
function extensionId(base64Key) {
  const hex = createHash('sha256').update(Buffer.from(base64Key, 'base64')).digest('hex').slice(0, 32)
  return [...hex].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join('')
}

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

async function bundle() {
  rmSync(stage, { recursive: true, force: true })
  for (const { entry, out } of ENTRIES) {
    await build({
      configFile: false,
      logLevel: 'warn',
      publicDir: false,
      define: { __EXT_STORE__: JSON.stringify(STORE_TOKEN) },
      build: {
        outDir: stage,
        emptyOutDir: false,
        copyPublicDir: false,
        target: 'chrome116',
        // Readable output helps store review; minifying isn't needed for size here.
        minify: false,
        sourcemap: false,
        reportCompressedSize: false,
        lib: {
          entry: join(src, entry),
          formats: ['iife'],
          name: `notula_${out.replace(/\W/g, '_')}`,
          fileName: () => out
        }
      }
    })
    if (!existsSync(join(stage, out))) fail(`bundle missing: ${out}`)
  }
}

function assemble(target, devKey) {
  const dir = join(dist, target.name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  cpSync(stage, dir, { recursive: true })
  const bg = join(dir, 'background.js')
  const code = readFileSync(bg, 'utf8')
  if (!code.includes(STORE_TOKEN)) fail('store token not found in background.js')
  writeFileSync(bg, code.split(STORE_TOKEN).join(target.store))
  for (const f of walk(dir)) {
    if (readFileSync(f, 'utf8').includes(STORE_TOKEN)) fail(`store token left in ${relative(dir, f)}`)
  }
  for (const [from, to] of STATIC) cpSync(join(src, from), join(dir, to))
  if (target.store === 'dev') {
    // Only a dev build of Notula accepts the dev id, and it registers `notula-dev`, not `notula`:
    // Open Notula would otherwise start an installed release instead of the build under test.
    for (const page of ['popup.html', 'options.html']) {
      const p = join(dir, page)
      const html = readFileSync(p, 'utf8')
      if (!html.includes(OPEN_LINK)) fail(`${OPEN_LINK} not found in ${page}`)
      writeFileSync(p, html.split(OPEN_LINK).join(OPEN_LINK_DEV))
    }
  }
  cpSync(join(root, '_locales'), join(dir, '_locales'), { recursive: true })
  cpSync(join(root, 'icons'), join(dir, 'icons'), { recursive: true })
  writeFileSync(join(dir, 'privacy.html'), privacyPage(publisherEmail()))
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest(target, devKey), null, 2) + '\n')
  return dir
}

/** The publisher's contact email (store/publisher.json), or null while it's a placeholder. */
function publisherEmail() {
  const { email } = JSON.parse(readFileSync(join(root, 'store', 'publisher.json'), 'utf8'))
  if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null
  if (/@(example\.(com|org|net)|localhost)$/i.test(email) || /PUBLISHER_EMAIL/.test(email)) return null
  return email
}

/** The privacy page with the contact filled in; the dev package says it has none. */
function privacyPage(email) {
  const page = readFileSync(join(root, 'store', 'privacy-policy.html'), 'utf8')
  if (email) return page.split('PUBLISHER_EMAIL').join(email)
  return page.replace(
    '<a href="mailto:PUBLISHER_EMAIL">PUBLISHER_EMAIL</a>',
    'no contact in this development build'
  )
}

function pack(target, dir) {
  const files = walk(dir).map((p) => ({ name: relative(dir, p).replace(/\\/g, '/'), data: readFileSync(p) }))
  const buf = zip(files)
  const names = zipNames(buf)
  if (!names.includes('manifest.json')) fail(`${target.name}: manifest.json is not at the zip root`)
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  if (target.key !== ('key' in m)) fail(`${target.name}: manifest key presence is wrong`)
  const file = join(dist, `notula-extension-${version}-${target.name}.zip`)
  writeFileSync(file, buf)
  return { file, entries: names.length, bytes: buf.length }
}

if (!process.argv.includes('--no-typecheck')) {
  if (!typecheck()) fail('type check failed')
}

const devKey = readFileSync(join(root, 'keys', 'dev-public-key.txt'), 'utf8').trim()
const storeIds = JSON.parse(readFileSync(join(root, 'store', 'ids.json'), 'utf8'))
mkdirSync(dist, { recursive: true })
await bundle()
const email = publisherEmail()
const results = []
const refused = []
for (const target of TARGETS) {
  if (storeOnly && target.key) continue
  if (!target.key && !email) {
    // Never leave an older store package behind that could be uploaded by mistake.
    rmSync(join(dist, target.name), { recursive: true, force: true })
    rmSync(join(dist, `notula-extension-${version}-${target.name}.zip`), { force: true })
    refused.push(target.name)
    continue
  }
  const dir = assemble(target, devKey)
  if (!target.key && readFileSync(join(dir, 'privacy.html'), 'utf8').includes('PUBLISHER_EMAIL')) fail(`${target.name}: privacy page still has the email placeholder`)
  results.push({ target: target.name, ...pack(target, dir) })
}
rmSync(stage, { recursive: true, force: true })

const ids = { dev: extensionId(devKey), cws: storeIds.cws, edge: storeIds.edge }
writeFileSync(join(dist, 'ids.json'), JSON.stringify(ids, null, 2) + '\n')

for (const r of results) console.log(`extension build: ${relative(root, r.file)} (${r.entries} files, ${r.bytes} bytes)`)
if (refused.length) {
  const line = '='.repeat(78)
  console.error(
    [
      line,
      `extension build: NO STORE PACKAGE BUILT (${refused.join(', ')}): store/publisher.json has no email.`,
      'The privacy page must name a contact before any upload. Fill in the email and run',
      `\`npm --prefix extension run build:store\`.${storeOnly ? '' : ' The dev package is built.'}`,
      line
    ].join('\n')
  )
  if (storeOnly) process.exit(1)
}
console.log(`extension build: ids dev=${ids.dev} cws=${ids.cws ?? '<CWS_ID>'} edge=${ids.edge ?? '<EDGE_ID>'}`)
