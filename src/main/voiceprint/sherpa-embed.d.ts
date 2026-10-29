// SPDX-License-Identifier: Apache-2.0
// The speaker-embedding part of sherpa-onnx-node 1.13.8 that notula-voiceprint and notula-diarize
// use for identification (the package ships no declarations; `asr/sherpa.d.ts` declares the rest,
// and the two blocks merge). Only the utility processes load it; main never does.

declare module 'sherpa-onnx-node' {
  export interface SpeakerEmbeddingExtractorConfig {
    model: string
    numThreads: number
    debug: 0 | 1
    provider: 'cpu'
  }

  export class OnlineStream {
    acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void
    inputFinished(): void
  }

  export class SpeakerEmbeddingExtractor {
    constructor(config: SpeakerEmbeddingExtractorConfig)
    readonly dim: number
    createStream(): OnlineStream
    isReady(stream: OnlineStream): boolean
    compute(stream: OnlineStream, enableExternalBuffer?: boolean): Float32Array
  }
}
