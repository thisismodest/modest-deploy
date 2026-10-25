# Roadmap

Each step adds as little as it can, and lands with tests for every security property
it brings. Nothing here is a promise of a date.

## Now: the core (0.x)

- [ ] Checking GitHub's signed webhook messages, and which ones to act on
- [ ] The deploy listener, which runs nothing it's sent
- [ ] Deploying: fetch, check the commit is the tip of `main`, install, start, check,
      and go back if it fails
- [ ] Each product sandboxed by systemd, with Caddy in front
- [ ] `check`, `install`, `add`, `launch`, `deploy`, `backup`, `list`, and `remove`
- [ ] Tested end to end on Ubuntu with systemd
- [ ] Internal adversarial review, and its findings fixed. Not independent.
- [ ] A site

## Before 1.0

- [ ] Used for real: several products on one server, for a while
- [ ] Published to npm with provenance, from a tag on `main`
- [ ] An independent review of the listener and the deploy
- [ ] The commands settled: from 1.0, breaking changes only in major versions

## Later, maybe

- **Moving a product to a server of its own,** with its data.
- **Other Linux distributions** with systemd, once Ubuntu is solid.

## Never

- A shell, or a command built from anything a message says
- Keys to the server stored in GitHub
- A dashboard, or anything listening that doesn't have to
- Dependencies
