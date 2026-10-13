// Facts shared by the legal pages (AK-65), so privacy, terms, EULA and refunds can't drift apart.
// Values marked OWNER/LAWYER TO CONFIRM are placeholders; they render visibly on the pages.
import { SITE_URL } from '../../config';

/** Support address. hello@<domain> follows SITE_URL, so it becomes real when the domain is bought. */
export const CONTACT_EMAIL = `hello@${new URL(SITE_URL).hostname}`;
/** Security reports go to the same inbox, tagged by subject line. */
export const SECURITY_SUBJECT = 'Security report';

/** The licensor: the owner, an individual, until a company exists. */
export const LICENSOR = 'Ali Kemal Akçay';
export const LICENSOR_COUNTRY = 'Turkey';

export const CONFIRM = '[OWNER/LAWYER TO CONFIRM]';
/** Rendered next to CONFIRM until a lawyer signs off. */
export const GOVERNING_LAW = 'the laws of the Republic of Turkey';
export const VENUE = 'the courts of Istanbul, Turkey';

/** Must match the pricing page (AK-64) and the Polar activation limit (AK-45). */
export const MACS_PER_LICENCE = 3;
export const TRIAL_DAYS = 14;
/** AK-32 §6 recommends 30 days; Polar may also refund within 60 days at its discretion. */
export const REFUND_DAYS = 30;
/** How long the app keeps working offline after its last successful licence check (AK-45). */
export const OFFLINE_GRACE_DAYS = 30;

export const POLAR_TERMS = 'https://polar.sh/legal/checkout-buyer-terms';
export const POLAR_PRIVACY = 'https://polar.sh/legal/privacy';
