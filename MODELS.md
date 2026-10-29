# Speech models

Notula ships no speech models. When you turn on on-device transcription, speaker separation or voice recognition, Notula downloads the model you pick from the sherpa-onnx project's public GitHub releases. Each file is pinned by SHA-256 in `src/main/asr/manifest.ts`. The models stay under their own licences, listed below. Notula's Apache-2.0 licence doesn't cover them.

All of the files below are conversions published by the [k2-fsa sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) project, not the original checkpoints. The speech models were exported to ONNX and quantised to int8. Notula uses them unmodified, as published.

## Transcription

| Model in Notula | Original model | Publisher | Licence | Download |
|---|---|---|---|---|
| Whisper large-v3-turbo (int8) | [openai/whisper-large-v3-turbo](https://huggingface.co/openai/whisper-large-v3-turbo) | OpenAI | MIT | `sherpa-onnx-whisper-turbo.tar.bz2` |
| Parakeet TDT 0.6B v3 (int8) | [nvidia/parakeet-tdt-0.6b-v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) | NVIDIA | CC-BY-4.0 | `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2` |
| Parakeet TDT 110M English (int8) | [nvidia/parakeet-tdt_ctc-110m](https://huggingface.co/nvidia/parakeet-tdt_ctc-110m) (TDT decoder) | NVIDIA | CC-BY-4.0 | `sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8.tar.bz2` |

## Speaker separation

| Model in Notula | Original model | Publisher | Licence | Download |
|---|---|---|---|---|
| Segmentation | [pyannote/segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0) | pyannote (CNRS) | MIT | `sherpa-onnx-pyannote-segmentation-3-0.tar.bz2` |
| Speaker embedding | WeSpeaker ResNet-34, trained on VoxCeleb ([pretrained models](https://github.com/wenet-e2e/wespeaker/blob/master/docs/pretrained.md)) | WeNet / WeSpeaker | CC-BY-4.0 (follows the VoxCeleb dataset licence) | `wespeaker_en_voxceleb_resnet34.onnx` |

## Speaker identification

Downloaded only when you turn on Recognize voices or Recognize my voice, after its size and licence are shown.

| Model in Notula | Original model | Publisher | Licence | Download |
|---|---|---|---|---|
| Speaker identification | CAM++ zh-en advanced ([iic/speech_campplus_sv_zh_en_16k-common_advanced](https://modelscope.cn/models/iic/speech_campplus_sv_zh_en_16k-common_advanced)) | 3D-Speaker | Apache-2.0 | `3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx` |

## Runtime

| Component | Licence |
|---|---|
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (`sherpa-onnx-node`, bundled) | Apache-2.0 |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) (inside sherpa-onnx, bundled) | MIT |

## Attribution

- **NVIDIA Parakeet TDT 0.6B v3** and **Parakeet TDT 110M**, by NVIDIA, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Changes: converted to ONNX and quantised to int8 by the k2-fsa sherpa-onnx project.
- **Whisper large-v3-turbo**, Copyright (c) OpenAI, licensed under the MIT License. Changes: converted to ONNX and quantised to int8 by the k2-fsa sherpa-onnx project.
- **pyannote segmentation-3.0**, Copyright (c) CNRS, licensed under the MIT License. Changes: converted to ONNX by the k2-fsa sherpa-onnx project.
- **WeSpeaker ResNet-34 (VoxCeleb)**, by the WeSpeaker project, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Changes: exported to ONNX by the k2-fsa sherpa-onnx project.
- **CAM++ zh-en advanced**, by the 3D-Speaker project, licensed under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0). Changes: exported to ONNX by the k2-fsa sherpa-onnx project.

The same short credit appears in the app under Settings ▸ AI, next to the on-device speech options.

## Downloaded tools

Notula bundles no other programs. One optional tool is downloaded at run time, only when you ask for it:

| Tool | Used for | Licence | Download |
|---|---|---|---|
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Sources (Labs, Windows): video titles and details, and video captions | [Unlicense](https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE) | `yt-dlp.exe` from the project's latest GitHub release, checked against the release's `SHA2-256SUMS` |

yt-dlp is downloaded from Settings ▸ Sources after its size and licence are shown, and is kept under Notula's user-data folder. A newer `yt-dlp.exe` already on your `PATH` is used instead. The Windows executable is built by the yt-dlp project and includes components under their own licences; the yt-dlp project lists them with its releases. Notula's Apache-2.0 licence doesn't cover yt-dlp.
