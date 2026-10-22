// SPDX-License-Identifier: Apache-2.0
// The update feed baked into builds when NOTULA_UPDATE_FEED_URL is unset: the latest
// GitHub release of the public, installer-only repo. electron-updater's generic provider reads
// `<feed>/latest.yml` and the installer next to it; GitHub redirects both to the release assets.

const RELEASES_REPO = 'augusto-dmh/notula-releases'
const DEFAULT_UPDATE_FEED_URL = `https://github.com/${RELEASES_REPO}/releases/latest/download`

module.exports = { RELEASES_REPO, DEFAULT_UPDATE_FEED_URL }
