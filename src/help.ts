// What modest-deploy says about itself: a short start for `modest-deploy`, -h, or --help,
// and a page for each command (`modest-deploy help <command>`, or `<command> --help`).
// Asking for help never runs anything: a command given --help or -h only prints this.

const DOCS = "https://modest-deploy.com";

export const OVERVIEW = `modest-deploy: deploy small Node apps to your own server.

Getting started, once per server:
  sudo modest-deploy check                       is the server set up safely? (says what to fix)
  sudo modest-deploy install --domain <domain>   install modest-deploy's own parts
  modest-deploy launch <name> <domain> --server <ssh-host>
                                                 from your computer: an app, live on its domain

Every day:
  modest-deploy list                             the apps, their memory, and what each is running
  modest-deploy list --server <a,b>              from your computer: every server's, in turn
  sudo modest-deploy logs <name>                 an app's latest log lines
  sudo modest-deploy deploy <name>               deploy main's newest commit now
  sudo modest-deploy restart <name>              restart an app (after changing its keys)
  sudo modest-deploy resize <name> --memory <size>
                                                 give an app more memory, or less

Every command: check, install, launch, add, list, deploy, restart, resize, logs, remove, backup.
For one of them: modest-deploy help <command>, or modest-deploy <command> --help.

Step by step, from a new server to an app live on your domain: ${DOCS}/start.html`;

/** Each command's page: what it does, what it changes, its options, and an example. */
const PAGES: Record<string, string> = {
  check: `modest-deploy check

Checks what modest-deploy relies on, and says plainly what to fix: Node 24 or later, Caddy,
and systemd; SSH by key only, with no root login; automatic security updates; nothing
listening to the outside but SSH, HTTP, and HTTPS; and apps' memory fitting in what the
server has for them. Changes nothing.

install and add won't run while a check fails, unless you add --anyway.

Example:
  sudo modest-deploy check

More: ${DOCS}/docs.html#before`,

  install: `modest-deploy install --domain <deploy-domain> [--anyway]

Installs modest-deploy's own parts on the server: the deploy listener (which GitHub's
signed messages reach, at <deploy-domain>), the deploy service, the folder Caddy reads
apps' sites from, and the nightly backup. Run it again after updating modest-deploy,
or after giving the server more memory or cores: it rewrites every unit it made, the
apps' included (each sized to the server), and restarts only apps whose unit
changed. The domain can be left out then.

Options:
  --domain <domain>   where GitHub's messages arrive, such as deploy.example.org
  --anyway            go on even if check finds something to fix

Example:
  sudo modest-deploy install --domain deploy.example.org

More: ${DOCS}/docs.html#install`,

  launch: `modest-deploy launch <name> <domain> --server <ssh-host> [options]

From your computer: makes the app's GitHub repository (from a template, if you name
one), adds the app on the server over SSH, and gives GitHub the server's read-only
deploy key and a signed webhook. Then a push to main that passes CI deploys it. Uses gh
and ssh, as you already do. Run again, it updates what's there. Without gh (or signed out
of it), it changes nothing, and says how to get it, or do the same by hand.

It works with GitHub, not the folder you're in: run it from anywhere. If the repository
is already on GitHub (yours called <name>, or the one --repo names), it connects that one
instead of making one: its code isn't touched, only a deploy key and webhook added to its
settings. To deploy what's on its main without a push, run modest-deploy deploy <name> on
the server.

Options:
  --server <ssh-host>        a host from your SSH config, or user@host
  --repo <owner/repo>        the repository, new or already there (the owner can be an
                             organisation; default: your own account's, named <name>)
  --template <owner/repo>    make the repository from this template
  --public                   a public repository (default: private)
  --redirect <domain,...>    domains that send visitors to <domain>, such as www.
  --memory <size>            its memory, such as 1G, or max for all that's left
                             (if not given: 512M, or all that's left if less)
                             (added only if it fits: see modest-deploy help add)

Example:
  modest-deploy launch blog blog.example.org --server myserver --redirect www.blog.example.org
  modest-deploy launch club club.example.org --server clubserver --memory max
  modest-deploy launch blog blog.example.org --server myserver --repo your-org/blog

More: ${DOCS}/docs.html#launch`,

  add: `modest-deploy add <name> --domain <domain> --repo <owner/repo> [options]

On the server: adds an app, as launch does for you from your computer. Gives it a system
user, a folder, an environment file for its keys, a systemd service, and its domain in
Caddy, then prints the deploy key and webhook to add on GitHub by hand. Run again, with the
same domain and repository, to change its redirects: the secret and key stay the same.

Memory: each app's is set aside for it alone, and is also its ceiling: 512M unless you
say, or all that's left if that's less (add says how much it gave). The server keeps a
quarter of its memory for itself (never under 384M), for the system, SSH, Caddy, and
deploys; apps share the rest, and one is added only if it fits. So however busy apps
get, the server can't run out, and one can't take another's. On a 1GB server, that's
room for one app at 512M, or two at 256M; on 4GB, about 2.9G. modest-deploy list shows
what's given out. Each app's Node thread pool is sized to the server's cores, for
sign-ins.

Options:
  --domain <domain>          the app's domain
  --repo <owner/repo>        its GitHub repository
  --redirect <domain,...>    domains that send visitors to <domain>, such as www.
  --memory <size>            its memory, such as 1G, or max for all that's left
                             (if not given: 512M, or all that's left if less)
  --json                     print the result as JSON (launch reads it)
  --anyway                   go on even if check finds something to fix

Example:
  sudo modest-deploy add blog --domain blog.example.org --repo example/blog
  sudo modest-deploy add club --domain club.example.org --repo example/club --memory max

More: ${DOCS}/docs.html#launch
      ${DOCS}/docs.html#memory`,

  list: `modest-deploy list [--server <ssh-host,...>]

The apps on this server: each one's domain (and redirects), repository, port, memory,
whether it's running, and the commit it's running; then how much of the server's memory
is given out. Changes nothing, and needs no sudo.

From your computer, with --server: each server's list in turn, over SSH. One that doesn't
answer is said, and the rest still listed.

Options:
  --server <ssh-host,...>    servers from your SSH config, or user@host, separated by commas

Example:
  modest-deploy list
  modest-deploy list --server blog-server,club-server

More: ${DOCS}/docs.html#memory`,

  resize: `modest-deploy resize <name> --memory <size>

Gives an app more memory, or less. More is given only if it fits beside the other
apps' in what the server has for them; if not, it says how much there's room for, and
nothing changes. A running app starts again with its new size (a moment's pause), and
is checked it answers. modest-deploy list shows each app's memory, and what's left.

Options:
  --memory <size>    such as 768M or 2G (at least 128M), or max for all that's left

Example:
  sudo modest-deploy resize blog --memory 1G
  sudo modest-deploy resize club --memory max

More: ${DOCS}/docs.html#memory`,

  deploy: `modest-deploy deploy <name>

Deploys main's newest commit now, whether or not its CI passed: that's your choice to make.
Like every deploy, it's started, checked, and switched back if it doesn't answer.

Example:
  sudo modest-deploy deploy blog
  journalctl -fu modest-deploy-deploy.service     (to follow it)

More: ${DOCS}/docs.html#deploy`,

  restart: `modest-deploy restart <name>

Restarts an app, as after changing its keys in its environment file
(/etc/modest-deploy/env/<name>.env).

Example:
  sudo modest-deploy restart blog`,

  logs: `modest-deploy logs <name>

An app's latest 100 log lines, from systemd's journal. Changes nothing.

Example:
  sudo modest-deploy logs blog
  journalctl -fu modest-deploy-blog      (to follow them)`,

  remove: `modest-deploy remove <name>

Takes an app off the server: its service, its site in Caddy, its settings, secret, deploy
key, and code. Keeps its data, its environment file, and its backups, until you delete them
yourself, and says where they are. Then delete its webhook and deploy key on GitHub.

Example:
  sudo modest-deploy remove blog`,

  backup: `modest-deploy backup

Copies every app's databases now, as happens every night: each file ending .db,
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
