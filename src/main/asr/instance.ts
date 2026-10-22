// SPDX-License-Identifier: Apache-2.0
// The app-wide local model manager and the worker entry paths. Created
// by whichever register function needs it first: the transcription registry (wired
// before registerLocalAsr) or registerLocalAsr itself.

import { basename, dirname, join } from 'node:path'
import { net } from 'electron'
import type { MainContext } from '../context'
import { LocalModelManager } from './models'

let models: LocalModelManager | null = null

export function getLocalModels(ctx: MainContext): LocalModelManager {
  if (!models) {
    models = new LocalModelManager({
      root: join(ctx.userDataPath, 'models'),
      fetch: (url, init) => net.fetch(url, init),
      busyReason: (id) => {
        // Read at call time: capture is wired before this runs.
        if (ctx.capture.isCapturing()) return 'a meeting is being transcribed'
        if (models?.inUse(id)) return id === 'diarization-en' ? 'speakers are being separated' : 'a meeting is being transcribed'
        return null
      }
    })
  }
  return models
}

/** The manager once something created it; null before (`localCovers` reads it). */
export function existingLocalModels(): LocalModelManager | null {
  return models
}

/** out/main/<name>.js, from the main bundle (or a shared chunk next to it). */
export function workerPath(name: 'asr' | 'diarize'): string {
  const here = basename(__dirname) === 'chunks' ? dirname(__dirname) : __dirname
  return join(here, `${name}.js`)
}

/**
 * The workers' environment: no dev-only secrets, and on macOS the platform
 * package's folder on DYLD_LIBRARY_PATH so the addon finds its dylibs.
 */
export function workerEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('NOTULA_SECRET_')) env[k] = v
  }
  if (process.platform === 'darwin') {
    try {
      const pkg = dirname(require.resolve(`sherpa-onnx-darwin-${process.arch}/package.json`)).replace(
        /app\.asar([\\/])/,
        'app.asar.unpacked$1'
      )
      env['DYLD_LIBRARY_PATH'] = env['DYLD_LIBRARY_PATH'] ? `${pkg}:${env['DYLD_LIBRARY_PATH']}` : pkg
    } catch {
      // The addon reports its own load error.
    }
  }
  return env
}
