// Links used only by /pricing, /download and /licence.
// TODO: move these into src/config.ts once the scaffold (AK-62) merges, so production swaps stay one-line edits.

/** Polar customer portal: devices (activations), licence keys, receipts. Sandbox until production credentials exist. */
export const PORTAL_URL = 'https://sandbox.polar.sh/gitlanes/portal';

/** Macs one licence can be active on at once (the Polar activation limit, AK-45). */
export const MACS_PER_LICENCE = 3;

/** Off until release builds are signed and notarized (AK-41 + Apple Developer account). Switches the install note to the checksum note. */
export const NOTARIZED = false;

/** Minimum macOS from the packaging config. TBD until it's tested on a real Mac running that version. */
export const MIN_MACOS = 'macOS 12 Monterey';
export const MIN_MACOS_VERIFIED = false;
