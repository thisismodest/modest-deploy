# Roadmap

Each step adds as little as it can, and lands with tests for every security property
it brings. Nothing here is a promise of a date.

## Now: the core (0.x)

- [x] Checking GitHub's signed webhook messages, and which ones to act on
- [x] The deploy listener, which runs nothing it's sent
- [x] Deploying: fetch, check the commit is the tip of `main`, install, start, check,
      and go back if it fails
- [x] Each app sandboxed by systemd, with its own users, and Caddy in front
- [x] `check`, `install`, `add`, `launch`, `deploy`, `restart`, `logs`, `backup`,
      `list`, and `remove`
- [x] Tested end to end on Ubuntu 26.04 with systemd, in a container
- [x] Internal adversarial review: rounds by AI reviewers each given one angle (the
      webhook and listener, escaping an app, injection and launch, operator
      mistakes, a lead auditor, and verification of each round's fixes), and their
      findings fixed. Not independent.
- [x] A site
- [ ] Tested on a real droplet, end to end, with GitHub itself

## Before 1.0

- [ ] Used for real: several apps on one server, for a while
- [ ] Published to npm with provenance, from a tag on `main`
- [ ] An independent review of the listener and the deploy
- [ ] The commands settled: from 1.0, breaking changes only in major versions

## Later, maybe

- **Apps on Unix sockets,** reachable only by their own user and Caddy, so a
  app that's been broken into can't take another's port on systems whose systemd
  can't stop it (such as Ubuntu 24.04; 26.04's can).

- **Moving an app to a server of its own,** with its data.
- **Other Linux distributions** with systemd, once Ubuntu is solid.

## Never

- A shell, or a command built from anything a message says
- Keys to the server stored in GitHub
- A dashboard, or anything listening that doesn't have to
- Dependencies
