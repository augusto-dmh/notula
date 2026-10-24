# Notes for coding agents

Notula is an open-source, local-first AI meeting-notes app for the desktop. It shows a live transcript, the notes you type and AI-enhanced summaries. This file tells coding agents (and people) how to work in this repository. [`CONTRIBUTING.md`](CONTRIBUTING.md) is the full contributor guide.

## Stack and commands

- Electron 44, TypeScript 7, React 19 and electron-vite 6, on Node.js 24 or later.
- `npm run dev` runs the app with hot reload.
- `npm run build` makes a production build into `out/`.
- `npm run typecheck` runs the type check.
- `npm run dist` builds the Windows installer into `dist/`.
- **Gate:** `npm run typecheck && npm run build` must pass before a change is done.
- There is no test suite. Small checks live in `scripts/dev/`. Run the one for the area you touched, if there is one.
- A dev run that needs data uses a scratch profile, `NOTULA_USER_DATA_DIR=<scratch folder>`, never the real one. `scripts/dev/qa/` can start a built app on a throwaway profile.

## Layout

- `src/main` is the Electron main process. Heavy work runs in utility processes: storage, speech, speaker separation and file conversion.
- `src/preload` is the isolated preload (contextBridge only).
- `src/renderer` is the React interface.
- `src/shared` is the contract between the interface and the main process. Every IPC channel and its types are declared there. At call sites, write the channel as a literal, `ipcMain.handle('app:info' satisfies Channel, …)`, never through a constant, so a search finds every handler and caller.
- `extension/` is the optional browser extension, with its own build.
- `style/COPY.md` is the guide for every word the app shows.

## Rules

- **Original work only.** Write code, text and assets for this project. Never copy from proprietary software, and never use decompiled code or strings extracted from other apps.
- **Notula on its own terms.** Don't name other products, or compare Notula with a named product, in code, comments, docs, commit messages, issues or pull requests.
- **Privacy is the product.**
  - No telemetry.
  - Every outbound request goes through the egress layer (`src/main/net/egress.ts`), so local-only mode can block it.
  - Keys and tokens live in the OS keychain through Electron `safeStorage`, never in files, logs or exports.
- **Interface text** follows `style/COPY.md`.
- **New source files** start with `// SPDX-License-Identifier: Apache-2.0`, or `/* … */` in CSS and `#` in PowerShell.
- **Code style:** match the code around your change: its naming, comment density and idiom. Comments explain why, not what.
- **Dependencies:** add one only when a change truly needs it, and check that its licence is compatible with Apache-2.0.
- **Commits:** every commit is signed off under the DCO (`git commit -s`). A pull request says which AI tools helped and roughly what they produced.
