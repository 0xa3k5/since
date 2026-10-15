// Site-wide settings. Copy reads the product name, prices and links from here so a rename,
// a domain or a price change is a one-line edit (website plan §2.4).

/**
 * Canonical origin, no trailing slash. A SITE_URL env var at build time overrides it.
 * TODO: replace the placeholder once the owner buys the domain (after the name is settled).
 * Do not use the owner's personal domain.
 */
export const SITE_URL: string = (globalThis.process?.env?.SITE_URL ?? 'https://example.com').replace(/\/+$/, '');

export const PRODUCT_NAME = 'GitLanes';

/** Beta: false hides everything commercial (prices, buying, trial, licences) and shows Beta tags; true brings pricing back. */
export const SHOW_PRICING = false;

/**
 * Polar checkout link. Sandbox until the owner provides production credentials.
 * Sandbox checkout link from AK-61; swap for the production link when the owner provides it.
 */
export const BUY_URL = 'https://sandbox-api.polar.sh/v1/checkout-links/polar_cl_GXfjUuuabta8yx92TtKJEfyhrxLfblsgkgPm50EjZod/redirect';

/** Latest DMG. Assumes the public releases-only repo from the website plan (D6). */
export const DOWNLOAD_URL = 'https://github.com/0xa3k5/gitlanes-releases/releases/latest';

/** One-time price in USD: the launch price, and the price after it goes up. */
export const PRICE_NOW = 19;
export const PRICE_LATER = 29;

/** Length of the free trial, in days. */
export const TRIAL_DAYS = 14;

/** Off until the owner picks a provider (website plan D7). No analytics script loads while false. */
export const ANALYTICS_ENABLED = false;
