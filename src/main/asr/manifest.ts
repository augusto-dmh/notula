// SPDX-License-Identifier: Apache-2.0
// The local model manifest. Adding or changing a model is a deliberate manifest change.
// Every file comes from its upstream publisher's public release and is pinned by SHA-256;
// Notula never downloads executable code.
//
// Member paths are relative to the archive's single top-level directory, checked against
// the real tar listing on the first download; a mismatch is fixed in the manifest, never
// with a code workaround.

import { localAsrModelInfo, type LocalModelId } from '@shared/types/transcript'

/** One verified file; `path` is relative to the model directory. */
export interface ModelFile {
  path: string
  bytes: number
  sha256: string
}

export interface ModelDownload {
  url: string
  bytes: number
  /** The streamed SHA-256 of the download itself. */
  sha256: string
  /** Content-Length or streamed bytes above this fail at once. */
  capBytes: number
  timeoutMs: number
  /** `archive`: a .tar.bz2 extracted with the OS `tar`, then each member verified; `file`: itself. */
  kind: 'archive' | 'file'
  members: ModelFile[]
}

export interface ModelManifestEntry {
  id: LocalModelId
  /** `speaker-id`: the speaker identification extractor, separate from diarization's clustering model. */
  kind: 'asr' | 'diarization' | 'speaker-id'
  /** Base codes, plus `multi` (LOCAL_ASR_MODELS for the speech models). */
  languages: readonly string[]
  /** Empty for an alias. */
  downloads: ModelDownload[]
  /** The sum of the downloads' bytes (the progress total). */
  totalBytes: number
  /** Set: this model is one file of another, with no download and no copy of its own. */
  alias?: ModelAlias
}

/**
 * A model that is one member file of another model: it shares that model's download,
 * folder, state and progress, and is ready when that model is.
 */
export interface ModelAlias {
  of: LocalModelId
  /** The member's path inside `of`. */
  path: string
}

/**
 * Speaker profiles: true makes `speaker-id` an alias of the WeSpeaker ResNet-34 file inside
 * `diarization-en` (no second download and no second copy; ready with it; its model id is that
 * file's SHA-256). False until a benchmark result picks ResNet-34; the calibration file's
 * `modelSha` changes with it.
 */
const SPEAKER_ID_IS_RESNET34_ALIAS: boolean = false

const MiB = 1024 * 1024

export const MODEL_MANIFEST: Record<LocalModelId, ModelManifestEntry> = {
  'parakeet-tdt-110m-en-int8': {
    id: 'parakeet-tdt-110m-en-int8',
    kind: 'asr',
    languages: localAsrModelInfo('parakeet-tdt-110m-en-int8').languages,
    downloads: [
      {
        url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8.tar.bz2',
        bytes: 108_035_095,
        sha256: 'f628312e9fdf8686374cb01a69425c41732529d540860311f16f37cbc32cfe9b',
        capBytes: 200 * MiB,
        timeoutMs: 600_000,
        kind: 'archive',
        members: [
          {
            path: 'encoder.int8.onnx',
            bytes: 131_113_202,
            sha256: '0f35509ddeb9b39002fb077d979a9fe74f06eb0bc4dd5c34f512f82e5111d657'
          },
          {
            path: 'decoder.int8.onnx',
            bytes: 3_955_863,
            sha256: 'f7c331c5504c2e593c76ed22b728e3f554af6c4a383dde862e719ced08b1da19'
          },
          {
            path: 'joiner.int8.onnx',
            bytes: 1_411_403,
            sha256: 'bf7dff69e9f2cdbe9943d70da358f38b361c115ba0105bae7e908e0d6ec782f6'
          },
          {
            path: 'tokens.txt',
            bytes: 9_953,
            sha256: '450e56bd2f036fe5b6aa821865838cc5aa9d8b0106134ce9a9ba0664abe6cd10'
          }
        ]
      }
    ],
    totalBytes: 108_035_095
  },
  // The multilingual models, each its own user-started download.
  'parakeet-tdt-0.6b-v3-int8': {
    id: 'parakeet-tdt-0.6b-v3-int8',
    kind: 'asr',
    languages: localAsrModelInfo('parakeet-tdt-0.6b-v3-int8').languages,
    downloads: [
      {
        url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2',
        bytes: 487_170_055,
        sha256: '5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf',
        capBytes: 600 * MiB,
        timeoutMs: 1_800_000,
        kind: 'archive',
        members: [
          {
            path: 'encoder.int8.onnx',
            bytes: 652_184_281,
            sha256: 'acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247'
          },
          {
            path: 'decoder.int8.onnx',
            bytes: 11_845_275,
            sha256: '179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e'
          },
          {
            path: 'joiner.int8.onnx',
            bytes: 6_355_277,
            sha256: '3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3'
          },
          {
            path: 'tokens.txt',
            bytes: 93_939,
            sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d'
          }
        ]
      }
    ],
    totalBytes: 487_170_055
  },
  'whisper-large-v3-turbo-int8': {
    id: 'whisper-large-v3-turbo-int8',
    kind: 'asr',
    languages: localAsrModelInfo('whisper-large-v3-turbo-int8').languages,
    downloads: [
      {
        url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-turbo.tar.bz2',
        bytes: 563_790_207,
        sha256: 'b11acbbcd660b44a8e0df33724feb5aaa709cf65668f2823d59f656312544f22',
        capBytes: 700 * MiB,
        timeoutMs: 1_800_000,
        kind: 'archive',
        members: [
          {
            path: 'turbo-encoder.int8.onnx',
            bytes: 674_716_297,
            sha256: 'b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b'
          },
          {
            path: 'turbo-decoder.int8.onnx',
            bytes: 361_080_764,
            sha256: '20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547'
          },
          {
            path: 'turbo-tokens.txt',
            bytes: 816_730,
            sha256: 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126'
          }
        ]
      }
    ],
    totalBytes: 563_790_207
  },
  'diarization-en': {
    id: 'diarization-en',
    kind: 'diarization',
    languages: ['en'],
    downloads: [
      {
        url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2',
        bytes: 6_958_444,
        sha256: '24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488',
        capBytes: 16 * MiB,
        timeoutMs: 600_000,
        kind: 'archive',
        members: [
          {
            path: 'model.onnx',
            bytes: 5_992_913,
            sha256: '220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079'
          }
        ]
      },
      {
        // "recongition" is the upstream release tag's spelling.
        url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34.onnx',
        bytes: 26_534_365,
        sha256: '5ef208a9da1453335308a6b6f4e6dfbd7e183a38b604de0a57664f45d257fe94',
        capBytes: 40 * MiB,
        timeoutMs: 600_000,
        kind: 'file',
        members: [
          {
            path: 'wespeaker_en_voxceleb_resnet34.onnx',
            bytes: 26_534_365,
            sha256: '5ef208a9da1453335308a6b6f4e6dfbd7e183a38b604de0a57664f45d257fe94'
          }
        ]
      }
    ],
    totalBytes: 6_958_444 + 26_534_365
  },
  // Speaker identification: CAM++ zh-en advanced, 192-dim, Apache-2.0
  // (ModelScope iic/speech_campplus_sv_zh_en_16k-common_advanced). Downloaded only when the user
  // turns on a voice row, after the size and licence are shown.
  'speaker-id': SPEAKER_ID_IS_RESNET34_ALIAS
    ? {
        id: 'speaker-id',
        kind: 'speaker-id',
        languages: ['multi'],
        downloads: [],
        totalBytes: 0,
        alias: { of: 'diarization-en', path: 'wespeaker_en_voxceleb_resnet34.onnx' }
      }
    : {
        id: 'speaker-id',
        kind: 'speaker-id',
        languages: ['multi'],
        downloads: [
          {
            // "recongition" is the upstream release tag's spelling.
            url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx',
            bytes: 28_281_164,
            sha256: 'aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2',
            capBytes: 40 * MiB,
            timeoutMs: 600_000,
            kind: 'file',
            members: [
              {
                path: '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx',
                bytes: 28_281_164,
                sha256: 'aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2'
              }
            ]
          }
        ],
        totalBytes: 28_281_164
      }
}

/** The model whose download and folder hold this one's files: `alias.of`, else itself. */
export function modelHome(id: LocalModelId): LocalModelId {
  return MODEL_MANIFEST[id].alias?.of ?? id
}

/** The models that are aliases of `id`. */
export function aliasesOf(id: LocalModelId): LocalModelId[] {
  return (Object.keys(MODEL_MANIFEST) as LocalModelId[]).filter((a) => MODEL_MANIFEST[a].alias?.of === id)
}

/** The model's files, relative to its home's folder: an alias's one member, else every member. */
export function modelFiles(id: LocalModelId): ModelFile[] {
  const alias = MODEL_MANIFEST[id].alias
  const members = (m: LocalModelId): ModelFile[] => MODEL_MANIFEST[m].downloads.flatMap((d) => d.members)
  if (!alias) return members(id)
  const hit = members(alias.of).find((m) => m.path === alias.path)
  if (!hit) throw new Error(`manifest: alias ${id} names no member ${alias.path} of ${alias.of}`)
  return [hit]
}

/**
 * The speaker identification model id: the SHA-256 of the extractor file the manifest pins
 *, the alias's file included. Every vector carries it; it is never
 * written by hand.
 */
export function speakerIdModelId(): string {
  return (modelFiles('speaker-id')[0] as ModelFile).sha256
}
