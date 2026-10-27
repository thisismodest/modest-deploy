# Changelog

Every change that affects how it's used, or what it promises. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Help in the terminal: `modest-deploy`, `-h`, or `--help` says how to get started, and
  `modest-deploy help <command>` (or `<command> --help`) gives each command's page: what
  it does and changes, its options, and an example. Asking for help never runs a command.

### Fixed

- `check` missed a Match block allowing root, passwords, or typed answers for an address,
  user, or port it didn't try (such as one outside address). It now reads every Match
  block in sshd's files, and those they include, and fails on any that allows them.

## [0.2.0] - 2026-10-26

### Added

- `--redirect` on `launch` and `add`: domains, such as `www.`, that send visitors to
  the product's own at the same path, and never reach it. A domain can belong to only
  one product, whether as its own or a redirect.

## [0.1.0] - 2026-10-25

The first release: set a server up once, launch products onto it with one command,
and deploy each on every push that passes CI.

- `check`, `install`, `add`, `remove`, `list`, `deploy`, `restart`, `logs`, and
  `backup` on the server, and `launch` from a laptop.
- Deploys on GitHub's signed `workflow_run` messages, of `main`'s newest commit only,
  built by a build user of the product's own, with install scripts off, and switched
  back if the new version doesn't answer.
- Each product sandboxed by systemd as its own user, behind Caddy.
- Nightly copies of every product's SQLite databases.
