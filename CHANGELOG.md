# Changelog

Every change that affects how it's used, or what it promises. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Memory set aside for each product: 512M, or what `--memory` gives on `add` and
  `launch` (such as `1G`, or `max` for all that's left). It's the product's alone and
  its ceiling, and a product is added only if it fits beside the others, as the server
  keeps a quarter of its memory for itself (never under 384M). Together, products can't
  run the server out of memory, and one can't take another's.
- `modest-deploy resize <name> --memory <size>`: more memory for a product, or less, if
  it fits.
- `modest-deploy list --server a,b`: every server's products, from your computer.
- `check` finds products given more memory than the server has for them.
- Without `gh`, or signed out of it, `launch` changes nothing: it says how to get it, or
  how to do the same by hand, with the product's own `add` command for the server.

### Changed

- `list` shows each product's memory and how much is given out, and needs no sudo.
- Each product's Node thread pool is sized to the server's cores (the cores and two, at
  most 18), so modest-auth 0.5.0 and later can hash a password on each core.
- The deploy service builds within its share of the server's own memory (from 192M to
  1G), not a fixed 1G: on a small server, a build no longer takes products' memory.
- Settings from before memory was given out have 512M, as every product had. A server
  whose products now add up to more than it has for them is found by `check` (so
  `install` and `add` stop, unless `--anyway`): give some less with `resize`.

## [0.3.0] - 2026-10-27

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
