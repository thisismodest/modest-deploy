# modest-deploy

Zero-dependency deployment for Node, on your own server: launch each app with a
command, and deploy it on every push that passes CI.

> **An early release.** It's tested end to end on Ubuntu with systemd, and has had
> internal adversarial review, but not an independent one, and it hasn't yet run on a
> real server for long. Try it on a server you can rebuild.

## Why

Launching an app shouldn't mean setting up hosting again. modest-deploy does the
same few things for every app, the same way each time, so each new one is a
command, and every push after that deploys itself.

- **No dependencies.** It's written in TypeScript for Node, which the server needs
  anyway for the apps. Everything else it uses is already on the server: Caddy,
  git, and systemd.
- **GitHub can't log in to the server.** It sends a signed message when CI passes,
  and that's all. No key to the server is ever stored in GitHub.
- **Each app is fenced off** from the others and from the server.
- **It checks rather than assumes.** Before it does anything, it checks the server
  is set up safely, and says what to fix if not.

## What it does

**Install, once per server.** On a server you've set up (see "Before you install"),
`modest-deploy install` adds its own parts: the deploy listener, the folder Caddy
reads apps' sites from, and the nightly backup.

**Check, any time.** `modest-deploy check` checks what it relies on, and says plainly
what to fix: Node 24 or later, Caddy, and systemd present; Node and modest-deploy
readable by the services' own users; SSH by key only, with no root login (as SSH
treats a connection from outside); automatic security updates on; nothing
listening to the outside but SSH, HTTP, and HTTPS; and apps' memory fitting in
what the server has for them. `install` and `add` won't run while a check fails,
unless you add `--anyway`.

**Launch an app, with one command from your computer.**
`modest-deploy launch <name> <domain>`:

- makes the app's GitHub repository, from your template if you name one (or,
  if it's there already, uses it, adding only the deploy key and webhook below);
- on the server, gives it a system user, a folder, an environment file for its keys,
  a systemd service, and its domain in Caddy (which gets and renews its HTTPS
  certificate);
- adds a signed webhook to the repository, so a push to `main` that passes CI
  deploys it;
- tells you what's left: pointing the domain's DNS at the server (an `A` record, and
  `AAAA` if it has IPv6).

Add `--redirect www.example.org` (or several, separated by commas) for domains that
should send visitors to the app's own, at the same path: such as `www.`, or an
old name. They never reach the app, and no domain can be used by two apps.
Run `add` again on the server to change them.

**Memory, set aside for each app.** An app is given 512M (or all that's left, if
less; `add` and `launch` say how much), or what you say with `--memory` (such as `1G`, or `max` for all that's left). It's set aside for it alone
and is its ceiling, and an app is added only if it fits beside the others: the
server keeps a quarter of its memory for itself (never under 384M), for the system,
SSH, Caddy, the listener, and deploys. So however busy apps get, together they
can't run the server out of memory, and one can't take another's. `modest-deploy
resize <name> --memory <size>` gives one more or less, if it fits. Each app's
Node thread pool is sized to the cores, for sign-ins (modest-auth hashes up to one
password a core).

On a 1GB server, that's 576M for apps: one at 512M, or two at 256M. Run several
apps on a bigger server, or give anything with personal data or real traffic a
server of its own. `modest-deploy list --server a,b` lists every server's apps
from your computer.

**Deploy, on every push to `main` that passes CI.** GitHub sends a signed
"workflow finished" message. The server:

1. ignores anything unsigned, or not a successful run of CI on `main`, and any
   delivery it has already acted on;
2. fetches the repository, and deploys only if the commit is still the tip of
   `main` (so an old message, sent again, can't roll it back);
3. refuses a release over 1GB or 200,000 files, or one the disk hasn't room for
   (it always keeps 1GB free);
4. installs its dependencies exactly as its lockfile says, with install scripts off;
5. starts the new version, checks it answers, and only on 127.0.0.1, and goes back
   to the previous one if not.

`modest-deploy deploy <name>` deploys `main`'s newest commit by hand, whether or not its
CI passed: that's your choice to make.

**Look after the apps.** Each app's databases (its files ending `.db`,
`.sqlite`, or `.sqlite3`) are copied every night with SQLite's own backup, checked
whole, and kept for 7 nights. An app that stops is restarted, more slowly each
time if it keeps stopping. Logs are kept by systemd's journal.

## What an app does

An app is a Node server in a GitHub repository that:

- starts with `node server.js`, and listens on `process.env.PORT`, at
  `process.env.HOST` (127.0.0.1): one listening anywhere else isn't deployed, so
  nothing reaches it but through Caddy;
- keeps everything it writes in `process.env.DATA_DIR` (anything else is read-only);
- answers `GET /` once it's ready;
- has a CI workflow, `.github/workflows/ci.yml`, that runs on pushes to `main`.

## Before you install

modest-deploy doesn't set up the server itself: your hosting provider and a few
minutes by hand do it better, and `modest-deploy check` checks the result. On a new
Ubuntu 26.04 LTS server:

- sign in with an SSH key (add it when creating the server), with password sign-in
  and root sign-in turned off;
- a firewall that lets in only SSH (from your own address, if you can), HTTP, and
  HTTPS;
- automatic security updates on (`unattended-upgrades`);
- Node 24 or later, and Caddy, from their own package repositories.

24.04 LTS also works, but it can't stop a compromised app from opening other
ports (see the threat model's known limits).

## Installing

[Step by step](https://modest-deploy.com/start.html) goes from a new
Ubuntu server to an app live on your domain. In short, on the server, from npm:

```sh
sudo npm install -g modest-deploy
sudo modest-deploy check
sudo modest-deploy install --domain deploy.example.org
```

Or from this repository, which Node runs as it is, with nothing to build:

```sh
sudo git clone https://github.com/thisismodest/modest-deploy.git /opt/modest-deploy
sudo ln -s /opt/modest-deploy/src/cli.ts /usr/local/bin/modest-deploy
```

Then point the deploy domain's DNS at the server (an `A` record, and `AAAA` if it has
IPv6): GitHub's messages arrive there. `modest-deploy --help`
says how to get started, and `modest-deploy help <command>` gives each command's page. For
`launch`, install it on your computer too, the same way.

## Updating modest-deploy

```sh
sudo npm install -g modest-deploy@latest     # or: sudo git -C /opt/modest-deploy pull
sudo modest-deploy install
```

Running `install` again rewrites every unit it made, the apps' included, so they
use the new version.

## Restoring a backup

Stop the app, put the copy back as the app's own (removing SQLite's
`-wal` and `-shm` files, which belong to the database being replaced), and start it:

```sh
sudo systemctl stop modest-deploy-blog
sudo install -o md-blog -g md-blog -m 600 /var/backups/modest-deploy/blog/2026-10-25/app.db /var/lib/modest-deploy/blog/app.db
sudo rm -f /var/lib/modest-deploy/blog/app.db-wal /var/lib/modest-deploy/blog/app.db-shm
sudo systemctl start modest-deploy-blog
```

Copy `/var/backups/modest-deploy` off the server too, or turn on your provider's
backups: copies on the same disk don't survive losing it.

## What it doesn't do

- **Set up the server,** as above.
- **Run apps that need more than Node,** such as a browser or a system library.
  Those are better in a container of their own.
- **DNS, email, or payments.** Those stay with your providers.
- **Run across several servers.** An app that outgrows a shared server moves to a
  server of its own, set up the same way.
- **Keep anything about your servers.** Your domains, keys, and apps live only on
  your server. The repository holds no address, key, or token, and CI checks it.

## Documents

- [SECURITY.md](SECURITY.md): how to report a vulnerability, and what's in scope.
- [docs/threat-model.md](docs/threat-model.md): what it protects, against whom, and how.
- [ROADMAP.md](ROADMAP.md): what's being built, in order.
- [CONTRIBUTING.md](CONTRIBUTING.md): how to help, and the rules every change follows.
- [CHANGELOG.md](CHANGELOG.md): what changed, version by version.

## License

[MIT](LICENSE), © Modest Industries Ltd.
