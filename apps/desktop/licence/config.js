'use strict';
// Store settings per build. Sandbox is the default until production values exist.
// Pick a profile with GITLANES_STORE=sandbox|production|mock at run time, or bake one into
// a release with `GITLANES_STORE=production npm run dist` (written to package.json "gitlanes.store").

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

function profileName(env = process.env) {
  let baked;
  try { baked = require('../package.json').gitlanes?.store; } catch { /* not packaged */ }
  const name = env.GITLANES_STORE || baked || 'sandbox';
  return PROFILES[name] ? name : 'sandbox';
}

function loadConfig(env = process.env) {
  const name = profileName(env);
  return { profile: name, ...POLICY, ...PROFILES[name] };
}

module.exports = { loadConfig, PROFILES, POLICY };
