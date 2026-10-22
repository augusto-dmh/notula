# Notula

**Notula: open-source, local-first meeting notes.**

Notula is an AI meeting-notes app for the desktop. While a meeting runs it shows a live transcript next to the notes you type. When the meeting ends it writes enhanced notes from both. Everything is stored on your computer. AI calls go only to a provider you choose, with your own key, or to a model running on your own machine.

## What it does

- **Live transcript.** Notula captures your microphone and the meeting's system audio and transcribes as people talk. It can detect meetings, label speakers and stop by itself after a long silence.
- **Your notes.** A rich editor sits beside the transcript, with attachments, action items, folders, search, and copy and export.
- **AI-enhanced summaries.** When the meeting ends, Notula combines your notes and the transcript into structured notes. It can also use templates, write follow-up emails and meeting titles, and regenerate on request. You can chat with a note or with your whole library.
- **Local or cloud transcription.** Transcribe on your own machine with downloadable speech models (see [`MODELS.md`](MODELS.md)), or stream to a cloud speech service with your own API key.
- **Local or cloud language models.** Use a cloud provider with your own key, or a local OpenAI-compatible server.
- **Calendar and integrations.** Upcoming meetings from ICS feeds or your own OAuth client, plus optional integrations. Every call goes from your computer straight to the service, with your credentials.
- **MCP.** An MCP client for your own servers, and a local MCP server over your notes.
- **Dictation.** Voice typing into any app.
- **Sources (Labs, Windows).** When you play a video or a course lesson in your browser, Notula can offer a note linked to it, with each transcript line stamped at its moment in the video. It can use the video's captions, file lessons into series and course folders, and export notes as Markdown with the video and lesson details. Turn it on in Settings ▸ Labs.
- **Markdown import.** Bring in folders of Markdown notes, including vaults with wikilinks and front-matter, and Notula's own exports. Notula reads the files and never changes them.
- **Browser extension (optional).** An extension for Chrome and Edge, in [`extension/`](extension/README.md), tells the desktop app what is playing in the browser over native messaging. It talks only to the app on the same computer. Notula works fully without it.

## Privacy

- **Data stays on the machine.** Notes, transcripts, recordings and settings live in an encrypted SQLite database in your user-data folder. There is no Notula server, no account and no telemetry.
- **Local-only mode.** Settings ▸ Preferences ▸ "Nothing leaves this machine" blocks every network request except to loopback addresses. That covers cloud AI and transcription, calendar sync, integrations and update checks.
- **Keys in the OS keychain.** API keys and tokens are protected with Electron `safeStorage` (DPAPI on Windows, Keychain on macOS) and never written to files, logs or exports.
- **Your providers only.** Transcription and AI requests go only to the providers you set up, or to on-device and local models. Cloud providers are contacted only when you pick them.
- **What goes to GitHub.** Notula checks for updates and downloads them from GitHub, where its releases are hosted (`augusto-dmh/notula-releases`). Update checks send the app version and platform. Speech models and the optional yt-dlp tool are downloaded from GitHub only when you ask for them.
- **Recording consent.** You're responsible for telling people they're being recorded and for following the recording laws that apply to you and to them. Get their consent before you record them.

## Install

Download the latest installer from the [releases page](https://github.com/augusto-dmh/notula-releases/releases/latest) and run it. Installed copies update themselves from the same releases.

Builds aren't code-signed yet, so Windows SmartScreen warns on first run.

### Platform status

| Platform | Status |
|---|---|
| Windows 10 and 11 (x64) | Supported |
| macOS | Experimental: builds from source, not tested regularly |
| Linux | Not supported yet |

## Build from source

You need Node.js 24 or later and npm.

```sh
npm ci                # install dependencies
npm run dev           # run the app with hot reload
npm run typecheck     # type check
npm run build         # production build into out/
npm run dist          # Windows installer into dist/
```

Run `npm run typecheck && npm run build` before sending a change. `NOTULA_USER_DATA_DIR` points a dev run at a scratch profile, so you don't touch your real notes.

Optional build-time variables:

- `NOTULA_UPDATE_FEED_URL`: the update feed baked into the installer. Without it, builds use the project's releases feed. Set it to an empty string to build without updates.
- `NOTULA_FEEDBACK_EMAIL` and `NOTULA_ISSUES_URL`: where Send feedback points.

The app icon lives in `resources/icon/icon.svg`. After changing it, regenerate the PNG and ICO files:

```sh
npx electron scripts/icon/render.cjs resources/icon/icon.svg resources/icon <scratch folder for Electron's profile>
```

### Layout

| Path | What |
|---|---|
| `src/main` | Electron main process and utility-process workers (storage, speech, diarization and others) |
| `src/preload` | The isolated preload (contextBridge only) |
| `src/renderer` | The React interface |
| `src/shared` | The contract between the interface and the main process: every IPC channel and its types |
| `resources/` | Icons and helper files shipped next to the app |
| `extension/` | The optional browser extension (its own build: `npm --prefix extension run build`) |
| `scripts/dev/` | Small development checks and fixtures |
| `style/COPY.md` | The guide for interface text |

The stack is Electron, TypeScript, React and electron-vite. Storage is SQLite with SQLCipher through `better-sqlite3-multiple-ciphers`. On-device speech uses `sherpa-onnx-node`.

### Releases

Publishing installers is maintainer-only and not part of this repository. Contributors only need `npm run dist` to build an installer locally.

## Licence

Notula is licensed under the [Apache License 2.0](LICENSE). See [`NOTICE`](NOTICE), [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for bundled dependencies, and [`MODELS.md`](MODELS.md) for the speech models and the optional tool Notula downloads. The installer ships these files too, and Settings ▸ About ▸ Open-source licenses shows them in the app.

Notula's code, interface text and artwork were written for this project, with help from AI coding assistants.

## Contributing

Contributions are welcome. Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) first: every commit needs a DCO sign-off. Report security issues privately as described in [`SECURITY.md`](SECURITY.md). Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
