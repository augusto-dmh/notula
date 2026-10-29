# Speaker bench

The gate for voice auto-naming. It is a dev-run benchmark, not a test suite: no committed fixtures, no CI, no run in the gate. It drives the built app's replay feed (`src/main/speakers/bench-feed.ts`) on a scratch profile and writes a report of aggregates.

The feed exists only in an unpackaged build started with `NOTULA_DEV_SPEAKER_BENCH=1`. A release build (`npm run dist`, `--mode release`) folds `import.meta.env.MODE === 'release'` to true, and the bundler drops the feed's code.

## Rules

- **Your data never enters the repo.** The manifest, its audio, labels and UIA streams must be outside the working tree. The bench refuses them otherwise.
- **Where things go:**
  - real-run scratch profiles and per-cluster results go to the bench home, outside the repo (`%LOCALAPPDATA%\notula-speaker-bench`, or `--home`);
  - composed stress fixtures and T2 streams go to the git-ignored `.speaker-bench/runs/<run>/fixtures`;
  - reports (aggregates only) go to `.speaker-bench/reports/`.
- **The LLM step uses your configured provider for every set**, through `--provider`. The colleagues' benchmark consent must name that provider. The in-app mock replaces it only where a scenario injects a reply (A7's contradicting reply) and while A6 counts LLM calls during relabel.
- **`--provider none` skips the LLM step.** It configures no provider, so the step abstains without a request. Use it for public-data runs, where nobody says a name. The llm and fused sets then carry no conversation evidence. The scenarios above still inject the mock.
- **`calibration.json` is written only by `run --write-calibration`,** never by `--dry`. `autoEnabled` is set only on `≥30s` conditions whose two bounds pass.
- **No real voice in `--dry`:** generated tones only.

## Commands

Run `npm run build` first. Every command starts Electron itself: tray only, no window, except `setup`.

| Command | What it does |
|---|---|
| `node scripts/dev/speaker-bench.mjs --dry` | Generates tones and a manifest in the run folder, runs every stage with the provider mock, writes a report and checks that `calibration.json` didn't change. It exits 1 if a stage errs or an invariant fails. |
| `… setup` | Opens the app's UI on the label profile (`<home>/label-profile`). Its `models` folder is a junction to `<home>/models`, which every run shares. Use it to download the speech, speaker and speaker-id models, and to name speakers after `label`. |
| `… label --manifest <m> [--all]` | Feeds every meeting without labels (or all of them with `--all`) into the label profile, in real time. It writes `<home>/label-notes.json`. |
| `… export-labels --manifest <m>` | Writes `labels/<meeting>.json` next to the manifest, from the speakers you named in the label profile. They are label spans; later runs map clusters to people by word overlap. |
| `… run --manifest <m> --provider <p\|none>` | The full protocol, metrics, report and fitted candidate calibration. Add `--write-calibration` to write `resources/speakers/calibration.json`. |
| `… compare-models --manifest <m>` | Runs only the model comparison. `run --compare-models` includes it. |

`run` options:
- `--k 1..3`: enrollment meetings per person, for the learning curve (default 3).
- `--seed n`: the held-out split and the bootstrap.
- `--no-t2`, `--t2-meetings n`: the platform sweeps.
- `--no-t3`: the stress mixtures.
- `--scenario-meetings n`: meetings re-fed by A7, A12 and A16 (default 2).
- `--ffmpeg <path>`: needed for Opus and for non-WAV stress sources. The bench finds ffmpeg at run time and never installs it.
- `--home <dir>`: the bench home.
- `--keep`: keep the run's scratch profile.

### A full run

1. Collect the dataset and each colleague's consent, naming your configured provider.
2. Convert each meeting to two time-aligned 16 kHz mono 16-bit WAVs (mic, system) outside the repo, and write the manifest.
3. `setup`: download the models in Settings. Quit the app.
4. `label --manifest <m>`, then `setup`: name every speaker once in each note. Quit, then `export-labels --manifest <m>`.
5. Write the provider file and set the key's environment variable (below). For public data, pass `--provider none` instead.
6. `run --manifest <m> --provider <p> --compare-models`. A full run costs about 2× the audio length, plus one replay per T2 variant.
7. Read `.speaker-bench/reports/<run>.md`. If the model comparison picks ResNet-34, switch `speaker-id` to the alias first (`src/main/asr/manifest.ts`) and run again.
8. When the gate passes where you want it, run with `--write-calibration`. Commit the file and the report's JSON together. The bench prints any coverage drop over 5 points; the commit message says why each one is acceptable.
9. Run `run` once more to confirm the production bands under the new file.

## The manifest (private, outside the repo)

```json
{
  "version": 1,
  "people": [
    { "id": "p00", "name": "Your Name", "email": "you@example.com", "self": true },
    { "id": "p01", "name": "Ana Souza", "email": "ana@example.com" }
  ],
  "meetings": [
    {
      "id": "m01", "set": "colleagues", "date": "2026-11-02", "language": "pt-BR", "title": "Weekly sync",
      "audio": [
        { "channel": "mic", "path": "m01-mic.wav", "offsetMs": 0 },
        { "channel": "system", "path": "m01-system.wav", "offsetMs": 120 }
      ],
      "attendees": ["p01"],
      "uia": { "app": "meet", "path": "m01-uia.jsonl" },
      "labels": "labels/m01.json"
    }
  ],
  "stress": { "language": "pt-BR", "sources": [{ "corpus": "mls-pt", "speaker": "10087", "files": ["mls/10087/a.flac"] }] },
  "models": [
    { "id": "resnet34", "path": "models/wespeaker_en_voxceleb_resnet34.onnx" },
    { "id": "resnet34-lm", "path": "models/wespeaker_en_voxceleb_resnet34_LM.onnx" },
    { "id": "campplus-zh-en-advanced", "path": "models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx" }
  ]
}
```

- **Paths** are relative to the manifest's folder.
- **People:** `id` is the pseudonym that results use. `name` and `email` stay inside the app, which needs them for attendees, the meeting-app names and the LLM step. Without an `email`, the bench uses `<id>@bench.invalid`.
- **One audio entry** feeds a single-channel set (a lesson on one mic) as that one source.
- **Labels** are spans `{channel, startMs, endMs, person}` on the meeting's timeline (ms from the feed's start; `offsetMs` places a file on it). A labels file holds `{spans: [...]}`. `labels/<id>.json` is picked up when `labels` is absent. `person: "unknown"` marks a speaker who is in no list. An auto that names someone outside the people there (a guest named from their tile) counts as no wrong name in the tallies; the voice gate is unchanged.
- **The UIA stream** has one JSON line per record, with `tMs` from the meeting's start plus the reader's record fields (`event`, `participantName`, `participants[{name, active, isSelf}]`, `selfActive`, `hasMeetingWindow`). Names may be person ids, which the feed turns into the people's names. It is replayed into the attribution service as the UIA worker's records, at their time.
- **Not usable:** public speech corpora whose terms don't allow identifying their speakers.

## The provider file (outside the repo)

```json
{ "settings": { "llm.provider": "anthropic", "llm.anthropic.model": "<your model>" }, "secret": { "id": "llm.anthropic", "env": "NOTULA_BENCH_LLM_KEY" } }
```

`--provider none` takes no file: the run profile gets a local provider with no model.

The app reads the key from that environment variable and stores it in the run profile's keychain. The bench never writes it anywhere.

## What a run does

1. **Launch 1 (feed).** The labelled meetings play in date order. Each one goes through these steps:
   - a note with a synthetic linked event (the attendees);
   - a local-ASR session in the meeting's language;
   - `TranscriptionManager.feed` once per source and 100 ms, in real time, with the UIA records at their times;
   - `TranscriptionManager.stop`, then the pass and the job, as in production;
   - a dump of the clusters (bands, auto names, candidates, word segments; no text, no score);
   - the protocol's confirmations through the real `speaker-names:accept` and `speaker-people:record-agreement` handlers. Each enrolled person gets an agreement, Remember voice is on, and the 10 s Undo window is waited out.

   Then come the T2 replays and the T3 mixtures. A missing model is never downloaded: a meeting whose ASR isn't installed gets no session.
2. **Launch 2 (evaluate).** For every stored pass, the production `decide` runs on the stored inputs:
   - per signal set (voice, app, LLM, fused);
   - per gallery scope (attendees, everyone);
   - per learning-curve k.

   It also records each cluster's max cosine to every enrolled person's space. These scores go only to the results file; no vector leaves the app.
3. **The fit.** The bench fits a logistic per condition (pooled per channel when short of trials), `tauSuggest` (≥ 90 % right) and `tauAuto` (the lowest threshold whose simulated auto set passes both bounds), plus `farCosine`. `margin`, `tieMargin` and the fusion weights keep their shipped values.
4. **Launch 3.** It evaluates again under the fitted candidate, with `autoEnabled` on every `≥30s` condition, to measure would-be autos. Then comes the scenario phase.
5. **The gate.** It reads the production decisions of launch 3 (voice, attendee-filtered, real clusters, `≥30s`). A condition passes only if both the Clopper–Pearson one-sided 95 % upper bound and the people bootstrap's 95th percentile of its wrong-name rate are ≤ 1 %. Composed fixtures never count.

## Acceptance invariants

| # | Where | How |
|---|---|---|
| A1 | every dump | no two auto clusters of a note with the same person |
| A2 | evaluate | voice-only decisions: no candidate above the floor ⇒ `none` |
| A3 | scenarios | held-out people removed from the events, rerun; then enrolled, rerun: no cluster rises to auto |
| A4 | evaluate + scenarios | `decide` on shuffled clusters, candidates, gallery and mappings; reruns with shuffled attendees: identical bands |
| A5 | evaluate | no space for a foreign model id; no voice band under a foreign model's calibration. One extractor is installed, so the switch is simulated |
| A6 | scenarios | `confirmed_*` hash around every rerun and relabel; relabel makes no LLM call (mock count) and lowers no auto |
| A7 | scenarios | re-feeds without the UIA stream and with a contradicting mock reply, then Recognize voices off and reruns: the autos that lost their only evidence drop |
| A8 | scenarios | up to 40 confirmations of one person, then a merge: no space over 16 |
| A9 | scenarios | Forget, then Forget all: the tables are empty, and a byte copy of the database and WAL, decrypted page by page with the profile's key in memory (free pages included), holds none of the vectors. No voice evidence is left for the person |
| A10 | scenarios | `speaker-names:not-person`, then a rerun: the person isn't proposed again for that cluster |
| A11 | scenarios | an impostor cluster confirmed as an enrolled person under the cap: the mean moves exactly `w/Σw`, and the stored centroid follows |
| A12 | scenarios | re-feeds with a no-show attendee and with an attendee removed: no elimination suggestion |
| A13 | scenarios | Remember voice with no agreement: zero exemplars |
| A14 | scenarios | every handler reply, request and push the run saw, and the app's logs: no float vectors, score fields, or agreement and evidence text outside View message and the agreement request |
| A15 | scenarios | for notes with suggest or tie rows, what goes out: the summary prompt's transcript (`buildPromptInputs`, with Separate speakers as set and off), a chat `readTranscript` and a webhook body's `transcript`: no such name as a speaker label (`leaksBy` counts per output) |
| A16 | scenarios | Forget during a re-fed meeting's job: no voice auto from the forgotten voice. A confirmation during a relabel: no `auto_*` and no suggestion row on that cluster |

## Limits

- **On a machine without the speech models,** `--dry` exercises:
  - fixture generation, the plans and the three launches;
  - note creation, the synthetic events and the real-time feed loop;
  - the scenario handlers and the decrypted-copy scan;
  - the log and IPC scans, the metrics, the model comparison (a spectral stand-in) and the report.

  No pass runs, so the cluster-level checks report `n/a`. With the models in the dry profile's `models` folder, the same dry run exercises the pass and the job as well.
- **Embedding time** isn't reported apart from the pass. CPU is the CPU each utility process (`notula-asr`, `notula-diarize`, `notula-storage`) spends during the feeds, per audio hour, plus the pass's wall time.
- **A re-pass during a job** isn't forced: the pass consumes the note's temp audio. A16 covers the Forget and relabel races.
- **A5's model switch** is simulated with a foreign model id.
