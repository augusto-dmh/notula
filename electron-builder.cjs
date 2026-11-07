// SPDX-License-Identifier: Apache-2.0
// Packaging for `npm run dist`.
//
// A JavaScript config rather than electron-builder.yml: the generic update feed is
// added only when NOTULA_UPDATE_FEED_URL is set at build time. In YAML,
// `${env.NOTULA_UPDATE_FEED_URL}` makes electron-builder fail when the variable is unset.
// Unset means the GitHub Releases feed of augusto-dmh/notula-releases; '' = no feed.

const { DEFAULT_UPDATE_FEED_URL } = require('./scripts/release/feed.cjs')
const feed = process.env.NOTULA_UPDATE_FEED_URL ?? DEFAULT_UPDATE_FEED_URL

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.notula.app',
  productName: 'Notula',
  protocols: [{ name: 'Notula', schemes: ['notula'] }],
  // Only the build output; electron-builder adds the production node_modules itself.
  // Sources, docs, analysis output and local tool settings never ship.
  // Only the three build outputs ship: scratch folders under out/ never reach the installer.
  // The SQLite addon ships its loader and one prebuild, never its C sources or build files;
  // each target keeps only its own prebuild (`${platform}` and `${arch}` expand per target).
  files: [
    'out/main/**/*',
    'out/preload/**/*',
    'out/renderer/**/*',
    'package.json',
    '!**/node_modules/better-sqlite3-multiple-ciphers/{deps,src,build}{,/**/*}',
    '!**/node_modules/better-sqlite3-multiple-ciphers/binding.gyp',
    '!**/node_modules/better-sqlite3-multiple-ciphers/prebuilds/!(${platform}-${arch}).node'
  ],
  // Both native addons are Node-API prebuilds: no @electron/rebuild step.
  npmRebuild: false,
  // Native addons and their shared libraries must load from app.asar.unpacked: the OS loader
  // cannot read a library from inside the asar archive.
  asarUnpack: ['**/node_modules/sherpa-onnx-*/**', '**/node_modules/better-sqlite3-multiple-ciphers/**'],
  // resources/ next to app.asar; the licence files into resources/licenses/, where Settings ▸ About
  // reads them and its button opens the folder.
  extraResources: [
    'resources/**',
    { from: '.', to: 'licenses', filter: ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'MODELS.md'] }
  ],
  // The app icon: resources/icon/icon.svg, rendered by scripts/icon/render.cjs.
  win: {
    target: 'nsis',
    icon: 'resources/icon/icon.ico'
  },
  // No spaces: GitHub renames release assets with spaces, which would break latest.yml.
  // The uninstaller also deletes the browser extension's two HKCU native-messaging keys.
  nsis: { artifactName: 'Notula-Setup-${version}.${ext}', include: 'src/main/sources/extension/installer.nsh' },
  // A universal build would need both darwin prebuilds; the targets here build one arch.
  mac: {
    target: ['dmg', 'zip'],
    icon: 'resources/icon/icon-512.png'
  },
  publish: feed ? { provider: 'generic', url: feed } : null
}
