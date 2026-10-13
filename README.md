# GitLanes

A fast, keyboard-first Git client for macOS, plus its website.

| Path | What |
|---|---|
| `apps/desktop` | The Electron app ([README](apps/desktop/README.md)) |
| `apps/web` | The website (not started yet) |
| `packages/*` | Shared code, when there is some |

    npm install
    npm run desktop [-- path/to/repo]
    npm test
    npm run dist        # build the macOS DMGs into apps/desktop/dist

## Building the DMG

`npm run dist` builds `GitLanes.app` and one DMG each for Apple silicon (`arm64`) and Intel (`x64`)
into `apps/desktop/dist/`. It needs macOS.

- **Without a Developer ID certificate** (the default today) you get `GitLanes-<version>-<arch>-unsigned.dmg`.
  The app is ad-hoc signed so it launches on Apple silicon. Gatekeeper still blocks it on other Macs
  until the user right-clicks → Open, or allows it in System Settings → Privacy & Security.
- **With a certificate**, signing switches on by itself. electron-builder looks for it in `CSC_LINK`
  (a base64 `.p12` or its path) plus `CSC_KEY_PASSWORD`, or for a "Developer ID Application" identity in the login keychain.
  The app is then built with hardened runtime and notarized with `notarytool`. Notarization needs either
  `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, or an App Store Connect API key
  (`APPLE_API_KEY` = path to the `.p8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`).

Packaging config lives in `apps/desktop/electron-builder.config.js`, and icon/DMG art in `apps/desktop/build/`.
After editing `icon.svg` or `background.svg`, run `npm run brand-assets -w @gitlanes/desktop` to regenerate
`icon.icns` and `background.tiff`.

### Releases

Push a tag matching the desktop version (e.g. `v0.1.0`). `.github/workflows/release.yml` then builds, signs,
notarizes and uploads both DMGs to a **draft** GitHub Release. Publishing the draft is a manual step.
It reads these repository secrets: `MAC_CERTIFICATE_P12_BASE64`, `MAC_CERTIFICATE_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. Without them, the draft holds unsigned DMGs and is marked as unsigned.
Pull requests that touch packaging, and manual runs, do an unsigned dry run and attach the DMGs as a workflow artifact.
