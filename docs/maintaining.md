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

## npm

- **Trusted publishing** (npmjs.com → the package → Settings → Trusted publishing):
  GitHub Actions, this repository, workflow `release.yml`, environment `npm`, and
  only `npm publish` allowed. Then, in the package's publishing access, require
  two-factor authentication and disallow tokens, so the workflow is the only way to
  publish.
- **The `npm` environment** (Settings → Environments) is limited to tags matching
  `v*`, and only maintainers can make those (the tag ruleset).
- **The first release** (0.1.0) is published by hand, because npm sets up trusted
  publishing only for a package that already exists: on a clean clone of `main`, with
  Node 24, `npm ci`, `npm run check` (`.npmrc` turns off `prepublishOnly`, so run it
  yourself), then `npm publish --access public --provenance=false`.

## A release

1. Update CHANGELOG.md: move "Unreleased" under `## [1.2.3] - date`.
2. Set the version: `npm version 1.2.3 --no-git-tag-version`.
3. Commit, push, then tag the commit and push the tag: `git tag -a v1.2.3 -m v1.2.3`.
4. The release workflow checks the tag matches the version and is on `main`, runs
   every check, publishes with provenance, and makes a GitHub Release with that
   version's notes. A server that runs it from a clone can be kept on a version with
   `git -C /opt/modest-deploy checkout v1.2.3`.
