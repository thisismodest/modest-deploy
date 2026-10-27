// What modest-deploy says about itself: a short start for `modest-deploy`, -h, or --help,
// and a page for each command (`modest-deploy help <command>`, or `<command> --help`).
// Asking for help never runs anything: a command given --help or -h only prints this.

const DOCS = "https://modest-deploy.com";

export const OVERVIEW = `modest-deploy: deploy small Node products to your own server.

Getting started, once per server:
  sudo modest-deploy check                       is the server set up safely? (says what to fix)
  sudo modest-deploy install --domain <domain>   install modest-deploy's own parts
  modest-deploy launch <name> <domain> --server <ssh-host>
                                                 from your laptop: a product, live on its domain

Every day:
  sudo modest-deploy list                        the products, and what each is running
  sudo modest-deploy logs <name>                 a product's latest log lines
  sudo modest-deploy deploy <name>               deploy main's newest commit now
  sudo modest-deploy restart <name>              restart a product (after changing its keys)

Every command: check, install, launch, add, list, deploy, restart, logs, remove, backup.
For one of them: modest-deploy help <command>, or modest-deploy <command> --help.

Step by step, from a new server to a product live on your domain: ${DOCS}/start.html`;

/** Each command's page: what it does, what it changes, its options, and an example. */
const PAGES: Record<string, string> = {
  check: `modest-deploy check

Checks what modest-deploy relies on, and says plainly what to fix: Node 24 or later, Caddy,
and systemd; SSH by key only, with no root login; automatic security updates; and nothing
listening to the outside but SSH, HTTP, and HTTPS. Changes nothing.

install and add won't run while a check fails, unless you add --anyway.

Example:
  sudo modest-deploy check

More: ${DOCS}/docs.html#before`,

  install: `modest-deploy install --domain <deploy-domain> [--anyway]

Installs modest-deploy's own parts on the server: the deploy listener (which GitHub's
signed messages reach, at <deploy-domain>), the deploy service, the folder Caddy reads
products' sites from, and the nightly backup. Run it again after updating modest-deploy:
it rewrites every unit it made, the products' included. The domain can be left out then.

Options:
  --domain <domain>   where GitHub's messages arrive, such as deploy.example.org
  --anyway            go on even if check finds something to fix

Example:
  sudo modest-deploy install --domain deploy.example.org

More: ${DOCS}/docs.html#install`,

  launch: `modest-deploy launch <name> <domain> --server <ssh-host> [options]

From your laptop: makes the product's GitHub repository (from a template, if you name
one), adds the product on the server over SSH, and gives GitHub the server's read-only
deploy key and a signed webhook. Then a push to main that passes CI deploys it. Uses gh
and ssh, as you already do. Run again, it updates what's there.

Options:
  --server <ssh-host>        a host from your SSH config, or user@host
  --repo <owner/repo>        the repository (default: yours, named <name>)
  --template <owner/repo>    make the repository from this template
  --public                   a public repository (default: private)
  --redirect <domain,...>    domains that send visitors to <domain>, such as www.

Example:
  modest-deploy launch shop shop.example.org --server myserver --redirect www.shop.example.org

More: ${DOCS}/docs.html#launch`,

  add: `modest-deploy add <name> --domain <domain> --repo <owner/repo> [options]

On the server: adds a product, as launch does for you from your laptop. Gives it a system
user, a folder, an environment file for its keys, a systemd service, and its domain in
Caddy, then prints the deploy key and webhook to add on GitHub by hand. Run again, with the
same domain and repository, to change its redirects: the secret and key stay the same.

Options:
  --domain <domain>          the product's domain
  --repo <owner/repo>        its GitHub repository
  --redirect <domain,...>    domains that send visitors to <domain>, such as www.
  --json                     print the result as JSON (launch reads it)
  --anyway                   go on even if check finds something to fix

Example:
  sudo modest-deploy add shop --domain shop.example.org --repo example/shop

More: ${DOCS}/docs.html#launch`,

  list: `modest-deploy list

The products on this server: each one's domain (and redirects), repository, port, whether
it's running, and the commit it's running. Changes nothing.

Example:
  sudo modest-deploy list`,

  deploy: `modest-deploy deploy <name>

Deploys main's newest commit now, whether or not its CI passed: that's your choice to make.
Like every deploy, it's started, checked, and switched back if it doesn't answer.

Example:
  sudo modest-deploy deploy shop
  journalctl -fu modest-deploy-deploy.service     (to follow it)

More: ${DOCS}/docs.html#deploy`,

  restart: `modest-deploy restart <name>

Restarts a product, as after changing its keys in its environment file
(/etc/modest-deploy/env/<name>.env).

Example:
  sudo modest-deploy restart shop`,

  logs: `modest-deploy logs <name>

A product's latest 100 log lines, from systemd's journal. Changes nothing.

Example:
  sudo modest-deploy logs shop
  journalctl -fu modest-deploy-shop      (to follow them)`,

  remove: `modest-deploy remove <name>

Takes a product off the server: its service, its site in Caddy, its settings, secret, deploy
key, and code. Keeps its data, its environment file, and its backups, until you delete them
yourself, and says where they are. Then delete its webhook and deploy key on GitHub.

Example:
  sudo modest-deploy remove shop`,

  backup: `modest-deploy backup

Copies every product's databases now, as happens every night: each file ending .db,
.sqlite, or .sqlite3 in its data, with SQLite's own backup, checked whole, and kept for
7 nights in /var/backups/modest-deploy.

Example:
  sudo modest-deploy backup

More: ${DOCS}/docs.html#restore`,
};

// Run by systemd, not by hand.
for (const name of ["listen", "work", "backup-now", "copy-database"]) {
  PAGES[name] = `modest-deploy ${name}

Run by systemd, as part of what install sets up: not a command to run by hand.

${OVERVIEW}`;
}

/** Whether the words after the command ask for help, wherever they are. */
export const wantsHelp = (args: string[]): boolean => args.includes("--help") || args.includes("-h");

/** A command's page, or null if there's no such command. */
export const helpFor = (command: string): string | null => (Object.hasOwn(PAGES, command) ? (PAGES[command] ?? null) : null);
