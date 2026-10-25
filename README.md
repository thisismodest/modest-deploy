# modest-host

Host your own small Node products on one server: launch each with a command, and
deploy it on every push that passes CI. No dependencies.

> **In development.** Nothing here is ready to use yet. This README describes what
> it's being built to do.

## Why

Launching a product shouldn't mean setting up hosting again. modest-host does the
same few things for every product, the same way each time, so each new one is a
command, and every push after that deploys itself.

- **No dependencies.** It's written in TypeScript for Node, which the server needs
  anyway for the products. Everything else it uses is already on the server: Caddy,
  git, and systemd.
- **GitHub can't log in to the server.** It sends a signed message when CI passes,
  and that's all. No key to the server is ever stored in GitHub.
- **Each product is fenced off** from the others and from the server.
- **It checks rather than assumes.** Before it does anything, it checks the server
  is set up safely, and says what to fix if not.

## What it does

**Install, once per server.** On a server you've set up (see "Before you install"),
`modest-host install` adds its own parts: the deploy listener, the folder Caddy
reads products' sites from, and the nightly backup.

**Check, any time.** `modest-host check` checks what it relies on, and says plainly
what to fix: Node 24 or later, Caddy, and systemd present; SSH by key only, with no
root login; automatic security updates on; and nothing listening to the outside but
SSH, HTTP, and HTTPS. `install` and `add` won't run while a check fails.

**Launch a product, with one command from your laptop.**
`modest-host launch <name> <domain>`:

- makes the product's GitHub repository, from your template if you name one;
- on the server, gives it a system user, a folder, an environment file for its keys,
  a systemd service, and its domain in Caddy (which gets and renews its HTTPS
  certificate);
- adds a signed webhook to the repository, so a push to `main` that passes CI
  deploys it;
- tells you what's left: pointing the domain's DNS at the server.

**Deploy, on every push to `main` that passes CI.** GitHub sends a signed
"workflow finished" message. The server:

1. ignores anything unsigned, or not a successful run of CI on `main`;
2. fetches the repository, and deploys only if the commit is still the tip of
   `main` (so an old message, sent again, can't roll it back);
3. installs its dependencies exactly as its lockfile says, with install scripts off;
4. starts the new version, checks it answers, and goes back to the previous one if
   it doesn't.

**Look after the products.** Each product's databases are copied every night (with
Node's own SQLite backup), a product that stops is restarted, and logs are kept by
systemd's journal, within a size limit.

## What a product does

A product is a Node app in a GitHub repository that:

- starts with `node server.js`, and listens on `process.env.PORT`;
- keeps everything it writes in `process.env.DATA_DIR` (anything else is read-only);
- answers `GET /` once it's ready;
- has a CI workflow, `.github/workflows/ci.yml`, that runs on pushes to `main`.

## Before you install

modest-host doesn't set up the server itself: your hosting provider and a few
minutes by hand do it better, and `modest-host check` checks the result. On a new
Ubuntu server:

- sign in with an SSH key (add it when creating the server), with password sign-in
  and root sign-in turned off;
- a firewall that lets in only SSH (from your own address, if you can), HTTP, and
  HTTPS;
- automatic security updates on (`unattended-upgrades`);
- Node 24 or later, and Caddy, from their own package repositories.

## What it doesn't do

- **Set up the server,** as above.
- **Run products that need more than Node,** such as a browser or a system library.
  Those are better in a container of their own.
- **DNS, email, or payments.** Those stay with your providers.
- **Run across several servers.** A product that outgrows a shared server moves to a
  server of its own, set up the same way.
- **Keep anything about your servers.** Your domains, keys, and products live only on
  your server. The repository holds no address, key, or token, and CI checks it.

## Documents

- [SECURITY.md](SECURITY.md): how to report a vulnerability, and what's in scope.
- [docs/threat-model.md](docs/threat-model.md): what it protects, against whom, and how.
- [ROADMAP.md](ROADMAP.md): what's being built, in order.
- [CONTRIBUTING.md](CONTRIBUTING.md): how to help, and the rules every change follows.
- [CHANGELOG.md](CHANGELOG.md): what changed, version by version.

## License

[MIT](LICENSE), © Modest Industries Ltd.
