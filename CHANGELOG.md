# Changelog

Every change that affects how it's used, or what it promises. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## Unreleased

Nothing released yet. Built so far:

- `check`, `install`, `add`, `remove`, `list`, `deploy`, `restart`, `logs`, and
  `backup` on the server, and `launch` from a laptop.
- Deploys on GitHub's signed `workflow_run` messages, of `main`'s newest commit only,
  built by a build user of the product's own, with install scripts off, and switched
  back if the new version doesn't answer.
- Each product sandboxed by systemd as its own user, behind Caddy.
- Nightly copies of every product's SQLite databases.
