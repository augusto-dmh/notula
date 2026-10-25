// SPDX-License-Identifier: Apache-2.0
// Per-key validators for the preference store. Used on both sides: main drops
// invalid `prefs:set` values, and the storage worker moves stored
// rows that fail them to `settings_rejected`. Keep this file free of
// Electron imports: the notula-storage utility process bundles it.

import { DICTATION_LANGUAGE_LISTS, DICTATION_LIMITS } from '@shared/types/dictation'
import { DEFAULT_SETTINGS, JARGON_LIMITS, type SettingKey, type Settings } from '@shared/types/settings'
import { SOURCES_LIMITS } from '@shared/types/sources'

type Validator = (v: unknown) => boolean

const oneOf =
  (...values: readonly string[]): Validator =>
  (v) =>
    typeof v === 'string' && values.includes(v)

const bool: Validator = (v) => typeof v === 'boolean'

const text =
  (max: number, opts: { nonEmpty?: boolean } = {}): Validator =>
  (v) =>
    typeof v === 'string' && v.length <= max && (!opts.nonEmpty || v.trim().length > 0)

const httpUrl: Validator = (v) => {
  if (typeof v !== 'string' || v.length > 2048) return false
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const jargonTerm = (v: unknown): boolean => {
  if (typeof v !== 'string') return false
  const t = v.trim()
  return (
    t.length >= JARGON_LIMITS.minChars &&
    t.length <= JARGON_LIMITS.maxChars &&
    t.split(/\s+/).length <= JARGON_LIMITS.maxWords
  )
}

const PERMISSION_STATES = ['unknown', 'granted', 'denied'] as const

const isoTime = (v: unknown): boolean => typeof v === 'string' && v.length <= 64 && !Number.isNaN(Date.parse(v))

const nullOrIso: Validator = (v) => v === null || isoTime(v)

const integer =
  (min: number, max: number): Validator =>
  (v) =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

const nullOr =
  (inner: Validator): Validator =>
  (v) =>
    v === null || inner(v)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const isRect = (v: unknown): boolean =>
  isObject(v) && ['x', 'y', 'width', 'height'].every((k) => typeof v[k] === 'number' && Number.isFinite(v[k]))

const RECIPE_VIEWS = ['upcoming-meeting', 'live-meeting', 'meeting', 'multi-meeting'] as const

const contextTokens = integer(4_096, 2_000_000)

/** A lower-case DNS name with at least one dot (punycode allowed). */
const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

/** A CSS class name the Meet reader may look for (attribution.meetSelectors). */
const CSS_CLASS = /^[A-Za-z0-9_-]{1,64}$/

// ---------- helpers ----------

const RETENTION_HOURS = [24, 168, 720, 2160, 4320, 8760] as const
const retentionHours: Validator = (v) => typeof v === 'number' && (RETENTION_HOURS as readonly number[]).includes(v)

/** Lower-case emails or DNS names, at most `max`, unique. */
const lowerList =
  (max: number, item: RegExp): Validator =>
  (v) =>
    Array.isArray(v) &&
    v.length <= max &&
    new Set(v).size === v.length &&
    v.every((x) => typeof x === 'string' && x.length <= 254 && x === x.toLowerCase() && item.test(x))

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** ≤ 50 unique first names ignoring case after NFC; each 1–50 characters. */
const nameDictionary: Validator = (v) =>
  Array.isArray(v) &&
  v.length <= 50 &&
  v.every((x) => typeof x === 'string' && x.trim().length >= 1 && x.length <= 50) &&
  new Set(v.map((x: string) => x.normalize('NFC').toLowerCase())).size === v.length

const record =
  (maxKeys: number, maxKeyChars: number, value: Validator): Validator =>
  (v) =>
    isObject(v) &&
    Object.keys(v).length <= maxKeys &&
    Object.entries(v).every(([k, x]) => k.length <= maxKeyChars && value(x))

/** `channel:<name>` or `site:<host>`, at most 200, unique. */
const sourceMutes: Validator = (v) =>
  Array.isArray(v) &&
  v.length <= SOURCES_LIMITS.mutes &&
  new Set(v).size === v.length &&
  v.every((x) => typeof x === 'string' && x.length <= SOURCES_LIMITS.muteChars && /^(channel|site):\S/.test(x))

/** `<hint>:<key>` (`sources:dismiss-hint`). */
const SOURCE_HINT_KEY = /^(course-host|file-rule|same-as):[^\s]{1,300}$/

const ASR_IDS = ['deepgram', 'assemblyai', 'local'] as const
const LLM_IDS = ['anthropic', 'openai', 'local'] as const

/** Transcription rules: at most 50 rules with unique ids. */
const transcriptionRules: Validator = (v) => {
  if (!Array.isArray(v) || v.length > 50) return false
  const ids = new Set<string>()
  for (const r of v) {
    if (!isObject(r) || typeof r['id'] !== 'string' || r['id'].length < 1 || r['id'].length > 64 || ids.has(r['id'])) return false
    ids.add(r['id'])
    if (!bool(r['enabled']) || !oneOf('confirm', 'override', 'block')(r['action'])) return false
    const c = r['condition']
    if (!isObject(c) || typeof c['type'] !== 'string' || c['type'].length > 64) return false
    for (const key of ['domains', 'emails', 'strings'] as const) {
      if (c[key] !== undefined && !shortStrings(500, 254)(c[key])) return false
    }
    const p = r['presentation']
    if (!isObject(p) || !(p['text'] === null || text(500)(p['text']))) return false
    const link = p['link']
    if (!(link === null || (isObject(link) && text(100, { nonEmpty: true })(link['label']) && httpUrl(link['url'])))) return false
  }
  return true
}

const DICTATION_CATEGORIES = ['email', 'work', 'casual', 'other'] as const
const DICTATION_TONES = ['formal', 'casual', 'relaxed', 'excited'] as const

const shortStrings =
  (maxItems: number, maxChars: number): Validator =>
  (v) =>
    Array.isArray(v) && v.length <= maxItems && v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= maxChars)

const VALIDATORS: { [K in SettingKey]: Validator } = {
  'asr.provider': oneOf('deepgram', 'assemblyai', 'local'),
  'asr.language': oneOf('en', 'multi', 'pt-BR'),
  'asr.local.model': oneOf('auto', 'parakeet-tdt-110m-en-int8', 'parakeet-tdt-0.6b-v3-int8', 'whisper-large-v3-turbo-int8'),
  'asr.local.prefer': oneOf('accuracy', 'speed'),
  'asr.keywords': (v) => Array.isArray(v) && v.length <= JARGON_LIMITS.maxTerms && v.every(jargonTerm),
  'asr.deepgram.model': text(200, { nonEmpty: true }),
  'asr.deepgram.mipOptOut': bool,
  'asr.assemblyai.region': oneOf('edge', 'us', 'eu'),
  'capture.inputPreference': (v) =>
    isObject(v) &&
    (v['mode'] === 'auto' ||
      (v['mode'] === 'physical-device' && typeof v['deviceId'] === 'string' && v['deviceId'].length > 0)),
  'capture.sounds': bool,
  'llm.provider': oneOf('anthropic', 'openai', 'local'),
  'llm.anthropic.model': text(200, { nonEmpty: true }),
  'llm.openai.model': text(200),
  'llm.openai.baseUrl': httpUrl,
  'llm.local.model': text(200),
  'llm.local.baseUrl': httpUrl,
  'enhance.summaryLanguage': oneOf('en', 'multi'),
  'profile.name': text(500),
  'profile.email': text(500),
  'profile.company': text(500),
  'profile.jobTitle': text(500),
  'profile.companyDescription': text(5000),
  'ui.theme': oneOf('system', 'light', 'dark'),
  'app.openAtLoginInitialized': bool,
  'onboarding.aiProvidersDoneAt': (v) => v === null || (typeof v === 'string' && !Number.isNaN(Date.parse(v))),
  'permissions.record': (v) =>
    isObject(v) &&
    oneOf(...PERMISSION_STATES)(v['microphone']) &&
    oneOf(...PERMISSION_STATES)(v['systemAudio']) &&
    typeof v['requestingSystemAudio'] === 'boolean',
  'notifications.scheduledBlocked': bool,
  'notifications.autoDetectedBlocked': bool,
  'notifications.silencedAppIds': (v) =>
    Array.isArray(v) && v.length <= 500 && v.every((x) => typeof x === 'string' && x.length <= 500),

  'ui.sidebar': (v) => isObject(v) && typeof v['open'] === 'boolean' && integer(200, 420)(v['width']),
  'tray.showUpcomingEventInMenuBar': bool,
  'onboarding.calendarDoneAt': nullOrIso,
  'bubble.blocked': bool,
  'bubble.position': (v) => v === null || (isObject(v) && isRect(v['bounds']) && isRect(v['display'])),
  'meetings.detectionEnabled': bool,
  'meetings.autostartDetected': bool,
  'capture.inactivityWarningMinutes': nullOr(integer(1, 120)),
  'capture.inactivityAutoStopMinutes': nullOr(integer(1, 240)),
  'capture.autoStopWhenMeetingAppCloses': bool,
  'capture.llmAutoStop': bool,
  'capture.restartOnStillHere': bool,
  'transcription.diarization': bool,
  'asr.deepgram.multilingualVersion': oneOf('default', '58-lang-beta'),
  'asr.assemblyai.multilingualModel': oneOf('universal-3-5-pro', 'universal-3-6-pro'),
  'templates.favoriteIds': (v) => Array.isArray(v) && v.length <= 500 && v.every((x) => typeof x === 'string' && UUID.test(x)),
  'templates.usage': (v) =>
    isObject(v) &&
    Object.keys(v).length <= 500 &&
    Object.values(v).every((times) => Array.isArray(times) && times.length <= 10 && times.every(isoTime)),
  'recipes.recent': (v) =>
    isObject(v) &&
    Object.entries(v).every(
      ([view, ids]) =>
        oneOf(...RECIPE_VIEWS)(view) &&
        Array.isArray(ids) &&
        ids.length <= 5 &&
        ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 200)
    ),
  'chat.model.single': text(200, { nonEmpty: true }),
  'chat.model.multi': text(200, { nonEmpty: true }),
  'chat.contextTokens.anthropic': contextTokens,
  'chat.contextTokens.openai': contextTokens,
  'chat.contextTokens.local': contextTokens,
  'chat.noTools': (v) =>
    Array.isArray(v) &&
    v.length <= 50 &&
    v.every((x) => typeof x === 'string' && x.length <= 300 && /^[a-z]+:.+$/.test(x)),

  'calendar.filterPersonalEvents': bool,
  'people.gravatarEnabled': bool,
  'people.genericEmailDomains': (v) =>
    Array.isArray(v) && v.length <= 500 && v.every((x) => typeof x === 'string' && DOMAIN.test(x)),
  'folders.useTimestamps': (v) =>
    isObject(v) &&
    Object.keys(v).length <= 1_000 &&
    Object.values(v).every((times) => Array.isArray(times) && times.length <= 10 && times.every(isoTime)),
  'folders.ignoredSeries': shortStrings(2_000, 1_024),
  'folders.sidebar': (v) =>
    isObject(v) &&
    typeof v['myNotesExpanded'] === 'boolean' &&
    typeof v['favoritesOpen'] === 'boolean' &&
    typeof v['showAll'] === 'boolean' &&
    shortStrings(10_000, 200)(v['collapsedFolderIds']),
  'folders.aiSuggestions': bool,

  'attribution.zoom': bool,
  'attribution.teams': bool,
  'attribution.meet': bool,
  'attribution.meetSelectors': nullOr(
    (v) =>
      isObject(v) &&
      ['galleryTileClass', 'selfPreviewClass', 'speakingIndicatorClass'].every(
        (k) => typeof v[k] === 'string' && CSS_CLASS.test(v[k])
      ) &&
      ['talkingMeansActive', 'selfByNameMatch', 'selfFromMeetingControls'].every((k) => typeof v[k] === 'boolean')
  ),
  'speakerNames.suggestions': bool,
  'audio.keepRecordings': bool,
  'audio.retention': oneOf('1d', '7d', '30d', '90d', '365d', 'note'),
  'captions.alwaysOn': bool,
  'actionItems.enabled': bool,
  'actionItems.lineDrafts': bool,
  'tags.classify': bool,
  'attachedLinks.enabled': bool,
  'followUpEmail.enabled': bool,
  'followUpEmail.auto': bool,
  'scratchpad.enabled': bool,
  'prepBrief.enabled': bool,
  'prepBrief.inChat': bool,
  'onboarding.demoStarted': bool,
  'screenSnapshots.enabled': bool,
  'screenSnapshots.confirmedAt': nullOrIso,
  'screenSnapshots.firstCaptureDone': bool,
  'bubbleSnapshots.enabled': bool,
  'quickAsk.enabled': bool,
  'shortcuts.quickAsk': nullOr(text(100, { nonEmpty: true })),
  'shortcuts.newNote': nullOr(text(100, { nonEmpty: true })),
  'companies.faviconsEnabled': bool,
  'companies.sidebarFavorites': bool,
  'companies.favorites': (v) =>
    Array.isArray(v) &&
    v.length <= 200 &&
    v.every((f) => isObject(f) && typeof f['domain'] === 'string' && DOMAIN.test(f['domain']) && text(200)(f['name'])),
  'llm.openai.acceptsImages': bool,
  'llm.local.acceptsImages': bool,
  'integrations.slack.mode': oneOf('bot', 'webhook'),
  'integrations.slack.aiDraft': bool,
  'integrations.affinity.domain': text(253),
  'integrations.zapier.folderRunIds': (v) =>
    Array.isArray(v) && v.length <= 10_000 && v.every((x) => typeof x === 'string' && UUID.test(x)),
  'mcpClient.enabled': bool,
  'mcpServer.enabled': bool,
  'mcpServer.stdio': bool,
  'mcpServer.http': bool,
  'mcpServer.port': integer(1_024, 65_535),
  'voiceTyping.enabled': bool,
  'voiceTyping.screenContext': bool,
  'dictation.enabled': bool,
  'dictation.shortcut': nullOr(text(100, { nonEmpty: true })),
  'dictationBar.enabled': bool,
  'dictationBar.snoozeUntil': nullOr(integer(0, Number.MAX_SAFE_INTEGER)),
  'shortcuts.dictationHold': nullOr(text(60)),
  'shortcuts.dictationHandsFree': nullOr(text(60)),
  'shortcuts.recordToggle': nullOr(text(100, { nonEmpty: true })),
  'dictation.language': (v) =>
    v === null ||
    v === 'auto' ||
    (typeof v === 'string' && (DICTATION_LANGUAGE_LISTS.a.includes(v) || DICTATION_LANGUAGE_LISTS.b.includes(v))),
  'dictation.microphone': (v) =>
    v === null ||
    v === 'system-default' ||
    (isObject(v) && text(500, { nonEmpty: true })(v['deviceId']) && text(500)(v['label'])),
  'dictation.asr': oneOf('auto', 'deepgram', 'assemblyai', 'local'),
  'dictation.screenContext': bool,
  'dictation.styles': (v) =>
    isObject(v) &&
    Object.keys(v).length === DICTATION_CATEGORIES.length &&
    DICTATION_CATEGORIES.every((c) => Object.hasOwn(v, c) && (v[c] === null || oneOf(...DICTATION_TONES)(v[c]))),
  'dictation.dictionary': (v) =>
    Array.isArray(v) &&
    v.length <= DICTATION_LIMITS.dictionaryMax &&
    new Set(v.map((t) => (typeof t === 'string' ? t.trim().toLowerCase() : t))).size === v.length &&
    v.every(jargonTerm),
  'dictation.dictionaryRemoved': (v) =>
    Array.isArray(v) && v.length <= 500 && v.every((x) => typeof x === 'string' && x.length <= 50),
  'dictation.failedAudioRetention': nullOr(oneOf('off', '24h', '7d', '14d')),
  'dictation.onboardingCompleted': bool,
  'privacy.localOnly': bool,
  'window.repositionForMeetings': bool,
  'screenCorner.enabled': bool,
  'diagnostics.verboseLogging': bool,
  'consent.enabled': bool,
  'consent.zoom': bool,
  'consent.teams': bool,
  'consent.meet': bool,
  'consent.message': (v) => text(500)(v) && (v as string) === (v as string).trim(),
  'consent.waitForOtherSpeaker': bool,
  'consent.deferTranscription': bool,
  'voiceprint.enabled': bool,
  'voiceprint.passive': bool,
  'transcriptReport.enabled': bool,
  'retention.transcriptHours': nullOr(retentionHours),
  'retention.pendingHours': nullOr(retentionHours),
  'retention.effectiveAt': nullOrIso,
  'retention.noticeShownFor': nullOrIso,
  'meetingDock.enabled': bool,
  'meetingDock.size': (v) => v === null || (isObject(v) && integer(251, 2_000)(v['width']) && integer(162, 2_000)(v['height'])),
  'liveContext.mode': oneOf('off', 'search', 'calendar'),
  'reminders.enabled': bool,
  'recurringRecap.enabled': bool,
  'tasks.enabled': bool,
  'summaryFeedback.enabled': bool,
  'summaryFeedback.lastShownAt': nullOrIso,
  'userContext.enabled': bool,
  'userContext.inSummaries': bool,
  'userContext.inChat': bool,
  'userContext.nameDictionary': nameDictionary,
  'dispatcher.enabled': bool,
  'dispatcher.morningRun': bool,
  'dispatcher.morningHour': integer(0, 23),
  'localApi.enabled': bool,
  'companionCli.enabled': bool,
  'companionCli.allowTranscripts': bool,
  'companionCli.allowFolderWrites': bool,
  'chat.enterBehavior': oneOf('send', 'newline'),
  'ui.appIcon': nullOr(oneOf('black', 'white', 'blue', 'yellow', 'red', 'pink')),
  'nux.enabled': bool,
  'nux.dismissed': record(2_000, 200, isoTime),
  'nux.counters': record(100, 200, integer(0, 1_000_000)),
  'nux.lastSeenVersion': nullOr(text(50)),
  'app.firstRunAt': nullOrIso,
  'updates.channel': oneOf('stable', 'beta'),
  'privacy.localOnlyChangedAt': nullOrIso,
  'privacy.previousProviders': (v) => v === null || (isObject(v) && oneOf(...ASR_IDS)(v['asr']) && oneOf(...LLM_IDS)(v['llm'])),
  'security.deviceLock': bool,
  'security.lockAfterMinutes': (v) => v === null || v === 5 || v === 15 || v === 60,
  'transcriptionRules.enabled': bool,
  'transcriptionRules.rules': transcriptionRules,
  'transcriptionRules.internalDomains': lowerList(200, DOMAIN),
  'automations.enabled': bool,
  'customerCalls.enabled': bool,
  'customerCalls.folderId': (v) => v === null || (typeof v === 'string' && UUID.test(v)),
  'customerCalls.autoAdd': bool,
  'customerCalls.excludedEmails': lowerList(500, EMAIL),
  'customerCalls.excludedDomains': lowerList(500, DOMAIN),
  'calendarWrite.enabled': bool,
  'mail.enabled': bool,
  'connectors.files.enabled': bool,
  'integrations.salesforce.enabled': bool,
  'integrations.salesforce.options': (v) =>
    isObject(v) &&
    oneOf('none', 'create_new', 'match_else_create')(v['eventHandling']) &&
    oneOf('meeting_summary', 'event_description')(v['eventBodySource']) &&
    oneOf('opportunity', 'account', 'none')(v['eventWhatId']) &&
    bool(v['contentNoteEnabled']),
  'integrations.pipedriveAshby.enabled': bool,
  'integrations.pipedrive.activityDone': bool,
  'sources.enabled': bool,
  'sources.detect': bool,
  'sources.offer': oneOf('ask', 'off'),
  'sources.readHistory': bool,
  'sources.onlineLookups': bool,
  'sources.grantAsked': bool,
  'sources.courseHosts': lowerList(SOURCES_LIMITS.courseHosts, DOMAIN),
  'sources.ytDlp': oneOf('managed', 'external', 'off'),
  'sources.videoCaptions': bool,
  'sources.stampPositions': bool,
  'sources.lessonTemplate': bool,
  'sources.autoFile': bool,
  'sources.videosFolder': (v) => v === '' || (typeof v === 'string' && UUID.test(v)),
  'sources.muted': sourceMutes,
  'sources.dismissedHints': (v) =>
    Array.isArray(v) && v.length <= 500 && new Set(v).size === v.length && v.every((x) => typeof x === 'string' && SOURCE_HINT_KEY.test(x)),
  'sources.extensionPreferred': bool,
  'sources.extension.enabled': bool,
  'sources.extension.allowIncognito': bool,
  'sources.extension.captions': bool,
  'sources.extension.coursePages': bool,
  'notesImport.folderMode': oneOf('mirror', 'single', 'none'),
  'notesImport.findSourcesAfter': bool
}

export function isSettingKey(key: unknown): key is SettingKey {
  return typeof key === 'string' && Object.hasOwn(DEFAULT_SETTINGS, key)
}

export function isValidSetting<K extends SettingKey>(key: K, value: unknown): value is Settings[K] {
  return VALIDATORS[key](value)
}

/** Structural equality for JSON-shaped values (the unchanged-value skip). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every(
    (k) => Object.hasOwn(b, k) && sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  )
}
