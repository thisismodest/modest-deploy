// Where everything lives on the server. Every path is built here, from names already
// checked (see names.ts), so nothing outside can choose a path. `root` is "" on a
// server; tests give a temporary folder.

import { join } from "node:path";

export type Layout = ReturnType<typeof layout>;

export function layout(root = "") {
  const at = (...parts: string[]) => join(root || "/", ...parts);
  return {
    root,
    /** The server's own settings: the deploy domain. */
    host: at("etc/modest-deploy/host.json"),
    /** One settings file per product: its domain, repository, and port. */
    products: at("etc/modest-deploy/products"),
    product: (name: string) => at("etc/modest-deploy/products", `${name}.json`),
    /** Each product's webhook secret, readable by the listener only. */
    secrets: at("etc/modest-deploy/secrets"),
    secret: (name: string) => at("etc/modest-deploy/secrets", name),
    /** Each product's read-only deploy key for GitHub, readable by the build user only. */
    keys: at("etc/modest-deploy/keys"),
    key: (name: string) => at("etc/modest-deploy/keys", name),
    knownHosts: at("etc/modest-deploy/keys/known_hosts"),
    /** Each product's own keys (its environment), read by systemd as it starts the product. */
    envs: at("etc/modest-deploy/env"),
    env: (name: string) => at("etc/modest-deploy/env", `${name}.env`),
    /** Caddy sites: the deploy domain's, and one per product. */
    caddy: at("etc/modest-deploy/caddy"),
    caddySite: (name: string) => at("etc/modest-deploy/caddy", `${name}.caddy`),
    caddyfile: at("etc/caddy/Caddyfile"),
    /** systemd units. */
    units: at("etc/systemd/system"),
    unit: (file: string) => at("etc/systemd/system", file),
    /** Each product's code: a copy of its repository, its releases, and the one running. */
    code: (name: string) => at("srv/modest-deploy", name),
    source: (name: string) => at("srv/modest-deploy", name, "source.git"),
    releases: (name: string) => at("srv/modest-deploy", name, "releases"),
    release: (name: string, commit: string) => at("srv/modest-deploy", name, "releases", commit),
    current: (name: string) => at("srv/modest-deploy", name, "current"),
    /** Each product's data (systemd's StateDirectory), and its nightly copies. */
    data: (name: string) => at("var/lib/modest-deploy", name),
    backups: (name: string) => at("var/backups/modest-deploy", name),
    /** Where each product's user makes its copies, before root moves them into backups. */
    copying: at("var/lib/modest-deploy-copying"),
    copyingFor: (name: string) => at("var/lib/modest-deploy-copying", name),
    /** Deploy requests: written by the listener, taken by the deploy service. */
    writing: at("var/spool/modest-deploy/writing"),
    requests: at("var/spool/modest-deploy/requests"),
    /** Each product's build user's home, for git's and npm's own files. */
    buildHomes: at("var/lib/modest-deploy-build"),
    buildHome: (name: string) => at("var/lib/modest-deploy-build", name),
  };
}

/**
 * The system users: one for the listener, and two per product, one it runs as and one
 * its releases are built as, so a build can only ever reach its own product's key and source.
 */
export const LISTENER_USER = "modest-deploy";
export const productUser = (name: string) => `md-${name}`;
export const buildUser = (name: string) => `mb-${name}`;
export const productUnit = (name: string) => `modest-deploy-${name}.service`;
/** Where the listener listens, behind Caddy. */
export const LISTENER_PORT = 9327;
