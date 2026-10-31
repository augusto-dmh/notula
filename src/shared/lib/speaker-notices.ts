// SPDX-License-Identifier: Apache-2.0
// The texts other people read: the voice agreement message, the
// participant notice and the meeting-chat sentence, in English and Portuguese. Each has a
// version; any change of purpose bumps it and asks again (`style/COPY.md`, section 12).
//
// Shared, so the renderer previews exactly what main copies to the clipboard and records.
// Notula fills `<name>` and `<user>`. It never fills the participant notice's `<contact>`.

import type { SpeakerNoticeLanguage } from '../types/speakers'

/** `speaker_agreements.notice_version` of the message below. */
export const VOICE_AGREEMENT_VERSION = 'voice-agreement-1'
/**
 * The code that starts the `invalid-input` message of `copy-agreement-message` and
 * `record-agreement` while `profile.name` is empty: the message is signed by the user, so it
 * needs the sender's name (LGPD art. 9 III–IV). The renderer matches it with
 * `parseError(err).message.startsWith(...)` and asks for the name.
 */
export const AGREEMENT_SENDER_REQUIRED = 'agreement-sender-required'
/** The participant notice's version. */
export const PARTICIPANT_NOTICE_VERSION = 'participants-1'

const AGREEMENT: Record<SpeakerNoticeLanguage, string> = {
  en: 'Hi <name>, I use Notula, an app on my computer, to take notes in our meetings. With your permission, it can remember what your voice sounds like (a voice signature, not a recording), so your name appears next to what you say in my notes. The signature stays only on my computer, encrypted, and is used for nothing else. It is deleted when you ask, or when it’s not recognized in a meeting for 12 months. Even after that, I keep a copy of this message and your reply as a record of your choice. Saying no changes nothing between us. If you agree, reply with your full name and “I agree”. To withdraw later, reply “remove”. — <user>',
  pt: 'Oi, <name>. Uso o Notula, um app no meu computador, para fazer anotações nas nossas reuniões. Com a sua permissão, ele pode reconhecer a sua voz (uma assinatura de voz, não uma gravação), para que o seu nome apareça junto ao que você diz nas minhas anotações. A assinatura fica só no meu computador, criptografada, e não é usada para mais nada. Ela é apagada quando você pedir, ou quando não for reconhecida em uma reunião por 12 meses. Mesmo depois disso, guardo uma cópia desta mensagem e da sua resposta como registro da sua escolha. Se preferir que não, nada muda entre nós. Se concordar, responda com seu nome completo e “de acordo”. Para desistir depois, é só responder “remover”. — <user>'
}

/** The sentence the provider sentence goes before: the closing contact sentence. */
const CONTACT_SENTENCE_START: Record<SpeakerNoticeLanguage, string> = { en: ' If you’d rather', pt: ' Se preferir' }

const PARTICIPANTS: Record<SpeakerNoticeLanguage, string> = {
  en: 'I use Notula on my computer to transcribe our meetings and take notes. It shows who said what, using the names in the meeting app and what is said in the conversation. If you’d rather it didn’t, tell me at any time: <contact>.',
  pt: 'Uso o Notula no meu computador para transcrever e anotar nossas reuniões. Ele indica quem falou o quê a partir dos nomes que o app da reunião mostra e do que é dito na conversa. Se preferir que não, é só me dizer, a qualquer momento: <contato>.'
}

/** The same notice where no meeting-app reader runs (macOS): the conversation only. */
const PARTICIPANTS_NO_APPS: Record<SpeakerNoticeLanguage, string> = {
  en: 'I use Notula on my computer to transcribe our meetings and take notes. It shows who said what, using what is said in the conversation. If you’d rather it didn’t, tell me at any time: <contact>.',
  pt: 'Uso o Notula no meu computador para transcrever e anotar nossas reuniões. Ele indica quem falou o quê a partir do que é dito na conversa. Se preferir que não, é só me dizer, a qualquer momento: <contato>.'
}

/**
 * Added while Recognize voices is on: the job compares every speaker's voice and keeps the
 * unconfirmed ones up to 14 days (`clusterVectorDays`). Draft, for owner review
 * (`style/COPY.md`, section 13).
 */
const VOICES_SENTENCE: Record<SpeakerNoticeLanguage, string> = {
  en: 'It also compares the voices of everyone in the meeting, on my computer, and keeps them for up to 14 days to suggest names. It keeps a voice longer only if that person agrees.',
  pt: 'Ele também compara as vozes de todos na reunião, no meu computador, e as guarda por até 14 dias para sugerir nomes. Só guarda a voz de alguém por mais tempo se essa pessoa concordar.'
}

/** Added when names from the conversation go to a cloud AI provider. */
const PROVIDER_SENTENCE: Record<SpeakerNoticeLanguage, string> = {
  en: 'An AI service (<provider>) receives the transcript to help with the names.',
  pt: 'Um serviço de IA (<provider>) recebe a transcrição para ajudar com os nomes.'
}

/** The sentence appended once to `consent.message`. */
export const CHAT_NOTICE_SENTENCE: Record<SpeakerNoticeLanguage, string> = {
  en: 'Notula also shows who said what, from the names in the meeting app and the conversation.',
  pt: 'O Notula também indica quem falou o quê a partir dos nomes do app da reunião e da conversa.'
}

/** The chat sentence where no meeting-app reader runs (macOS). */
export const CHAT_NOTICE_SENTENCE_NO_APPS: Record<SpeakerNoticeLanguage, string> = {
  en: 'Notula also shows who said what, from the conversation.',
  pt: 'O Notula também indica quem falou o quê a partir da conversa.'
}

/** The agreement message as shown and recorded, with the names filled in. */
export function voiceAgreementMessage(language: SpeakerNoticeLanguage, names: { name: string; user: string }): string {
  return AGREEMENT[language].replaceAll('<name>', names.name).replaceAll('<user>', names.user)
}

/**
 * The participant notice. `provider` is the cloud provider's display name when names from the
 * conversation are on with a cloud provider, else null. `meetingApps` is false where the
 * meeting-app readers can't run (macOS), so the notice doesn't claim them. `voices`: Recognize
 * voices is on. The contact placeholder stays for the user to fill.
 */
export function participantNotice(language: SpeakerNoticeLanguage, provider: string | null, meetingApps = true, voices = false): string {
  const base = (meetingApps ? PARTICIPANTS : PARTICIPANTS_NO_APPS)[language]
  const added = [
    ...(voices ? [VOICES_SENTENCE[language]] : []),
    ...(provider ? [PROVIDER_SENTENCE[language].replace('<provider>', provider)] : [])
  ]
  if (!added.length) return base
  const cut = base.lastIndexOf(CONTACT_SENTENCE_START[language])
  return `${base.slice(0, cut)} ${added.join(' ')}${base.slice(cut)}`
}
