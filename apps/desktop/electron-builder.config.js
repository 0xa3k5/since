'use strict';
// Packaging for `pnpm dist`. Build-time only: nothing here loads in the app.
//
// Signing switches on by itself when a Developer ID certificate is available, either from
// CSC_LINK (+ CSC_KEY_PASSWORD) in CI or from the login keychain. Notarization then runs through
// notarytool when APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID or
// APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER are set. With none of that, the app is
// ad-hoc signed so it still launches on Apple silicon, and the DMG is marked unsigned.
//
// The version is package.json's unless SINCE_VERSION names a pre-release of it (1.0.1-rc.1).
// release.yml sets it through the environment: a `pnpm dist -- -c.…` argument
// crosses two `pnpm run` layers and some pnpm versions hand electron-builder a literal `--` (AK-571).
const { execFileSync } = require('node:child_process');

// CI passes unset secrets as empty strings, which electron-builder would treat as a certificate path.
for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
  if (process.env[name] === '') delete process.env[name];
}

function hasDeveloperId() {
  if (process.env.CSC_LINK || process.env.CSC_NAME) return true;
  if (process.platform !== 'darwin') return false;
  try {
    return execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }).includes('Developer ID Application');
  } catch { return false; }
}

// There is one update channel now (package.json's feed). Fail closed on an old beta build command.
if (process.env.SINCE_CHANNEL && process.env.SINCE_CHANNEL !== 'release') {
  throw new Error(`SINCE_CHANNEL=${process.env.SINCE_CHANNEL} can't be packaged: the beta channel is gone.`);
}

/** The version to bake from SINCE_VERSION, or '' to keep package.json's. Only `base` itself or a pre-release of it. */
function versionOverride(value, base) {
  if (!value) return '';
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(value)) throw new Error(`SINCE_VERSION=${value} is not a version (expected e.g. ${base}-rc.1).`);
  if (value !== base && !value.startsWith(`${base}-`)) throw new Error(`SINCE_VERSION=${value} is not ${base} or a pre-release of it; bump apps/desktop/package.json first.`);
  return value;
}
const VERSION = versionOverride(process.env.SINCE_VERSION, require('./package.json').version);

const signed = hasDeveloperId();
if (!signed) console.log('  • no Developer ID certificate found: building an unsigned (ad-hoc) DMG');

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.gitsince.app',
  productName: 'Since',
  copyright: 'Copyright (C) 2026 0xa3k5 and Since contributors',
  directories: { output: 'dist', buildResources: 'build' },
  files: ['main.js', 'git.js', 'journal.js', 'ipc.js', 'log-streams.js', 'updater.js', 'ai.js', 'github.js', 'catchup-store.js', 'recent-store.js', 'window-state.js', 'tab-order.js', 'change-facts.js', 'pr-media.js', 'preload.js', 'renderer/**', 'package.json'],
  // The version, when overridden, names the artifacts and is what the updater compares against the feed.
  extraMetadata: VERSION ? { version: VERSION } : {},
  asar: true,
  // In CI a provided certificate must actually be used; never fall back to an unsigned release.
  forceCodeSigning: Boolean(process.env.CSC_LINK),
  electronLanguages: ['en'],
  // Close the ways a signed Electron app can be reused to run other code.
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    enableCookieEncryption: true,
  },
  mac: {
    // The DMG is for first installs; the zip is what auto-update (Squirrel.Mac) downloads.
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }, { target: 'zip', arch: ['arm64', 'x64'] }],
    // Names the zips (the DMG sets its own below). Must match updater.zipName(), which the feed points at.
    artifactName: '${productName}-${version}-${arch}-mac.${ext}',
    category: 'public.app-category.developer-tools',
    icon: 'build/icon.icns',
    minimumSystemVersion: '12.0',
    darkModeSupport: true,
    // Ad-hoc ("-") without hardened runtime when there is no certificate: it can't be notarized anyway,
    // and hardened runtime + ad-hoc would need extra entitlements to launch.
    identity: signed ? undefined : '-',
    hardenedRuntime: signed,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize: signed,
  },
  dmg: {
    title: '${productName} ${version}',
    artifactName: signed ? '${productName}-${version}-${arch}.${ext}' : '${productName}-${version}-${arch}-unsigned.${ext}',
    background: 'build/background.tiff',
    writeUpdateInfo: false,
    iconSize: 112,
    window: { width: 660, height: 400 },
    contents: [
      { x: 180, y: 200, type: 'file' },
      { x: 480, y: 200, type: 'link', path: '/Applications' },
    ],
  },
};
