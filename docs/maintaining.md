# Maintaining

How the repository is set up, so the code that reaches servers is the code that was
reviewed.

## The repository (GitHub settings)

- **A ruleset on `main`:** no force pushes; no deletion; CI, CodeQL, and Scorecard
  passing for pull requests.
- **Private vulnerability reporting on** (Security → Settings), so SECURITY.md's
  link works.
- **Secret scanning and push protection on.**
- **Dependabot alerts on** (the updates themselves are in `.github/dependabot.yml`).
- **Actions:** workflow permissions read-only by default.
- **Pages** from GitHub Actions, for the site in `site/` (published by `pages.yml`).

## A release (once it's ready to publish)

As modest-auth: update CHANGELOG.md, set the version, tag the commit on `main`, and
let a release workflow publish to npm with provenance, using trusted publishing.
