// Links used only by /pricing, /download and /licence.
// TODO: move these into src/config.ts once the scaffold (AK-62) merges, so production swaps stay one-line edits.

/** Polar customer portal: devices (activations), licence keys, receipts. Sandbox until production credentials exist. */
export const PORTAL_URL = 'https://sandbox.polar.sh/gitlanes/portal';

/** Beta builds are signed and notarized (AK-424), so the install note says they open without warnings. */
export const NOTARIZED = true;

/** Minimum macOS from the packaging config. TBD until it's tested on a real Mac running that version. */
export const MIN_MACOS = 'macOS 12 Monterey';
export const MIN_MACOS_VERIFIED = false;
