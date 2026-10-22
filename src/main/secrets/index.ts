// SPDX-License-Identifier: Apache-2.0
// createSecrets(): API keys as Electron safeStorage ciphertext in the encrypted
// `secrets` table. Plaintext exists only in main, only while a caller needs
// it, and never reaches a log, a file or an IPC reply (no get-key channel).
//
// Dev builds only (`!app.isPackaged`): a key that is not stored is read from
// `NOTULA_SECRET_<ID>`, the id upper-cased with dots as underscores, e.g.
// `NOTULA_SECRET_ASR_DEEPGRAM`, so transcription and summaries can be smoke-tested without the
// settings UI.

import { app, safeStorage } from 'electron'
import { notulaError, parseError } from '@shared/errors'
import { isSecretId, type SecretId } from '@shared/types/settings'
import type { SecretsApi } from '../context'
import { log } from '../log'
import type { StorageApi } from '../storage/api'
import { encryptionAvailable } from '../storage/keyfile'

/** Generous: provider keys are well under 1 KB. */
const MAX_SECRET_CHARS = 8_192
/** Provider keys travel in HTTP headers, so only printable ASCII without spaces. */
const KEY_CHARS = /^[\x21-\x7E]+$/
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/

/**
 * Why `key` (already trimmed) cannot be an API key, as a message for the user, or
 * null when it can. The message names the kind of character, never the key.
 */
export function apiKeyProblem(key: string): string | null {
  if (!key) return 'Enter an API key.'
  if (key.length > MAX_SECRET_CHARS) return 'That is too long to be an API key.'
  if (KEY_CHARS.test(key)) return null
  const bad = [...key].find((c) => !KEY_CHARS.test(c)) ?? ''
  const code = `U+${(bad.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`
  const kind = INVISIBLE.test(bad)
    ? `an invisible character (${code})`
    : /\s/.test(bad)
      ? 'a space or line break'
      : `a character that is not plain ASCII (${code})`
  return `The key contains ${kind}. Copy it again from your provider's dashboard and paste only the key.`
}

function assertId(id: unknown): asserts id is SecretId {
  if (!isSecretId(id)) throw notulaError('invalid-input', 'unknown secret id')
}

function devEnvSecret(id: SecretId): string | null {
  if (app.isPackaged) return null
  const value = process.env[`NOTULA_SECRET_${id.toUpperCase().replaceAll('.', '_')}`]?.trim()
  return value ? value : null
}

export function createSecrets(storage: StorageApi): SecretsApi {
  async function stored(id: SecretId): Promise<string | null> {
    let blob: Uint8Array | null
    try {
      blob = await storage.getSecretBlob(id)
    } catch (err) {
      if (parseError(err).code === 'storage-unavailable') return null
      throw err
    }
    if (!blob) return null
    try {
      return safeStorage.decryptString(Buffer.from(blob))
    } catch {
      log('error', 'secrets:decrypt-failed', { id })
      return null
    }
  }

  async function get(id: SecretId): Promise<string | null> {
    assertId(id)
    return (await stored(id)) ?? devEnvSecret(id)
  }

  return {
    get,
    has: async (id) => (await get(id)) !== null,
    set: async (id, value) => {
      assertId(id)
      const key = typeof value === 'string' ? value.trim() : ''
      const problem = apiKeyProblem(key)
      if (problem) throw notulaError('invalid-input', problem)
      if (!encryptionAvailable()) throw notulaError('storage-unavailable', 'secure storage is not available')
      await storage.setSecretBlob(id, new Uint8Array(safeStorage.encryptString(key)))
      log('info', 'secrets:set', { id })
    },
    clear: async (id) => {
      assertId(id)
      await storage.deleteSecretBlob(id)
      log('info', 'secrets:cleared', { id })
    }
  }
}
