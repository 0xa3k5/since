Polar customer-portal licence-key responses used by `test/licence.test.js`.

- `*-404.json`, `*-422.json`: recorded from `sandbox-api.polar.sh` on 2026-10-13 with an invalid key.
- `activate-200.json`, `validate-200.json`, `activate-403-limit.json`: built from Polar's published
  schemas (`LicenseKeyActivationCreated`, `ValidatedLicenseKey`, `NotPermitted`), because a real one
  needs a sandbox purchase. IDs are the sandbox org/benefit; customer data is made up.
