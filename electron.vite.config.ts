// SPDX-License-Identifier: Apache-2.0
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import releaseFeed from './scripts/release/feed.cjs'

const { DEFAULT_UPDATE_FEED_URL } = releaseFeed

// Dependencies are externalized for main and preload by electron-vite's default
// (`build.externalizeDeps: true`), so native modules load from node_modules.
//
// Release builds (`electron-vite build --mode release`, run by `npm run dist`) minify main and
// preload, which also drops their source comments. `npm run build` (the pre-merge gate) and
// `npm run dev` stay unminified, so stack traces and the built output stay readable.
export default defineConfig(({ mode }) => {
  const release = mode === 'release'
  return {
    main: {
      resolve: { alias: { '@shared': resolve('src/shared') } },
      // The update feed is fixed at build time; unset = GitHub Releases, '' = no feed. The beta
      // feed, the feedback e-mail and the issue URL are fixed the same way.
      define: {
        __NOTULA_UPDATE_FEED_URL__: JSON.stringify(process.env['NOTULA_UPDATE_FEED_URL'] ?? DEFAULT_UPDATE_FEED_URL),
        __NOTULA_UPDATE_FEED_URL_BETA__: JSON.stringify(process.env['NOTULA_UPDATE_FEED_URL_BETA'] ?? ''),
        __NOTULA_FEEDBACK_EMAIL__: JSON.stringify(process.env['NOTULA_FEEDBACK_EMAIL'] ?? ''),
        __NOTULA_ISSUES_URL__: JSON.stringify(process.env['NOTULA_ISSUES_URL'] ?? '')
      },
      build: {
        minify: release,
        rolldownOptions: {
          // Utility processes forked by main from out/main/<name>.js: notula-storage (the
          // database), notula-asr and notula-diarize (on-device transcription and speaker
          // labels), notula-micmon (which apps use the microphone), notula-uia (meeting-app
          // speaker reader), notula-convert (attachment conversion), notula-desk (dictation's
          // OS helper), notula-voiceprint (voice matching) and notula-media (content sources'
          // media-session reader).
          input: {
            index: resolve('src/main/index.ts'),
            storage: resolve('src/main/storage/worker.ts'),
            asr: resolve('src/main/asr/worker.ts'),
            diarize: resolve('src/main/asr/diarize-worker.ts'),
            micmon: resolve('src/main/meetings/micmon-worker.ts'),
            uia: resolve('src/main/uia/worker.ts'),
            convert: resolve('src/main/attachments/convert-worker.ts'),
            desk: resolve('src/main/desk/worker.ts'),
            voiceprint: resolve('src/main/voiceprint/worker.ts'),
            media: resolve('src/main/media/worker.ts')
          }
        }
      }
    },
    preload: {
      resolve: { alias: { '@shared': resolve('src/shared') } },
      build: { minify: release }
    },
    renderer: {
      root: resolve('src/renderer'),
      resolve: {
        alias: { '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer/src') },
        // One Yjs instance: TipTap's collaboration packages and the editor must share it.
        dedupe: ['yjs']
      },
      // electron-vite leaves the renderer unminified by default.
      build: { minify: true },
      plugins: [react()]
    }
  }
})
