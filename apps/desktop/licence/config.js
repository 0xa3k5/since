'use strict';
// Store settings per build.
// - Unpackaged (`npm start`): pick a profile with GITLANES_STORE=sandbox|production|mock; sandbox by default.
// - Packaged: only the profile baked in at build time counts (package.json "gitlanes.store", written by
//   `GITLANES_STORE=… npm run dist`). The environment is ignored and `mock` is never used, so a
//   variable can't unlock a shipped app. A missing bake means production; if production isn't filled
//   in, activation is unavailable rather than falling back to the test store.

const POLICY = {
  trialDays: 14,
  graceDays: 30, // how long a licence works offline after its last good validation
  activationLimit: 3, // Macs per licence; must match the Polar benefit's activation limit
};

const PROFILES = {
  sandbox: {
    provider: 'polar',
    apiBase: 'https://sandbox-api.polar.sh',
    organizationId: '622bb50f-1ac4-49be-bde7-01a9050a6232',
    benefitId: '5f05839d-3d9a-46f0-a674-3f0e871b4b1b',
    checkoutUrl: 'https://sandbox-api.polar.sh/v1/checkout-links/polar_cl_GXfjUuuabta8yx92TtKJEfyhrxLfblsgkgPm50EjZod/redirect',
    portalUrl: 'https://sandbox.polar.sh/gitlanes/portal',
  },
  // Filled in from the owner's production Polar account before the first paid release.
  production: {
    provider: 'polar',
    apiBase: 'https://api.polar.sh',
    organizationId: null,
    benefitId: null,
    checkoutUrl: null,
    portalUrl: null,
  },
  // Offline store for development and screenshots: any key starting with GL-TEST- activates.
  mock: {
    provider: 'mock',
    apiBase: null,
    organizationId: 'mock-org',
    benefitId: 'mock-benefit',
    checkoutUrl: null,
    portalUrl: null,
  },
};

// Profiles a release may be built with.
const RELEASE_PROFILES = ['production', 'sandbox'];

function bakedProfile() {
  try { return require('../package.json').gitlanes?.store; } catch { return undefined; }
}

function profileName(env = process.env, { packaged = false, baked = bakedProfile() } = {}) {
  if (packaged) return RELEASE_PROFILES.includes(baked) ? baked : 'production';
  const name = env.GITLANES_STORE || baked || 'sandbox';
  return PROFILES[name] ? name : 'sandbox';
}

function loadConfig(env = process.env, opts) {
  const name = profileName(env, opts);
  return { profile: name, ...POLICY, ...PROFILES[name] };
}

const isComplete = (p) => Boolean(p && p.provider === 'polar' && p.apiBase && p.organizationId && p.benefitId && p.checkoutUrl && p.portalUrl);

// Build-time check for `npm run dist`: fail closed instead of shipping a build that can't sell or
// that sells through the test store by accident.
function releaseProfile(name) {
  if (!RELEASE_PROFILES.includes(name)) throw new Error(`GITLANES_STORE=${name} can't be packaged. Use production, or sandbox for a test build.`);
  if (!isComplete(PROFILES[name])) throw new Error(`The ${name} store profile in licence/config.js isn't filled in; packaged builds need all of its values.`);
  return name;
}

module.exports = { loadConfig, releaseProfile, isComplete, PROFILES, POLICY };
