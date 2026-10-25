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
    host: at("etc/modest-host/host.json"),
    /** One settings file per product: its domain, repository, and port. */
    products: at("etc/modest-host/products"),
    product: (name: string) => at("etc/modest-host/products", `${name}.json`),
    /** Each product's webhook secret, readable by the listener only. */
    secrets: at("etc/modest-host/secrets"),
    secret: (name: string) => at("etc/modest-host/secrets", name),
    /** Each product's read-only deploy key for GitHub, readable by the build user only. */
    keys: at("etc/modest-host/keys"),
    key: (name: string) => at("etc/modest-host/keys", name),
    knownHosts: at("etc/modest-host/keys/known_hosts"),
    /** Each product's own keys (its environment), read by systemd as it starts the product. */
    envs: at("etc/modest-host/env"),
    env: (name: string) => at("etc/modest-host/env", `${name}.env`),
    /** Caddy sites: the deploy domain's, and one per product. */
    caddy: at("etc/modest-host/caddy"),
    caddySite: (name: string) => at("etc/modest-host/caddy", `${name}.caddy`),
    caddyfile: at("etc/caddy/Caddyfile"),
    /** systemd units. */
    units: at("etc/systemd/system"),
    unit: (file: string) => at("etc/systemd/system", file),
    /** Each product's code: a copy of its repository, its releases, and the one running. */
    code: (name: string) => at("srv/modest-host", name),
    source: (name: string) => at("srv/modest-host", name, "source.git"),
    releases: (name: string) => at("srv/modest-host", name, "releases"),
    release: (name: string, commit: string) => at("srv/modest-host", name, "releases", commit),
    current: (name: string) => at("srv/modest-host", name, "current"),
    /** Each product's data (systemd's StateDirectory), and its nightly copies. */
    data: (name: string) => at("var/lib/modest-host", name),
    backups: (name: string) => at("var/backups/modest-host", name),
    /** Deploy requests: written by the listener, taken by the deploy service. */
    writing: at("var/spool/modest-host/writing"),
    requests: at("var/spool/modest-host/requests"),
    /** The build user's home, for git's and npm's own files. */
    buildHome: at("var/lib/modest-host-build"),
  };
}

/** The system users: one for the listener, one for building, and one per product. */
export const LISTENER_USER = "modest-host";
export const BUILD_USER = "modest-host-build";
export const productUser = (name: string) => `mh-${name}`;
export const productUnit = (name: string) => `modest-host-${name}.service`;
/** Where the listener listens, behind Caddy. */
export const LISTENER_PORT = 9327;
