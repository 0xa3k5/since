# Security policy

## Reporting a vulnerability

Please don't open a public issue for a security problem. Report it privately through GitHub:
[Report a vulnerability](https://github.com/0xa3k5/since/security/advisories/new) (the Security tab of
this repository). Include the Since version, your macOS version and the steps to reproduce.

We'll confirm we got it, agree on a fix and a disclosure date with you, and credit you in the
release notes unless you'd rather not be named.

## Supported versions

Security fixes go into the latest release. Since updates itself, so please check you're on the
newest version before reporting.

## Scope

Since runs the system `git` on your repositories, has no accounts and no telemetry, and makes only
the network calls listed in [docs/security.md](docs/security.md). Reports about anything that lets a
repository, a remote or a web page run code, read files outside the repository or make other
network calls are especially welcome.
