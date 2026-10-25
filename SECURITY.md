# Security

modest-host runs code on servers, from messages sent over the internet. A report that
shows it can be made to run the wrong thing, or reach what it shouldn't, is the most
useful contribution there is.

## Reporting a vulnerability

**Please don't describe it in a public issue.** Report it privately through GitHub:
the repository's **Security** tab → **Report a vulnerability**. Include what you found,
how to reproduce it, and what an attacker could do with it.

If that isn't offered, open an issue that says only that you have a security report
(no details), and the maintainer will arrange a private way to receive it.

You'll hear back within 5 working days. Once a fix is ready, it's released, an
advisory is published (crediting you, if you'd like), and the affected versions are
named.

## Supported versions

Until 1.0, only the latest release gets fixes.

## In scope

Anything that breaks a promise in [README.md](README.md) or
[docs/threat-model.md](docs/threat-model.md), for example:

- getting the server to deploy, run, or install anything that isn't a commit on
  `main` that passed CI;
- a deploy message accepted without a valid signature;
- one product reading or changing another's code, data, or keys, or the server's;
- a key or secret appearing anywhere it shouldn't (logs, errors, the repository).

## Out of scope

The server's own setup, which modest-host checks but doesn't do (see "Before you
install" in the README), and the products themselves. Reports of setup mistakes
`modest-host check` could catch are still welcome, as ordinary issues.

## What we do to stay secure

- No runtime dependencies, and development tools installed with their install scripts
  turned off (`.npmrc`).
- CI fails if a runtime dependency is ever added, if anything but Node's own modules
  is imported, if a code file holds an invisible or direction-changing character
  ("Trojan Source"), or if an address, key, or token is committed.
- CodeQL's security queries run on every change, and weekly.
- Every security property has a test, which must pass before anything is merged.
- GitHub Actions are pinned to exact commits.
- OpenSSF Scorecard grades the project's practices weekly.
- Releases are published to npm only by the release workflow, from a version tag on
  `main`, after every check, using npm's trusted publishing (no token is stored), with
  provenance linking each one to the commit and build that made it. Only the
  maintainer can create release tags, and `main` can't be force-pushed. (The first
  release, 0.1.0, is published by hand, without provenance: see docs/maintaining.md.)
- An end-to-end test runs it on Ubuntu with systemd on every change.
