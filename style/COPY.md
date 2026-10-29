# Notula copy guide

How Notula talks to the people who use it. Every word the app shows — buttons, settings, errors, toasts, empty screens, onboarding, CLI output — follows this guide. When this guide and a habit disagree, the guide wins; when the guide is silent, pick the wording a calm, competent colleague would say out loud.

## 1. Voice

Notula sits in the room while people talk, so it should feel like a quiet, reliable assistant, not a mascot.

- **Calm.** No exclamation marks, no hype, no "Oops!", no emoji in interface text. A failed upload is news, not a drama.
- **Direct.** Lead with the point. Say what happens, not what the feature is "designed to" do.
- **Plain English.** Short, common words. "Use" not "utilise", "turn on" not "enable" in prose (the switch itself can just be labelled), "can't" not "is unable to".
- **Honest.** Say what Notula does with data, exactly. Never promise something the code doesn't do ("always", "never", "instantly") unless it is true.
- **Specific.** Name the thing: "Couldn't reach Google Calendar" beats "Something went wrong".

## 2. Person and grammar

- Talk to the user as **you**. Notula refers to itself by name or not at all — never "we" and never "I". ("Notula keeps your audio on this computer.")
- Use the active voice: "Notula deleted 3 notes", not "3 notes were deleted".
- Contractions are fine and preferred in prose: can't, don't, isn't, you'll.
- Use American spelling (color, organize, canceled).
- One idea per sentence. Two sentences per message is usually the most a surface can carry.

## 3. Capitalization and punctuation

- **Sentence case everywhere**: titles, buttons, menu items, tabs, settings labels, dialog titles. Only the first word and proper nouns get a capital: "Keyboard shortcuts", "Connect Google Calendar".
- Proper nouns keep their own spelling: Notula, Google Calendar, Slack, HubSpot, macOS, Windows, MCP. Notula's own feature names are common nouns and follow sentence case: the dictation bar, the meeting dock, quick ask.
- **Full stops**: a complete sentence ends with a period (descriptions, errors, toasts with a verb). Labels, buttons, titles, menu items, tooltips that name an action and placeholders that are fragments take no period.
- Use an ellipsis (…, one character) only on a menu item or button that opens a further step before anything happens ("Export…"), and in progress text ("Saving…").
- Use curly apostrophes and quotes in interface text (’ “ ”). Straight quotes stay only where code or a developer reads the text (JSON, ids, command lines).
- Use an en dash for ranges (1–5) and an em dash sparingly; prefer two sentences.
- Don't use ALL CAPS for emphasis. Use bold in rich text, or rewrite.

## 4. No blame

The user is never the problem.

- Not "You entered an invalid email", but "Enter an email like name@company.com".
- Not "You don't have permission", but "Notula needs microphone access to record".
- When the cause is Notula's, say so plainly: "Notula couldn't save this note."
- When the cause is a third party, name it without accusing: "Slack didn't respond."

## 5. Errors

Every error answers up to three questions, in this order:

1. **What happened**, in the user's terms. Start with the outcome: "Couldn't send to Slack." "The transcript is incomplete."
2. **Why**, only if it helps the user act or understand. "Your sign-in expired." Skip internal causes (status codes, stack traces) — those go to the log, or into a technical detail line under the message.
3. **What to do next**, as an instruction with a verb: "Reconnect Slack in Settings ▸ Integrations." "Try again in a minute."

Patterns:

- Short inline error: `Couldn't <verb> <thing>. <Next step>.`
- Validation (forms): say what is accepted, not what was wrong: "Use 1–60 minutes." "Enter a URL that starts with https://."
- Limits: state the limit and the way out: "You can pin up to 5 recipes. Unpin one to add another."
- Raw details from a provider or the OS may follow after a colon or on their own line; they are never the whole message.
- Use "Couldn't" for failures, "Can't" for things that are not possible right now, and "Not available" for features that don't apply.
- Don't apologise in routine errors. A single "Sorry" is acceptable only where Notula lost the user's work.

## 6. Length budgets

Hard ceilings per surface. Shorter is better. Where a string has its own stated budget (because the layout was built around it), that budget wins.

| Surface | Words | Characters | Notes |
|---|---|---|---|
| Button | 1–3 | ≤ 24 | Verb first: "Save note", "Reconnect" |
| Menu item | 1–4 | ≤ 32 | Verb first; "…" only if another step follows |
| Tab / segment | 1–2 | ≤ 16 | Nouns |
| Field or setting label | 1–5 | ≤ 40 | Noun phrase, no period |
| Tooltip / accessible label | 1–8 | ≤ 60 | Names the action or the object |
| Placeholder | 1–10 | ≤ 60 | An example or a hint, never the only label |
| Status line / badge | 1–8 | ≤ 60 | Present state: "Syncing…", "Connected" |
| Toast | 2–10 | ≤ 70 | One line; past tense for done work |
| Inline error | 4–24 | ≤ 140 | What happened + next step |
| Dialog title | 2–8 | ≤ 50 | A question or the action |
| Dialog body | ≤ 40 | ≤ 220 | Consequences first |
| Settings description | ≤ 30 | ≤ 170 | What the setting changes, for whom |
| Empty state | title ≤ 6, body ≤ 25 | ≤ 40 / ≤ 150 | Why it's empty + how to fill it |
| Onboarding step | heading ≤ 8, body ≤ 35 | ≤ 50 / ≤ 200 | One benefit per step |
| CLI message | ≤ 20 | ≤ 120 | Same rules as errors; no markup |

## 7. Numbers, time and placeholders

- Use numerals for every count and measure: "3 notes", "1 speaker", "45 minutes".
- Pluralise by count. Code that formats a count must pick the singular for 1. Never write "note(s)".
- Units: a space between number and unit ("200 MB", "16 kHz"). In compact UI, abbreviate time as "5 min", "30 s", "2 h"; in prose, spell it out ("5 minutes").
- Dates and times come from the user's locale; never hard-code a date format in copy.
- Percentages without a space: "85%".
- Placeholders in a string (`{name}`, `${count}`) keep their meaning and order when copy is edited. Write the sentence so it reads naturally with any realistic value, including 0, 1 and a long name.
- Wrap names the user typed (folder, template, recipe) in quotation marks only when they could be confused with the sentence around them: Deleted “Weekly sync”.

## 8. Glossary

Use these terms, and only these, for Notula's own concepts. Lowercase in running text unless the term starts a sentence or is a named surface.

| Term | Means | Don't say |
|---|---|---|
| **note** | The page for one meeting or topic: what you typed, plus what Notula adds. | doc, document, page, memo |
| **meeting** | A conversation Notula takes notes on, from the calendar or started by hand. | call (except for phone calls), session, event (that's the calendar's word) |
| **calendar event** | The entry in Google or Microsoft calendar a meeting comes from. | invite, appointment |
| **transcript** | The written record of what was said, with speakers and times. | captions (that's the live view), log |
| **live captions** | The transcript as it appears while a meeting is running. | subtitles |
| **recording** | Capturing a meeting's audio; also the audio Notula keeps, when it keeps any. | capture (internal word) |
| **enhanced notes** | The version of a note Notula writes from the transcript and your notes. "Enhance" is the action. | AI notes, summary (when you mean the whole page) |
| **summary** | A short recap section inside enhanced notes, or a recap sent elsewhere. | overview, digest |
| **action items** | The follow-up tasks found in a meeting. One is an **action item**. | to-dos, tasks (unless an integration calls them tasks) |
| **template** | The outline that shapes enhanced notes (sections and their order). | layout, format |
| **recipe** | A saved chat prompt you can run on a note or across notes. | prompt, macro, shortcut |
| **chat** | Asking Notula questions about your notes and meetings. | assistant, AI chat |
| **folder** | A named group of notes. | collection, space, project |
| **people** / **companies** | The contacts and organizations Notula builds from meetings. | contacts, accounts (except in a CRM's own terms) |
| **speaker tags** | The names Notula puts on voices in a transcript. | labels, diarization |
| **voice typing** | Speaking to type text into any app. One spoken input, as listed in its history, is a **dictation**. | dictation (for the feature itself) |
| **dictation bar** | The small bar on screen while voice typing listens. | widget, pill |
| **meeting bubble** | The small floating control on screen while Notula takes notes in a meeting. | pill, widget, overlay |
| **meeting dock** | The small window kept on top during a meeting, with chat, your notes and the live transcript. | mini window, sidebar |
| **quick ask** | Asking Notula about your notes from any app, with a keyboard shortcut. | spotlight, launcher |
| **live context** | Answers and suggested times Notula offers during a meeting, from your notes and calendar. | assistant, copilot |
| **screen corner** | Moving the pointer into the bottom-left corner of the screen to start a note (macOS). | hotspot |
| **prep brief** | The short brief Notula prepares before a meeting from your past notes with the same people. | dossier, briefing |
| **meeting notice** | The message Notula posts in a meeting's chat so others know notes are being taken. | disclaimer, consent message |
| **workspace** | A team's account in another service, such as a Slack or Notion workspace. Notula itself has no workspaces. | team, org |
| **integration** | A service Notula sends notes or action items to (Slack, a CRM, Notion…). | app, plugin |
| **connector** | A source Notula's chat can read from (files, MCP servers). | integration, plugin |
| **automation** | A rule that runs on its own after a meeting (send, file, notify). | workflow, zap |
| **webhook** | A URL Notula calls with meeting data. | callback |
| **Labs** | Features that work but are still changing. | beta (except the beta release channel), experiments |
| **Trash** | Where deleted notes wait before they are removed for good. | bin, recycle bin |
| **scratchpad** | The daily page for quick notes not tied to a meeting. | journal |
| **AI provider** | The company whose model Notula uses (with your key). | vendor, LLM |
| **API key** | The secret that lets Notula use an AI provider for you. | token (except an integration's own tokens) |
| **source** | What a note came from: a video or a course lesson. | media, content |
| **series** | A course, a playlist or a channel group of sources. | collection |
| **lesson** | An item of a course or playlist, with a number. | class, aula |
| **video captions** | The subtitle track a video provides. | captions (alone: that's live captions), subtitles |
| **catalog** | The ordered lesson list of a series. | curriculum |
| **speaker** | A voice in one transcript, shown as “Speaker A” until it’s named. | cluster |
| **person** | Someone Notula knows across notes: a name, maybe an email. | contact, profile |
| **voice** | What Notula remembers to recognize a person, when that person agreed. | voiceprint, biometric, embedding (fine in docs and code) |
| **sample** | One remembered piece of a person’s voice. | exemplar |
| **name a speaker** | Put a name on every turn of a speaker in one note. | tag, label (as verbs) |
| **recognize** | Notula named a speaker by voice. | identify, match |
| **agreement** | A person’s yes to having their voice remembered, and the record of it. The code says agreement too; “consent” in code is the meeting notice. | consent (in new code identifiers) |

Verbs: **record**, **enhance**, **transcribe**, **share**, **send** (to an integration), **connect**/**disconnect** (accounts), **turn on**/**turn off** (features, in prose), **delete** (moves to Trash), **delete permanently** (empties it).

## 9. Accessibility

- Every icon-only button has an accessible label that names the action ("Pause recording"), not the icon ("Pause icon").
- Accessible labels change with state: "Mute microphone" / "Unmute microphone".
- Don't carry meaning by colour alone. A red dot also has text or a label ("Recording"), a failed row also says "Failed".
- Live regions announce outcomes, not progress noise: announce "Notes enhanced", not every percentage step.
- Link text makes sense out of context: "Open privacy settings", never "click here".
- Error text is tied to its field (aria-describedby) and says how to fix it.
- Don't rely on position words ("the button on the right"); name the control.
- Keyboard shortcuts are written with the platform's names (⌘ on macOS, Ctrl on Windows) and are never the only way to do something.

## 10. Patterns by surface

- **Buttons** start with a verb and say what happens: "Delete note", not "OK". The confirm button of a destructive dialog repeats the action ("Delete 3 notes").
- **Confirmations** ask a question in the title and state the consequence in the body: "Delete this folder?" / "Its 12 notes move to Trash, where you can still restore them."
- **Toasts** report finished work in the past tense ("Copied to clipboard", "Sent to Slack") and offer one action at most ("Undo", "Open").
- **Empty states** explain why there's nothing here and what fills it: "No action items yet. They appear here after Notula enhances a meeting."
- **Settings descriptions** say what changes and when, in one or two sentences, without repeating the label.
- **Progress** uses the present participle and an ellipsis: "Transcribing…", "Connecting to HubSpot…".
- **Privacy statements** are exact: what is stored, where, for how long, and who can see it.

## 11. Speaker profiles: never a pronoun for the person being named

Speaker names come from meeting apps, the conversation and the user, so the app can’t know anyone’s pronouns. **No string uses a gendered pronoun for the person being named.** Use the name again, or rephrase (“Notula starts remembering the voice the next time you name Ana”). A name that appears twice in one sentence is fine. No string shows a score or a percentage for a name or a voice.

## 12. Speaker profiles: texts other people read

The texts other people read live in `src/shared/lib/speaker-notices.ts`, so the sheet’s preview, the clipboard and the stored record use the same words. Each has a version id. A change to the text of a version that has shipped, or a change of purpose, bumps it and asks every person again.

| Text | Version | Where |
|---|---|---|
| The voice agreement message, English and Portuguese | `voice-agreement-1` | Copy message on the agreement sheet; stored in the agreement record |
| The participant notice, English and Portuguese, with the AI-provider sentence when names from the conversation use a cloud provider | `participants-1` | The notice card and Settings ▸ Speaker tags |
| The meeting-notice sentence, English and Portuguese | — | Add to meeting notice |

The interface strings of speaker profiles (the notice card, Settings ▸ Speaker tags, the agreement sheet, the person page, the dialogs and toasts) are in `src/renderer/src/features/speaker-profiles/strings.ts`.

## 13. Checklist before you ship a string

1. Is it in sentence case, in the user's terms, and within its budget?
2. Does it use the glossary terms?
3. If it's an error, does it say what happened and what to do next?
4. Are all placeholders still there, in an order that reads naturally?
5. Would it make sense read aloud by a screen reader, without colour or position?
6. Does it name a person without a pronoun, and show no score?
