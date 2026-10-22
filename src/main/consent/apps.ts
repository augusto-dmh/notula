// SPDX-License-Identifier: Apache-2.0
// Meeting-app ids from the mic list (the meeting detector's known apps) that these features read:
// the notice's channels (consent) and the meeting classification (voiceprint).

export const ZOOM_ID = 'us.zoom.xos'
export const TEAMS_ID = 'com.microsoft.teams2'
export const MEET_PWA = '.app.kjgfgldnnfoeklkmfkjfagphfepbbdan'
/** Browsers that can hold a Google Meet call (from the meeting detector's known apps). */
export const BROWSER_IDS = new Set([
  'com.google.Chrome',
  'com.google.Chrome.beta',
  'org.mozilla.firefox',
  'company.thebrowser.Browser',
  'company.thebrowser.dia',
  'com.apple.Safari',
  'com.microsoft.edgemac',
  'com.brave.Browser',
  'net.imput.helium',
  'ai.perplexity.comet',
  'com.vivaldi.Vivaldi',
  'com.openai.atlas',
  'app.zen-browser.zen',
  'com.operasoftware.Opera'
])
