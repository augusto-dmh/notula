// SPDX-License-Identifier: Apache-2.0
// Meeting detection: apps holding the microphone.
// The macOS helper-bundle and Windows `.exe` maps stay in main (src/main/meetings/apps.ts).

/** An app currently using the microphone. */
export interface MicApp {
  appId: string
  name: string
}

/** `meetings:get-status`: whether the mic-app monitor runs on this machine. */
export interface MeetingDetectionStatus {
  state: 'running' | 'disabled' | 'unavailable' | 'error'
  detail: string | null
  platform: NodeJS.Platform
}

/** The known meeting apps: app id → display name. */
export const MEETING_APPS: Record<string, string> = {
  'com.google.Chrome': 'Chrome',
  'com.google.Chrome.beta': 'Chrome Beta',
  'org.mozilla.firefox': 'Firefox',
  'us.zoom.xos': 'Zoom',
  'com.tinyspeck.slackmacgap': 'Slack',
  'company.thebrowser.Browser': 'Arc',
  'company.thebrowser.dia': 'Dia',
  'com.cisco.webexmeetingsapp': 'Webex',
  'com.microsoft.teams2': 'Microsoft Teams',
  'com.apple.Safari': 'Safari',
  'net.whatsapp.WhatsApp': 'WhatsApp',
  'com.electron.8x8---virtual-office': '8x8 Work',
  'io.aircall.phone': 'Aircall',
  'com.apple.FaceTime': 'FaceTime',
  'com.microsoft.edgemac': 'Microsoft Edge',
  'com.tencent.tencentmeeting': 'VooV Meeting',
  'app.tuple.app': 'Tuple',
  'com.brave.Browser': 'Brave Browser',
  'net.imput.helium': 'Helium',
  'ai.perplexity.comet': 'Comet',
  'com.hnc.Discord': 'Discord',
  'com.vivaldi.Vivaldi': 'Vivaldi',
  'com.openai.atlas': 'ChatGPT Atlas',
  'app.zen-browser.zen': 'Zen Browser',
  'com.electron.dialpad': 'Dialpad',
  'com.electron.uberconference': 'Dialpad Meetings',
  'com.gather.Gather': 'Gather',
  'com.gather.GatherV2': 'Gather V2',
  'com.operasoftware.Opera': 'Opera',
  'com.clickup.desktop-app': 'ClickUp',
  'com.larksuite.larkApp': 'Lark',
  // The Google Meet PWA, under Chrome and its Chrome Beta and Dia variants; those two
  // follow the same `<browser id>.app.<pwa id>` form.
  'com.google.Chrome.app.kjgfgldnnfoeklkmfkjfagphfepbbdan': 'Google Meet',
  'com.google.Chrome.beta.app.kjgfgldnnfoeklkmfkjfagphfepbbdan': 'Google Meet',
  'company.thebrowser.dia.app.kjgfgldnnfoeklkmfkjfagphfepbbdan': 'Google Meet'
}

/** Apps whose detection card says "Call detected" / "Huddle detected" instead of "Meeting detected". */
export const CALL_KIND_APPS = {
  call: ['com.apple.FaceTime', 'net.whatsapp.WhatsApp'],
  huddle: ['com.tinyspeck.slackmacgap']
} as const
