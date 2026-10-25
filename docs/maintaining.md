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

## A release

modest-host isn't published to npm: servers run it from a clone of this repository.
A release is a version tag on `main` (only maintainers can make one, by the tag
ruleset), with that version's section of CHANGELOG.md, so a server can be kept on a
known version with `git -C /opt/modest-host checkout v1.2.3`.
