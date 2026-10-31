// SPDX-License-Identifier: Apache-2.0
// Speaker profiles: every UI string, as named functions. No string uses a gendered
// pronoun for the person being named: the name, or a rephrase.
// The texts other people read (the agreement message, the participant notice, the chat
// sentence) are in `@shared/lib/speaker-notices`.

// ---------- the notice card ----------

export const noticeTitle = (): string => 'Notula now puts names on speakers'
/** `meetingApps` is false on macOS, where no meeting-app reader runs. */
export const noticeBody = (meetingApps: boolean): string =>
  `After a meeting, Notula names who spoke from ${meetingApps ? 'the names your meeting app shows and what people say' : 'what people say'}. Voices are separated on this computer. To name from the conversation, Notula sends your AI provider the transcript, the guests’ names and the names of up to 10 other people from your notes. Notula remembers a voice only if you turn that on and the person agrees.`
export const noticeDownloadModels = (mb: number): string => `Download models (${mb} MB)`
export const noticeDownloadModel = (mb: number): string => `Download the model (${mb} MB)`
export const noticeModelsReady = (): string => 'The speaker models are on this computer.'
export const noticeModelsDownloading = (): string => 'Downloading the speaker models…'
export const couldntStartDownload = (): string => 'Couldn’t start the model download. Try again.'
export const noticeCopyForParticipants = (): string => 'Copy participant notice'
export const noticeAddToChatNotice = (): string => 'Add to meeting notice'
export const noticeSpeakerSettings = (): string => 'Speaker settings'
export const noticeGotIt = (): string => 'Got it'
export const languageEnglish = (): string => 'English'
export const languagePortuguese = (): string => 'Português'

// ---------- Settings ▸ Speaker tags ----------

export const settingsAppNames = (): string => 'Names from meeting apps'
export const settingsSuggestNames = (): string => 'Suggest names from the conversation'
export const settingsRecognizeMyVoice = (): string => 'Recognize my voice'
export const settingsYourVoice = (): string => 'Your voice'
export const settingsRecordMyVoice = (): string => 'Record my voice'
export const settingsForgetMyVoice = (): string => 'Forget my voice'
export const settingsKeepImproving = (): string => 'Keep improving from my online meetings'
export const settingsRecognizeVoices = (): string => 'Recognize voices'
export const settingsRecognizeVoicesDetail = (): string =>
  'Remember the voices of people who agree, and name them in later meetings. Stays on this computer.'
export const settingsRetentionLine = (): string => 'Notula forgets a voice that’s not recognized in a meeting for 12 months.'
export const settingsForgetAllVoices = (): string => 'Forget all voices'
export const settingsPeopleWithVoice = (): string => 'People with a remembered voice'
export const settingsCopyParticipantNotice = (): string => 'Copy a notice for participants'
export const settingsAddChatNoticeLine = (): string => 'Add a line about speaker names to the meeting notice'
export const settingsMovedFromLabs = (): string => 'Your voice moved here from Labs'
export const settingsAlsoForgetOthers = (): string => 'Also forget the voices of other people?'
export const settingsAlsoForgetMine = (): string => 'Also forget your voice?'
export const settingsTurnOnSeparation = (): string => 'Turn on Separate speakers'
export const settingsDownload = (): string => 'Download'
/** A Labs self voice that couldn't be carried over to the new model. */
export const settingsRecordNewSample = (): string => 'Record a new sample, or turn on Keep improving from my online meetings.'

// ---------- the Forget all dialog ----------

export const forgetAllTitle = (): string => 'Forget every remembered voice?'
export const forgetAllBody = (): string =>
  'Notula deletes every voice sample, yours included. Names already in your notes stay. This can’t be undone.'
export const forgetAllConfirm = (): string => 'Forget all'
/**
 * Under every dialog that forgets your own voice. Before this version, the backup Notula made
 * before a database update was a full copy, so one may still hold a Labs voice sample.
 */
export const forgetOldBackups = (): string =>
  'Backups from earlier versions of Notula may still hold your voice. Delete them from data ▸ backups, in the folder that Settings ▸ Profile shows.'
export const cancel = (): string => 'Cancel'

// ---------- the speaker pill and its popover ----------

export const pillSuggest = (name: string): string => `${name}?`
export const pillTie = (a: string, b: string): string => `${a} or ${b}?`
export const popoverSearch = (): string => 'Search or add a name'
export const popoverNot = (name: string): string => `Not ${name}`
export const popoverRememberVoice = (): string => 'Remember voice'
export const popoverOnlyThisTurn = (): string => 'Only this turn'
/** `auto_src` `app` (and a kept `att` name): the meeting app's name. */
export const sourceFromApp = (app: string): string => `From ${app}`
export const sourceFromAppAndVoice = (app: string): string => `From ${app} and voice`
export const sourceRecognizedByVoice = (): string => 'Recognized by voice'
export const sourceSuggestedFromConversation = (): string => 'Suggested from the conversation'
export const sourceSoundsLike = (name: string): string => `Sounds like ${name}`
export const sourceTileIn = (name: string, app: string): string => `${name}’s tile in ${app}`
export const popoverPlay = (): string => 'Play'
/** The Play button while the clip plays. */
export const popoverStop = (): string => 'Stop'
/** The marker on a suggested candidate in the popover's list. */
export const suggestedMark = (): string => 'Suggested'
export const namingSpeakers = (): string => 'Naming speakers…'
/** A turn with no known speaker, as its pill shows it. */
export const pillUnattributed = (): string => 'Unknown speaker'
/** The small line under the guess at the top of the popover's list. */
export const guessByVoice = (): string => 'By voice'
export const guessTileIn = (app: string): string => `Tile in ${app}`
export const guessFromApp = (): string => 'From the meeting app'
export const guessFromConversation = (): string => 'From the conversation'
export const guessFromGuestList = (): string => 'The one guest not named yet'
export const couldntName = (): string => 'Notula couldn’t name this speaker. Try again.'
export const waitingForReply = (name: string): string => `Waiting for ${name}’s reply`

// ---------- who's who ----------

export const speakersToName = (n: number): string => `${n} ${n === 1 ? 'speaker' : 'speakers'} to name`
export const nameThem = (): string => 'Name them'
export const nameAllSpeakers = (n: number): string => `Name all speakers (${n})`
export const someoneElse = (): string => 'Someone else…'
export const skip = (): string => 'Skip'
export const channelOnTheCall = (): string => 'on the call'
export const channelInTheRoom = (): string => 'in the room'
export const nameChip = (name: string): string => `Name ${name}`
/** Closes the who's-who sheet once nobody is left to name. */
export const sheetDone = (): string => 'Done'
/** Closes the who's-who sheet while speakers are left. */
export const sheetLater = (): string => 'Later'
/** The compact menu of attendees on a who's-who row. */
export const sheetChooseName = (): string => 'Choose a name'
/** Very short speakers and mic echo, folded at the end of the sheet. */
export const sheetMore = (n: number): string => `${n} more`
export const sheetFewer = (): string => 'Show fewer'
export const sheetShortSpeaker = (): string => 'Spoke briefly'
export const sheetEchoSpeaker = (): string => 'Likely an echo of the call'

// ---------- the agreement sheet ----------

export const sheetAgreed = (name: string): string => `${name} agreed to voice recognition`
export const sheetHow = (): string => 'How was the agreement given?'
export const methodEmail = (): string => 'Email'
export const methodSpoken = (): string => 'Spoken'
export const methodWritten = (): string => 'Written'
export const methodOther = (): string => 'Other'
export const sheetCopyMessage = (): string => 'Copy message'
export const sheetPasteReply = (): string => 'Paste the reply'
export const sheetPickMoment = (): string => 'Pick the moment'
export const pickBanner = (name: string): string => `Click the turn where ${name} agreed · Esc to cancel`
export const sheetRemember = (name: string): string => `Remember ${name}’s voice`
export const sheetAskFirst = (name: string): string => `Ask ${name} first`
export const sheetFreeChoice = (name: string): string => `If ${name} says no, everything else still works, naming by hand included.`
/** The sheet's Cancel when it opened before a naming: the naming goes ahead without a voice. */
export const sheetNameWithout = (): string => 'Name without remembering'
export const sheetNameWithoutHint = (): string =>
  'Name without remembering, or Esc before anything is filled in, names this speaker and keeps no voice.'
// ---------- the person page's Voice and Agreement sections ----------

export const voiceSection = (): string => 'Voice'
export const voiceNone = (name: string): string => `Notula doesn’t remember ${name}’s voice.`
export const voiceRemember = (name: string): string => `Remember ${name}’s voice…`
export const voiceRecordAgreement = (name: string): string => `Record ${name}’s agreement…`
export const voiceNameIn = (name: string, meeting: string): string => `Name ${name} in ${meeting}`
export const voiceSince = (date: string): string => `Remembered since ${date}`
export const voiceRecognizedIn = (n: number): string => `Recognized in ${n} ${n === 1 ? 'meeting' : 'meetings'}`
export const voiceForgottenBy = (date: string): string => `Forgotten automatically if not recognized in a meeting by ${date}`
export const voiceRecognizeAutomatically = (): string => 'Recognize automatically'
export const voiceForget = (): string => 'Forget voice'
export const voiceManageSamples = (): string => 'Manage samples…'
export const voiceNeedsNewSample = (name: string): string => `Notula needs a new sample of ${name}’s voice.`
export const voiceLinkTo = (email: string): string => `Link to ${email}`
export const voiceMergeWith = (name: string): string => `Merge with ${name}`
export const voiceMergeWithAny = (): string => 'Merge with…'
export const agreementViewMessage = (): string => 'View message'
export const agreementExport = (): string => 'Export agreement record'
export const agreementRemove = (): string => 'Remove record'
export const personDelete = (): string => 'Delete person'

// ---------- the merge dialog ----------

export const mergeTitle = (from: string, into: string): string => `Merge ${from} into ${into}?`
export const mergeBody = (into: string, removed: number): string =>
  `Samples, meetings and agreement records move to ${into}.${removed > 0 ? ` ${into} keeps at most 16 samples per channel, so Notula removes ${removed} ${removed === 1 ? 'sample' : 'samples'}.` : ''} This can’t be undone.`
/** A withdrawal made after the surviving agreement governs the merged voice. */
export const mergeBodyWithdrawn = (into: string, date: string): string =>
  `Meetings and agreement records move to ${into}. ${into} withdrew on ${date}, so Notula forgets the voice. This can’t be undone.`
export const mergeConfirm = (): string => 'Merge'

// ---------- the Forget voice dialog ----------

export const forgetVoiceTitle = (name: string): string => `Forget ${name}’s voice?`
export const forgetVoiceWhy = (): string => 'Why?'
export const forgetVoiceRemoving = (): string => 'I’m removing it'
export const forgetVoiceWithdrew = (name: string): string => `${name} withdrew the agreement`
/** The same action while the person has an agreement but no sample yet. */
export const voiceWithdraw = (): string => 'Withdraw agreement…'
export const withdrawTitle = (name: string): string => `Withdraw ${name}’s agreement?`
export const withdrawBody = (name: string): string =>
  `Notula ends the agreement and won’t remember ${name}’s voice unless ${name} agrees again. The record stays as your proof. Names already in your notes stay.`
export const withdrawConfirm = (): string => 'Withdraw'

// ---------- toasts ----------

export const toastNamed = (n: number, name: string): string => `Named ${n} ${n === 1 ? 'passage' : 'passages'} as ${name}`
export const toastUndo = (): string => 'Undo'
export const toastSkipped = (letter: string): string => `Skipped Speaker ${letter}`
export const toastNot = (name: string): string => `Not ${name}`
export const toastForgotVoice = (name: string): string => `Forgot ${name}’s voice`
export const toastWithdrew = (name: string): string => `Ended ${name}’s agreement`
export const toastForgotAll = (): string => 'Forgot all voices'

// ---------- the agreement sheet's frame ----------

export const sheetTitle = (name: string): string => `Before Notula remembers ${name}’s voice`
export const sheetIntro = (): string =>
  'Notula remembers a voice only with the person’s agreement. Send the message, then record how the person agreed.'
export const sheetMessageTo = (name: string): string => `Message to ${name}`
export const sheetShowMessage = (): string => 'Show message'
export const sheetHideMessage = (): string => 'Hide message'
export const sheetCopied = (): string => 'Copied'
export const sheetProof = (): string => 'Proof (optional)'
export const sheetPastePlaceholder = (): string => 'Paste the reply here'
export const sheetCharsLeft = (n: number): string => `${n.toLocaleString()} ${n === 1 ? 'character' : 'characters'} left`
export const sheetPickHint = (name: string): string =>
  `Click the turn in the transcript where ${name} said yes. Notula keeps the words, never the audio.`
export const sheetPicking = (name: string): string => `Picking the moment ${name} agreed`
export const sheetBackToSheet = (): string => 'Back to the sheet'
export const sheetPickNoNote = (): string => 'To pick the moment, record the agreement from the meeting where it was said.'
export const sheetPicked = (speaker: string, time: string): string => `${speaker} at ${time}`
export const sheetPickedAt = (time: string): string => `The turn at ${time}`
export const sheetChange = (): string => 'Change'
export const sheetRemove = (): string => 'Remove'
export const sheetAskFirstHint = (): string =>
  'Ask first leaves this speaker unnamed until you record the agreement on the person’s page.'
export const sheetCouldntRecord = (): string => 'Couldn’t record the agreement. Try again.'
export const sheetCouldntCopy = (): string => 'Couldn’t copy the message. Try again.'
export const sheetCouldntAsk = (): string => 'Couldn’t save the request. Try again.'
export const languageLabel = (): string => 'Language'
/** The sender's name, asked for while the profile has none. */
export const sheetYourName = (): string => 'Your name'
export const sheetYourNamePlaceholder = (): string => 'Your full name'
export const sheetYourNameHint = (): string => 'The message is signed with it. Notula saves it to your profile.'

// ---------- Settings ▸ Speaker tags ----------

export const settingsTitle = (): string => 'Speaker tags'
export const settingsNamingDescription = (): string =>
  'After a meeting, Notula puts names on the speakers in the transcript. You can always rename a speaker by hand.'
export const settingsAppNamesDetail = (): string => 'Use the name on the tile of whoever is speaking in Zoom, Teams or Google Meet.'
export const settingsSuggestNamesDetail = (): string => 'After a meeting, Notula sends the transcript to your AI provider, which picks names from what was said, the guest list and up to 10 other people from your notes.'
export const settingsSuggestLocalOnly = (): string => 'Paused while local-only mode is on, because your AI provider is a cloud service.'
/** The international-transfer note, under Suggest names with a cloud provider. */
export const settingsTransferNote = (): string =>
  'Your AI provider may process the transcript outside Brazil. Check that its terms include the ANPD standard clauses.'
export const settingsVoicesCard = (): string => 'Voices'
export const settingsVoicesCardDescription = (): string =>
  'Voices are remembered only on this computer, encrypted, and used only to name speakers in your notes.'
export const settingsRecognizeMyVoiceDetail = (): string => 'Puts “Me” on your turns by your voice. Only your own voice is stored.'
export const settingsComingLaterMac = (): string => 'Coming later on macOS'
export const settingsAdvanced = (): string => 'Advanced'
export const settingsMeetSelectors = (): string => 'Google Meet page selectors'
export const settingsMeetSelectorsDetail = (): string => 'The class names Notula looks for in Meet’s page. Google changes them from time to time.'
export const settingsEdit = (): string => 'Edit'
export const settingsHide = (): string => 'Hide'
export const settingsNeedsSeparation = (): string => 'Needs Separate speakers, which is off.'
export const settingsNeedsModel = (size: string): string => `Needs the voice model (${size}).`
export const settingsNeedsModels = (size: string): string => `Needs the speaker models (${size}).`
export const toastForgotMine = (): string => 'Forgot your voice'

// ---------- Settings ▸ Your voice ----------

export const yourVoiceNoSample = (): string => 'No sample yet. Record one by reading a short passage aloud.'
export const yourVoiceNeedsModel = (): string => 'Needs the voice model first.'
export const yourVoiceSamples = (n: number, date: string | null): string =>
  `Learned from ${n} ${n === 1 ? 'sample' : 'samples'}${date ? `, most recently on ${date}` : ''}.`
export const settingsKeepImprovingDetail = (): string =>
  'After an online meeting, Notula learns a little more of your voice from your microphone. Never after an in-person meeting.'
export const yourVoiceForgetTitle = (): string => 'Forget your voice?'
export const yourVoiceForgetBody = (): string => 'Notula deletes every sample of your voice. Names already in your notes stay. This can’t be undone.'
export const toastForgotOthers = (): string => 'Forgot other people’s voices'
export const forgetAllButton = (): string => 'Forget all…'
export const settingsModelDownloading = (got: string, total: string): string => `Downloading the voice model: ${got} of ${total}.`
export const settingsModelInstalling = (): string => 'Installing the voice model…'
export const settingsModelFailed = (): string => 'The voice model didn’t download.'
export const settingsModelMismatch = (): string => 'The installed voice model isn’t the one Notula was tuned for, so voices only suggest names.'
export const settingsTryAgain = (): string => 'Try again'
export const settingsForgetAllDetail = (): string => 'Deletes every voice sample, yours included.'
export const settingsPeopleWithVoiceCount = (n: number): string => (n === 0 ? 'No one yet' : `${n} ${n === 1 ? 'person' : 'people'}`)
export const settingsOpen = (): string => 'Open'
export const settingsParticipantNoticeDetail = (): string =>
  'A short note for an invite or a chat, saying how Notula names speakers. Fill in how to reach you before sending.'
export const settingsChatNoticeLineDetail = (): string => 'Adds one sentence to the notice Notula posts in the meeting chat. You can edit it afterward.'
export const settingsAdd = (): string => 'Add'
export const settingsMovedFromLabsDetail = (): string => 'Recognize voices, for other people, stays off until you turn it on.'
export const settingsTurnOnVoices = (): string => 'Turn on'
export const settingsKeep = (): string => 'Keep'
export const settingsForgetVoices = (): string => 'Forget voices'
export const settingsAlsoForgetOthersBody = (): string =>
  'Forgetting deletes every remembered voice but yours and ends the agreements. Kept voices go unused, and Notula still forgets each one that’s not recognized in a meeting for 12 months.'
export const settingsAlsoForgetMineBody = (): string => 'Forgetting deletes your voice samples. A kept voice goes unused while this is off.'
export const modelDialogTitle = (): string => 'Download the voice model?'
export const modelDialogBody = (size: string): string =>
  `Recognizing voices uses a ${size} model, CAM++ from the 3D-Speaker project (Apache License 2.0). Notula downloads it once, and it runs only on this computer.`
export const modelDialogConfirm = (): string => 'Download and turn on'
export const preferencesRowDetail = (): string => 'Put names on the speakers in transcripts'
export const enabled = (): string => 'Enabled'
export const off = (): string => 'Off'

// ---------- the person page ----------

export const voiceAgreedNoSample = (name: string): string =>
  `${name} agreed. Notula starts remembering the voice the next time you name ${name} in a meeting with Remember voice on.`
export const voiceStartsNextTime = (name: string): string =>
  `Notula starts remembering ${name}’s voice the next time you name ${name} in a meeting with Remember voice on.`
export const voiceRecognizedNone = (): string => 'Not recognized in a meeting yet'
export const voiceAgreedState = (): string => 'Agreed'
export const voicePendingDetail = (): string => 'When the reply comes, record the agreement here, then name the speaker in each meeting.'
export const voicePendingReady = (): string => 'The agreement is recorded. Name the speaker in each meeting to remember the voice.'
export const voiceCancelRequest = (): string => 'Cancel request'
export const toastRequestCancelled = (name: string): string => `Cancelled the request to ${name}`
export const voiceWithdrewNone = (name: string): string => `${name} withdrew the agreement, so Notula doesn’t remember the voice.`
export const voiceRecordNewAgreement = (): string => 'Record a new agreement…'
export const untitled = (): string => 'Untitled'
export const thisMeeting = (): string => 'this meeting'
/** What a failed action was, for `couldnt`. */
export const failWhat = {
  loadMeetings: (): string => 'load the meetings',
  loadSamples: (): string => 'load the samples',
  removeSample: (): string => 'remove the sample',
  withdraw: (): string => 'withdraw the agreement',
  forget: (): string => 'forget the voice',
  cancelRequest: (): string => 'cancel the request',
  nameIn: (name: string, meeting: string): string => `name ${name} in ${meeting}`,
  changeSetting: (): string => 'change the setting',
  loadMessage: (): string => 'load the message',
  exportRecord: (): string => 'export the agreement record',
  removeRecord: (): string => 'remove the record',
  loadPeople: (): string => 'load people',
  prepareMerge: (): string => 'prepare the merge',
  merge: (): string => 'merge',
  linkEmail: (): string => 'link the email',
  deletePerson: (): string => 'delete the person',
  copyNotice: (): string => 'copy the notice',
  changeNotice: (): string => 'change the meeting notice'
}
export const voiceRecognizeAutomaticallyDetail = (name: string): string => `When off, a voice match only suggests ${name}, and you confirm.`
export const voiceSkippedSamples = (n: number, name: string): string =>
  `Notula skipped ${n} ${n === 1 ? 'sample' : 'samples'} that didn’t sound like ${name}.`
export const voiceSelfDetail = (): string => 'Your own voice. Its switches are in Settings ▸ Speaker tags.'
export const voiceOpenSettings = (): string => 'Speaker settings'
export const voiceHideSamples = (): string => 'Hide samples'
export const voiceHideMeetings = (): string => 'Hide meetings'
export const sampleDeletedMeeting = (): string => 'Deleted meeting'
export const sampleSeconds = (s: number): string => `${s} s`
export const sampleVia: Record<string, () => string> = {
  agreement: () => 'Named after the agreement',
  confirm: () => 'Named in a meeting',
  rename: () => 'Renamed in a meeting',
  sheet: () => 'Named in who’s who',
  sample: () => 'Recorded sample',
  passive: () => 'From an online meeting',
  legacy: () => 'Carried over from Labs'
}
export const toastSampleRemoved = (): string => 'Removed a sample'
export const matchKind: Record<string, () => string> = {
  confirmed: () => 'Named by you',
  auto_voice: () => 'Recognized by voice',
  auto_app: () => 'Named from the meeting app'
}
export const agreementSection = (): string => 'Agreement'
export const agreementMethod: Record<string, () => string> = {
  email: () => 'By email',
  spoken: () => 'Spoken',
  written: () => 'In writing',
  other: () => 'Another way'
}
export const agreementSummary = (method: string, date: string): string => `${method}, recorded ${date}`
export const agreementMessageLine = (language: string, version: string): string => `${language} message (${version})`
export const agreementWithReply = (): string => 'Reply attached'
export const agreementEnded = (date: string): string => `Ended ${date}`
export const agreementRecordedOn = (date: string): string => `Recorded ${date}`
/** Why an agreement ended: the line under the record's dates. */
export const agreementEndedVia: Record<string, (name: string) => string> = {
  forget: () => 'Ended when the voice was forgotten',
  forget_all: () => 'Ended when all voices were forgotten',
  withdrawn: (name) => `${name} withdrew the agreement`,
  expired: () => 'Ended after 12 months without a recognition'
}
export const agreementKeptAsProof = (): string => 'Kept as your proof that earlier use was agreed. It holds no voice.'
export const agreementHideMessage = (): string => 'Hide message'
export const agreementReply = (): string => 'Reply'
export const agreementRemoveTitle = (): string => 'Remove the agreement record?'
export const agreementRemoveBody = (name: string): string =>
  `It’s your proof that ${name} agreed. Export it first if you might need it. This can’t be undone.`
export const toastAgreementRecorded = (name: string): string => `Recorded ${name}’s agreement`
export const toastAgreementRemoved = (): string => 'Removed the agreement record'
export const toastAgreementSaved = (): string => 'Saved the agreement record'
export const couldnt = (what: string): string => `Couldn’t ${what}. Try again.`
/** Why Delete person isn't offered, by what still holds the person. */
export const personDeleteBlocked: Record<'voice' | 'voice-record' | 'agreement' | 'record' | 'pending', (name: string) => string> = {
  voice: (name) => `To delete ${name}, forget the voice first.`,
  'voice-record': (name) => `To delete ${name}, forget the voice and remove the agreement record first.`,
  agreement: (name) => `To delete ${name}, withdraw the agreement and remove the record first.`,
  record: (name) => `To delete ${name}, remove the agreement record first.`,
  pending: (name) => `To delete ${name}, cancel the request first.`
}
export const personDeleteTitle = (name: string): string => `Delete ${name}?`
export const personDeleteBody = (): string => 'Names already in your notes stay. This can’t be undone.'
export const toastDeleted = (name: string): string => `Deleted ${name}`
export const mergePickTitle = (name: string): string => `Merge ${name} with…`
export const mergePickSearch = (): string => 'Search people'
export const mergePickNone = (): string => 'No one matches.'
export const toastMerged = (into: string): string => `Merged into ${into}`
export const toastLinked = (email: string): string => `Linked to ${email}`
export const forgetVoiceBody = (name: string): string =>
  `Notula deletes every sample of ${name}’s voice. Names already in your notes stay. This can’t be undone.`

// ---------- People ----------

export const peopleTabVoice = (): string => 'With a voice'
export const peopleVoiceBadge = (): string => 'Voice remembered'

// ---------- the notice card ----------

export const noticeClose = (): string => 'Dismiss'
export const noticeCopied = (): string => 'Copied. Fill in how to reach you before sending.'
export const noticeAdded = (): string => 'Added to your meeting notice'
