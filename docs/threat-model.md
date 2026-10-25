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
| A forged deploy message | Each product has its own secret, and every message must carry a valid HMAC-SHA256 signature of its exact body, compared in constant time; anything else is refused before the body is read as JSON | Planned |
| A deploy message for something other than a passed CI run on `main` | Only `workflow_run` messages, completed successfully, for a push to `main`, from the product's own repository and its CI workflow, are acted on | Planned |
| An old message sent again, to roll a product back | The commit must still be the tip of `main` when it's fetched | Planned |
| A huge or slow request to the listener | Bodies over 1MB are refused, and slow requests are cut off | Planned |
| A message that names something to run | The listener runs nothing it's sent: it checks the message, then asks for a deploy of a product it already knows, by name, with a commit checked to be 40 hex characters | Planned |
| The listener being broken into | It runs as its own user, with no rights but to write deploy requests into one folder; the deploy itself is run by systemd | Planned |
| GitHub, the repository, or a workflow being broken into | GitHub holds no key to the server, only the webhook secret, which no workflow can read; at worst, it could deploy a commit already on `main` | By design |
| A product reaching another, or the server | Each runs as its own user, sandboxed by systemd: read-only system, private `/tmp`, no new privileges, a memory limit, and write access to its own data folder only | Planned |
| A package's install script running code on the server | Dependencies are installed with install scripts off, exactly as the lockfile says | Planned |
| A bad deploy taking a product down | It's checked once started, and the previous version comes back if it doesn't answer | Planned |
| A key or address committed to this public repository | CI fails on IP addresses outside the ranges kept for examples, private keys, and tokens | Built (`scripts/check-rules.ts`) |
| An unsafe server | `check` looks for SSH by key only, no root login, automatic updates, and nothing listening but SSH, HTTP, and HTTPS, and `install` and `add` refuse until it's fixed | Planned |

## Known limits

- **The server is only as safe as its setup.** modest-host checks the main points,
  but doesn't set up the server, and can't see everything (a provider's firewall,
  for one).
- **Products trust their dependencies.** Install scripts are off, but a compromised
  package still runs when the product does, inside that product's sandbox.
- **Anyone with a product's webhook secret** can ask for that product to be deployed
  again, at its current commit on `main`. Nothing more.
