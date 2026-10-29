// SPDX-License-Identifier: Apache-2.0
// Types for the subset of sherpa-onnx-node 1.13.8 that notula-asr and notula-diarize
// use (the package ships no declarations). Only the utility processes load it; main
// never does (no ONNX inference in main). SpeakerEmbeddingExtractor, which notula-diarize
// also uses for identification, is declared in `voiceprint/sherpa-embed.d.ts` (the two
// blocks merge); it moves here when that file goes.

declare module 'sherpa-onnx-node' {
  export interface Waveform {
    samples: Float32Array
    sampleRate: number
  }

  export interface OfflineRecognizerConfig {
    featConfig: { sampleRate: number; featureDim: number }
    modelConfig: {
      transducer?: { encoder: string; decoder: string; joiner: string }
      /** `tailPaddings`: feature frames of silence after the audio; -1 is sherpa's default (1000). */
      whisper?: { encoder: string; decoder: string; language: string; task: 'transcribe'; tailPaddings: number }
      tokens: string
      numThreads: number
      provider: 'cpu'
      debug: 0 | 1
      modelType?: string
      modelingUnit?: string
      bpeVocab?: string
    }
    decodingMethod: 'greedy_search' | 'modified_beam_search'
    maxActivePaths?: number
    hotwordsScore?: number
  }

  export interface OfflineRecognizerResult {
    text: string
    tokens: string[]
    timestamps: number[]
    durations?: number[]
    /** Whisper: the detected (or set) language code, e.g. `pt` (measured on 1.13.8). */
    lang?: string
  }

  export class OfflineStream {
    acceptWaveform(obj: Waveform): void
  }

  export class OfflineRecognizer {
    constructor(config: OfflineRecognizerConfig)
    static createAsync(config: OfflineRecognizerConfig): Promise<OfflineRecognizer>
    createStream(hotwords?: string): OfflineStream
    decodeAsync(stream: OfflineStream): Promise<OfflineRecognizerResult>
    /** Replaces the config between decodes; Whisper's `language` applies to the next decode. */
    setConfig(config: OfflineRecognizerConfig): void
  }

  export interface OfflineSpeakerDiarizationConfig {
    segmentation: { pyannote: { model: string; windowShiftRatio?: number }; numThreads: number; debug: 0 | 1; provider: 'cpu' }
    embedding: { model: string; numThreads: number; debug: 0 | 1; provider: 'cpu' }
    clustering: { numClusters: number; threshold: number }
    minDurationOn: number
    minDurationOff: number
  }

  /**
   * 1.13.8's Node addon returns these three fields only. The core's opt-in per-segment
   * silhouette confidence isn't passed through by the addon (checked for speaker
   * profiles), so nothing here reads one.
   */
  export interface SpeakerDiarizationSegment {
    /** Seconds. */
    start: number
    end: number
    speaker: number
  }

  export class OfflineSpeakerDiarization {
    constructor(config: OfflineSpeakerDiarizationConfig)
    readonly sampleRate: number
    process(samples: Float32Array): SpeakerDiarizationSegment[]
  }
}
