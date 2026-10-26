// Site-wide settings. Copy reads the product name and links from here so a rename or a domain
// change is a one-line edit (website plan §2.4).

/**
 * Canonical origin, no trailing slash. A SITE_URL env var at build time overrides it.
 */
export const SITE_URL: string = (globalThis.process?.env?.SITE_URL ?? 'https://gitsince.com').replace(/\/+$/, '');

export const PRODUCT_NAME = 'Since';

/** The source code. Since is free and open source. */
export const REPO_URL = 'https://github.com/0xa3k5/since';

/** The open-source licence (SPDX id) and its full text in the repo. */
export const LICENCE_NAME = 'GPL-3.0-or-later';
export const LICENCE_URL = `${REPO_URL}/blob/main/LICENSE`;

export const COPYRIGHT = 'Copyright (C) 2026 0xa3k5 and Since contributors';

/** DMGs from the latest GitHub Release, one per chip (fixed-name aliases attached by release.yml, see
 * docs/releasing.md). DOWNLOAD_URL is Apple silicon. */
const RELEASE_LATEST = `${REPO_URL}/releases/latest/download`;
export const DOWNLOAD_URL = `${RELEASE_LATEST}/Since-arm64.dmg`;
export const DOWNLOAD_URL_INTEL = `${RELEASE_LATEST}/Since-x64.dmg`;

/** Releases are signed and notarized in CI, so the install note says they open without warnings. */
export const NOTARIZED = true;

/** Minimum macOS from the packaging config. TBD until it's tested on a real Mac running that version. */
export const MIN_MACOS = 'macOS 12 Monterey';
export const MIN_MACOS_VERIFIED = false;

/** Off until the owner picks a provider (website plan D7). No analytics script loads while false. */
export const ANALYTICS_ENABLED = false;
