// The commands run on the server, as root: install modest-host's own parts, add and
// remove products, and copy their databases. Everything is checked first, and
// written whole; nothing a product keeps is deleted as a side effect.

import { randomBytes } from "node:crypto";
import { chmod, chown, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { checkServer, report } from "./check.ts";
import { running } from "./deploy.ts";
import { isDomain, isName, isRepo } from "./names.ts";
import { BUILD_USER, type Layout, LISTENER_USER, productUnit, productUser } from "./paths.ts";
import { freePort, listProducts, type Product, readHost, readProduct, saveProduct, writeWhole } from "./products.ts";
import { must, type Run } from "./run.ts";
import { BACKUP_TIMER, backupService, caddyImport, deployPath, deployService, hostSite, listenerService, productService, productSite } from "./units.ts";

export type Server = { run: Run; paths: Layout; node: string; cli: string; log: (line: string) => void };

/** Checks the server, and refuses to go on if anything needs fixing (unless told to go on anyway). */
async function checked(server: Server, anyway: boolean): Promise<void> {
  const ok = report(await checkServer(server.run));
  if (!ok && !anyway) throw new Error("fix what's above first (or add --anyway, if you're sure)");
}

async function uid(server: Server, user: string): Promise<number> {
  return Number((await must(server.run, "id", ["-u", user])).trim());
}

/** A system user with no shell, no password, and no way to sign in; made once. */
async function systemUser(server: Server, user: string, home = "/nonexistent"): Promise<void> {
  if ((await server.run("id", ["-u", user])).code === 0) return;
  await must(server.run, "useradd", ["--system", "--user-group", "--no-create-home", "--home-dir", home, "--shell", "/usr/sbin/nologin", user]);
}

/** A folder with exactly this owner and mode, whatever was there. */
async function folder(server: Server, path: string, mode: number, owner?: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await chmod(path, mode);
  if (owner) await chown(path, await uid(server, owner), Number((await must(server.run, "id", ["-g", owner])).trim()));
}

/** Checks Caddy can read its settings with this change, and reloads it; if it can't, the change is undone. */
async function caddyWith(server: Server, file: string, text: string | null): Promise<void> {
  const before = await readFile(file, "utf8").catch(() => null);
  if (text === null) await rm(file, { force: true });
  else await writeWhole(file, text);
  const valid = await server.run("caddy", ["validate", "--config", server.paths.caddyfile, "--adapter", "caddyfile"]);
  if (valid.code !== 0) {
    if (before === null) await rm(file, { force: true });
    else await writeWhole(file, before);
    throw new Error(`Caddy can't use it, so nothing changed: ${valid.stderr.trim().split("\n").slice(-2).join(" ")}`);
  }
  await must(server.run, "systemctl", ["reload", "caddy"]);
}

/** GitHub's SSH host keys, as GitHub publishes them over HTTPS: fetched, never trusted on first use. */
async function githubHostKeys(): Promise<string> {
  const res = await fetch("https://api.github.com/meta", { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GitHub's host keys couldn't be fetched (${res.status})`);
  const keys = ((await res.json()) as { ssh_keys?: unknown }).ssh_keys;
  if (
    !Array.isArray(keys) ||
    !keys.length ||
    !keys.every((k) => typeof k === "string" && /^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/=]+$/.test(k))
  ) {
    throw new Error("GitHub's host keys weren't in the expected form");
  }
  return keys
    .map((k) => `github.com ${k}`)
    .join("\n")
    .concat("\n");
}

export async function install(server: Server, domain: string, anyway = false): Promise<void> {
  if (!isDomain(domain)) throw new Error("the deploy domain must be a domain, such as deploy.example.org");
  await checked(server, anyway);
  const { paths, run, node, cli } = server;
  await systemUser(server, LISTENER_USER);
  await systemUser(server, BUILD_USER, paths.buildHome);

  await folder(server, "/etc/modest-host", 0o755);
  await folder(server, paths.products, 0o755);
  await folder(server, paths.secrets, 0o750, LISTENER_USER);
  await chown(paths.secrets, 0, Number((await must(run, "id", ["-g", LISTENER_USER])).trim()));
  await folder(server, paths.keys, 0o700, BUILD_USER);
  await folder(server, paths.envs, 0o700);
  await folder(server, paths.caddy, 0o755);
  await folder(server, "/srv/modest-host", 0o755);
  await folder(server, "/var/lib/modest-host", 0o755);
  await folder(server, "/var/backups/modest-host", 0o700);
  await folder(server, paths.buildHome, 0o700, BUILD_USER);
  await folder(server, "/var/spool/modest-host", 0o700, LISTENER_USER);
  await folder(server, paths.writing, 0o700, LISTENER_USER);
  await folder(server, paths.requests, 0o700, LISTENER_USER);

  await writeWhole(paths.knownHosts, await githubHostKeys());
  await chown(paths.knownHosts, await uid(server, BUILD_USER), 0);
  await writeWhole(paths.host, `${JSON.stringify({ domain }, null, 2)}\n`);

  await writeWhole(paths.unit("modest-host-listener.service"), listenerService(paths, node, cli));
  await writeWhole(paths.unit("modest-host-deploy.service"), deployService(node, cli));
  await writeWhole(paths.unit("modest-host-deploy.path"), deployPath(paths));
  await writeWhole(paths.unit("modest-host-backup.service"), backupService(node, cli));
  await writeWhole(paths.unit("modest-host-backup.timer"), BACKUP_TIMER);
  await must(run, "systemctl", ["daemon-reload"]);
  await must(run, "systemctl", ["enable", "--now", "modest-host-listener.service", "modest-host-deploy.path", "modest-host-backup.timer"]);
  await must(run, "systemctl", ["restart", "modest-host-listener.service"]);

  const caddyfile = await readFile(paths.caddyfile, "utf8").catch(() => "");
  if (!caddyfile.split("\n").some((line) => line.trim() === caddyImport(paths))) {
    await writeWhole(paths.caddyfile, `${caddyfile.replace(/\n*$/, "\n")}\n# Added by modest-host: its products' sites.\n${caddyImport(paths)}\n`);
  }
  await caddyWith(server, paths.caddySite("_host"), hostSite(domain));
  server.log(`Installed. Point ${domain}'s DNS at this server: GitHub's messages arrive there.`);
}

export type Added = { name: string; domain: string; repo: string; webhook: string; secret: string; deployKey: string };

export async function add(server: Server, name: string, domain: string, repo: string, anyway = false): Promise<Added> {
  if (!isName(name)) throw new Error("the name must be 2 to 29 lowercase letters, digits, and single hyphens, starting with a letter");
  if (!isDomain(domain)) throw new Error("the domain must be a domain, such as shop.example.org");
  if (!isRepo(repo)) throw new Error("the repository must be owner/name, as on GitHub");
  await checked(server, anyway);
  const { paths, run, node } = server;
  const host = await readHost(paths);
  if (await readProduct(paths, name)) throw new Error(`there's already a product called ${name}`);
  const products = await listProducts(paths);
  if (domain === host.domain || products.some((p) => p.domain === domain)) throw new Error(`${domain} is already in use here`);

  const user = productUser(name);
  await systemUser(server, user);
  const product: Product = { name, domain, repo, port: freePort(products), branch: "main", workflow: ".github/workflows/ci.yml" };

  const secret = randomBytes(32).toString("hex");
  await writeWhole(paths.secret(name), secret, 0o640);
  await chown(paths.secret(name), 0, Number((await must(run, "id", ["-g", LISTENER_USER])).trim()));
  await rm(paths.key(name), { force: true });
  await rm(`${paths.key(name)}.pub`, { force: true });
  await must(run, "ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `modest-host ${name}`, "-f", paths.key(name)], { as: BUILD_USER });
  const deployKey = (await readFile(`${paths.key(name)}.pub`, "utf8")).trim();
  if ((await readFile(paths.env(name), "utf8").catch(() => null)) === null) {
    await writeWhole(paths.env(name), `# ${name}'s own keys, one KEY=value a line. After a change: modest-host restart ${name}\n`, 0o600);
  }

  await folder(server, paths.code(name), 0o755);
  await folder(server, paths.releases(name), 0o755);
  await folder(server, paths.source(name), 0o700, BUILD_USER);
  await must(run, "git", ["init", "--quiet", "--bare", paths.source(name)], { as: BUILD_USER });

  await saveProduct(paths, product);
  await writeWhole(paths.unit(productUnit(name)), productService(paths, product, node));
  await must(run, "systemctl", ["daemon-reload"]);
  await must(run, "systemctl", ["enable", productUnit(name)]);
  await caddyWith(server, paths.caddySite(name), productSite(product));
  return { name, domain, repo, webhook: `https://${host.domain}/deploy/${name}`, secret, deployKey };
}

/** Takes a product off the server. Its data, keys, and copies stay, until deleted by hand. */
export async function remove(server: Server, name: string): Promise<string[]> {
  const { paths, run } = server;
  const product = await readProduct(paths, name);
  if (!product) throw new Error(`there's no product called ${name}`);
  await run("systemctl", ["disable", "--now", productUnit(name)]);
  await rm(paths.unit(productUnit(name)), { force: true });
  await must(run, "systemctl", ["daemon-reload"]);
  await caddyWith(server, paths.caddySite(name), null);
  for (const path of [paths.product(name), paths.secret(name), paths.key(name), `${paths.key(name)}.pub`]) await rm(path, { force: true });
  await rm(paths.code(name), { recursive: true, force: true });
  return [paths.data(name), paths.backups(name), paths.env(name)];
}

export async function list(server: Server): Promise<string[]> {
  const rows: string[] = [];
  for (const p of await listProducts(server.paths)) {
    const state = (await server.run("systemctl", ["is-active", productUnit(p.name)])).stdout.trim() || "unknown";
    const commit = (await running(server.paths, p.name))?.slice(0, 7) ?? "none yet";
    rows.push(`${p.name}  https://${p.domain}  ${p.repo}  port ${p.port}  ${state}  ${commit}`);
  }
  return rows;
}

/** Databases are files ending .db, .sqlite, or .sqlite3, anywhere in a product's data. */
async function databases(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile() && /\.(db|sqlite3?)$/.test(e.name)).map((e) => join(e.parentPath, e.name));
}

/** How many nights of copies are kept. */
const NIGHTS = 7;

/**
 * Copies every product's databases, with SQLite's own backup, safe while they're in
 * use. Each copy is made as the product's own user (so its files stay its own), into
 * a folder only it can write, then moved where only root can read.
 */
export async function backup(server: Server, today = new Date().toISOString().slice(0, 10)): Promise<number> {
  const { paths, run, node, cli } = server;
  let copied = 0;
  for (const product of await listProducts(paths)) {
    const user = productUser(product.name);
    const work = join("/var/backups/modest-host", ".work", product.name);
    await rm(work, { recursive: true, force: true });
    await folder(server, work, 0o700, user);
    const night = join(paths.backups(product.name), today);
    for (const db of await databases(paths.data(product.name))) {
      const copy = join(work, "copy.db");
      const made = await run(node, [cli, "copy-database", db, copy], { as: user });
      if (made.code !== 0) {
        console.error(`modest-host: ${product.name}: ${relative(paths.data(product.name), db)} couldn't be copied: ${made.stderr.trim().split("\n").at(-1)}`);
        continue;
      }
      const to = join(night, relative(paths.data(product.name), db));
      await mkdir(join(to, ".."), { recursive: true, mode: 0o700 });
      await rename(copy, to);
      await chown(to, 0, 0);
      await chmod(to, 0o600);
      copied++;
    }
    await rm(work, { recursive: true, force: true });
    const nights = (await readdir(paths.backups(product.name)).catch(() => [] as string[])).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
    for (const old of nights.slice(0, Math.max(0, nights.length - NIGHTS))) await rm(join(paths.backups(product.name), old), { recursive: true, force: true });
  }
  return copied;
}

/** Run as the product's user, by backup: one database copied with SQLite's online backup. */
export async function copyDatabase(from: string, to: string): Promise<void> {
  const { DatabaseSync, backup: copy } = await import("node:sqlite");
  if (!(await stat(from)).isFile()) throw new Error("not a file");
  const db = new DatabaseSync(from);
  try {
    await copy(db, to);
  } finally {
    db.close();
  }
}
