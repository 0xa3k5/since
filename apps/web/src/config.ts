// Site-wide settings. Copy reads the product name, prices and links from here so a rename,
// a domain or a price change is a one-line edit (website plan §2.4).

/**
 * Canonical origin, no trailing slash. A SITE_URL env var at build time overrides it.
 * TODO: replace the placeholder once the owner buys the domain (after the name is settled).
 * Do not use the owner's personal domain.
 */
export const SITE_URL: string = (globalThis.process?.env?.SITE_URL ?? 'https://example.com').replace(/\/+$/, '');

export const PRODUCT_NAME = 'GitLanes';

/**
 * Polar checkout link. Sandbox until the owner provides production credentials.
 * TODO: replace REPLACE_ME with the sandbox checkout-link id once the Polar product exists.
 */
export const BUY_URL = 'https://sandbox-api.polar.sh/v1/checkout-links/REPLACE_ME/redirect';

/** Latest DMG. Assumes the public releases-only repo from the website plan (D6). */
export const DOWNLOAD_URL = 'https://github.com/0xa3k5/gitlanes-releases/releases/latest';

/** One-time price in USD: the launch price, and the price after it goes up. */
export const PRICE_NOW = 19;
export const PRICE_LATER = 29;

/** Off until the owner picks a provider (website plan D7). No analytics script loads while false. */
export const ANALYTICS_ENABLED = false;
