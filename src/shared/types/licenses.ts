// SPDX-License-Identifier: Apache-2.0
// Settings ▸ About: Notula's own licence and the bundled notice files
// (LICENSE, NOTICE, MODELS.md, THIRD_PARTY_NOTICES.md).

/** One npm package from THIRD_PARTY_NOTICES.md. */
export interface ThirdPartyPackage {
  name: string
  version: string
  /** SPDX expression(s) as listed, e.g. "MIT" or "MIT, Apache-2.0". */
  license: string
  repository: string
  /** The licence text the package ships; null when it ships none. */
  text: string | null
}

export interface LicensesInfo {
  version: string
  license: 'Apache-2.0'
  copyright: string
  /** The folder the files were read from (the button opens it). */
  folder: string
  /** Each file's text; null when the file is missing. */
  notice: string | null
  models: string | null
  licenseText: string | null
  /** THIRD_PARTY_NOTICES.md's "Bundled outside npm metadata" section, as markdown. */
  bundled: string | null
  packages: ThirdPartyPackage[]
}
