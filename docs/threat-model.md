# Threat model

What modest-host protects, against whom, and how. In development: each measure is
marked as built (with its test) or planned.

## What it protects

- **The server,** from anyone but its owner.
- **Each product,** its code, data, and keys, from the internet and from the other
  products on the same server.
- **What runs,** so it's only ever a commit on `main` of the product's own repository
  that passed CI.

## Against whom

- **Anyone on the internet,** sending requests to the deploy listener or the products.
- **Someone who gets into GitHub,** the repository, or a workflow, wanting to run
  code on the server.
- **A product that's been broken into,** wanting to reach the other products or the
  server.
- **A compromised package** in a product's dependencies.

## How

| Threat | Measure | Status |
| --- | --- | --- |
| A forged deploy message | Each product has its own secret, and every message must carry a valid HMAC-SHA256 signature of its exact body, compared in constant time; anything else is refused before the body is read as JSON | Built (`webhook.ts`) |
| A deploy message for something other than a passed CI run on `main` | Only `workflow_run` messages, completed successfully, for a push to `main`, from the product's own repository and its CI workflow, are acted on | Built (`webhook.ts`) |
| An old message sent again, to roll a product back | The commit must still be the tip of `main` when it's fetched | Built (`deploy.ts`) |
| A huge or slow request to the listener | Bodies over 1MB are refused, and slow requests are cut off | Built (`listener.ts`) |
| Finding which products a server has | A product that doesn't exist gets the same answer as a wrong signature | Built (`listener.ts`) |
| A captured delivery sent again | Each delivery is acted on once (its id remembered); and only main's newest commit is ever deployed | Built (`listener.ts`, `deploy.ts`) |
| A message that names something to run | The listener runs nothing it's sent: it checks the message, then asks for a deploy of a product it already knows, by name, with a commit checked to be 40 hex characters | Built (`listener.ts`) |
| The listener being broken into | It runs as its own user, sandboxed by systemd, able to write only into the deploy requests folder, and to reach only this machine; the deploy is started by systemd when a request appears, and takes only a known product's name and a checked commit from it | Built (`units.ts`, `queue.ts`), tested end to end |
| GitHub, the repository, or a workflow being broken into | GitHub holds no key to the server, only the webhook secret, which no workflow can read; at worst, it could deploy a commit already on `main` | By design |
| A product reaching another, or the server | Each runs as its own user, sandboxed by systemd: read-only system and code, private `/tmp`, no new privileges or capabilities, other users' processes hidden, the server's secrets and keys out of reach, a memory limit, and write access to its own data folder only. Its code is owned by root and readable only by it | Built (`units.ts`, `deploy.ts`), tested end to end |
| A package's install script running code on the server | Dependencies are installed with install scripts off, exactly as the lockfile says | Built (`deploy.ts`) |
| A bad deploy taking a product down | It's checked once started, and the previous version comes back if it doesn't answer, or if anything fails after the switch | Built (`deploy.ts`), tested end to end |
| A product reachable without Caddy | A version that listens on anything but 127.0.0.1 is switched back | Built (`deploy.ts`) |
| A pushed commit filling the shared disk | A release over 1GB or 200,000 files is refused, sizes are counted before anything is written, and 1GB is always kept free | Built (`deploy.ts`) |
| A release tricking root into reading something else | Root reads a release's `package.json` only if it's a small, plain file (never a link or a device); the deploy service is limited to 1GB of memory, with no devices | Built (`deploy.ts`, `units.ts`) |
| The server's answer to `launch` sending GitHub's webhook or a key elsewhere | Only a webhook at `/deploy/<this product>` over HTTPS on a domain, and one plain ed25519 key, are accepted | Built (`launch.ts`) |
| A key or address committed to this public repository | CI fails on IPv4 and IPv6 addresses outside the ranges kept for examples, private keys, tokens, and anything shaped like a webhook secret | Built (`scripts/check-rules.ts`) |
| An unsafe server | `check` looks for SSH by key only and no root login (as SSH treats a connection from outside, Match blocks included), automatic updates, and nothing listening over TCP or UDP but SSH, HTTP, and HTTPS, and `install` and `add` refuse until it's fixed | Built (`check.ts`) |
| A server pretending to be GitHub | GitHub's SSH host keys are fetched from GitHub's own API over HTTPS at install, and nothing else is accepted: no key is trusted on first use | Built (`server.ts`, `deploy.ts`), tested end to end |
| A product tricking root during backups | Each copy is made by the product's own user, and root then reads it only if it's a plain file of the product's own (never a link), into a new file only root can read | Built (`server.ts`), tested end to end |
| A backup that's quietly wrong | Copies are checked whole by SQLite, kept under another name until complete, never made without room on the disk, never two runs at once, and a failure fails the run | Built (`server.ts`, `cli.ts`) |
| A burst of deploy requests stopping deploys | The deploy service has no start limit, and a newer request for a product replaces one still waiting | Built (`units.ts`, `queue.ts`), tested end to end |

## Known limits

- **The server is only as safe as its setup.** modest-host checks the main points,
  but doesn't set up the server, and can't see everything (a provider's firewall,
  for one).
- **Products trust their dependencies.** Install scripts are off, but a compromised
  package still runs when the product does, inside that product's sandbox.
- **Anyone with a product's webhook secret** can ask for that product to be deployed
  again, at its current commit on `main`. Nothing more.
- **A product that's been broken into could listen on another product's port** while
  that one is restarting, and so answer its visitors. systemd can stop this
  (`SocketBindDeny`, which modest-host sets), but Ubuntu's systemd is built without
  the part it needs, so there it has no effect. Products on Unix sockets, which only
  their own user and Caddy can reach, would close it: see the roadmap.
- **The deploy service runs as root,** because it makes each release owned by root
  and restarts products. It runs git and npm as the build user, with install scripts
  off, and takes nothing from a request but a checked name and commit.
- **One build user holds every product's deploy key.** Nothing a release contains runs
  as it (no install scripts, and git and tar don't run what they unpack), but if
  something ever did, it could read every product's source.
- **A fetch isn't limited in size.** Someone who can push to a product's `main` could
  push a repository large enough to fill the disk as it's fetched, before its size
  can be checked. Deploys stop once less than 1GB is free.
- **`modest-host deploy` by hand** deploys `main`'s newest commit whether or not its CI
  passed. Only GitHub's signed messages require a passing run.
