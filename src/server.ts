// The commands run on the server, as root: install modest-deploy's own parts, add and
// remove products, and copy their databases. Everything is checked first, and
// written whole; nothing a product keeps is deleted as a side effect.

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, mkdir, open, readdir, readFile, rename, rm, stat, statfs } from "node:fs/promises";
import { join, relative } from "node:path";
import { checkServer, report } from "./check.ts";
import { answersWithin, running } from "./deploy.ts";
import { isDomain, isName, isRepo } from "./names.ts";
import { buildUser, type Layout, LISTENER_USER, productUnit, productUser } from "./paths.ts";
import { areRedirects, freePort, listProducts, MOST_REDIRECTS, type Product, readHost, readProduct, saveProduct, takenDomain, writeWhole } from "./products.ts";
import { must, type Run } from "./run.ts";
import { BACKUP_TIMER, backupService, caddyImport, deployPath, deployService, hostSite, listenerService, productService, productSite } from "./units.ts";

export type Server = { run: Run; paths: Layout; node: string; cli: string; log: (line: string) => void };

/** Checks the server, and refuses to go on if anything needs fixing (unless told to go on anyway). */
async function checked(server: Server, anyway: boolean): Promise<void> {
  const ok = report(await checkServer(server.run, undefined, server.cli));
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
  const undo = async () => {
    if (before === null) await rm(file, { force: true });
    else await writeWhole(file, before);
  };
  const valid = await server.run("caddy", ["validate", "--config", server.paths.caddyfile, "--adapter", "caddyfile"]);
  if (valid.code !== 0) {
    await undo();
    throw new Error(`Caddy can't use it, so nothing changed: ${valid.stderr.trim().split("\n").slice(-2).join(" ")}`);
  }
  const reloaded = await server.run("systemctl", ["reload", "caddy"]);
  if (reloaded.code !== 0) {
    await undo();
    await server.run("systemctl", ["reload", "caddy"]);
    throw new Error(`Caddy couldn't reload with it, so nothing changed: ${reloaded.stderr.trim()}`);
  }
}

/** GitHub's SSH host keys, as GitHub publishes them over HTTPS: fetched, never trusted on first use. */
async function githubHostKeys(): Promise<string> {
  const advice = "check this server can reach api.github.com, then run install again";
  const res = await fetch("https://api.github.com/meta", { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(20_000) }).catch(
    () => {
      throw new Error(`GitHub's host keys couldn't be fetched: ${advice}`);
    },
  );
  if (!res.ok)
    throw new Error(
      `GitHub's host keys couldn't be fetched (GitHub answered ${res.status}): ${advice}${res.status === 403 ? ", in an hour (GitHub limits how often it's asked)" : ""}`,
    );
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

/** The ports something is already listening on, on any address. */
async function listening(server: Server): Promise<Set<number>> {
  const ss = await server.run("ss", ["-Hltn"]);
  return new Set(
    ss.stdout
      .split("\n")
      .map((line) => Number(line.trim().split(/\s+/)[3]?.split(":").at(-1)))
      .filter(Number.isInteger),
  );
}

/**
 * Installs modest-deploy's own parts, or, run again (after updating modest-deploy), brings
 * every unit it wrote up to date, products' included. The deploy domain can be left
 * out then: the one already set is kept.
 */
export async function install(server: Server, given: string | undefined, anyway = false): Promise<void> {
  const { paths, run, node, cli } = server;
  const before = await readHost(paths).catch(() => null);
  const domain = given || before?.domain;
  if (!isDomain(domain)) throw new Error("the deploy domain must be a domain, such as deploy.example.org: add --domain");
  await checked(server, anyway);
  await systemUser(server, LISTENER_USER);

  await folder(server, "/etc/modest-deploy", 0o755);
  await folder(server, paths.products, 0o755);
  await folder(server, paths.secrets, 0o750, LISTENER_USER);
  await chown(paths.secrets, 0, Number((await must(run, "id", ["-g", LISTENER_USER])).trim()));
  // Passed through, never listed: each key inside is its own build user's alone.
  await folder(server, paths.keys, 0o711);
  await folder(server, paths.envs, 0o700);
  await folder(server, paths.caddy, 0o755);
  await folder(server, "/srv/modest-deploy", 0o755);
  await folder(server, "/var/lib/modest-deploy", 0o755);
  await folder(server, "/var/backups/modest-deploy", 0o700);
  await folder(server, paths.buildHomes, 0o711);
  await folder(server, "/var/spool/modest-deploy", 0o700, LISTENER_USER);
  await folder(server, paths.writing, 0o700, LISTENER_USER);
  await folder(server, paths.requests, 0o700, LISTENER_USER);

  await writeWhole(paths.knownHosts, await githubHostKeys());
  await chmod(paths.knownHosts, 0o644);

  // Caddy first: if it can't use the change, its own Caddyfile is put back as it was, and nothing else has changed.
  const caddyfile = await readFile(paths.caddyfile, "utf8").catch(() => "");
  if (!caddyfile.split("\n").some((line) => line.trim() === caddyImport(paths))) {
    await writeWhole(paths.caddyfile, `${caddyfile.replace(/\n*$/, "\n")}\n# Added by modest-deploy: its products' sites.\n${caddyImport(paths)}\n`);
  }
  try {
    await caddyWith(server, paths.caddySite("_host"), hostSite(domain));
  } catch (error) {
    if (caddyfile) await writeWhole(paths.caddyfile, caddyfile);
    else await rm(paths.caddyfile, { force: true });
    throw new Error(`${error instanceof Error ? error.message : String(error)} (if your Caddyfile is one site without braces, put braces round it)`);
  }
  await writeWhole(paths.host, `${JSON.stringify({ domain }, null, 2)}\n`);

  await writeWhole(paths.unit("modest-deploy-listener.service"), listenerService(paths, node, cli));
  await writeWhole(paths.unit("modest-deploy-deploy.service"), deployService(node, cli));
  await writeWhole(paths.unit("modest-deploy-deploy.path"), deployPath(paths));
  await writeWhole(paths.unit("modest-deploy-backup.service"), backupService(node, cli));
  await writeWhole(paths.unit("modest-deploy-backup.timer"), BACKUP_TIMER);
  // Products' units are rewritten only if they've changed, and only those products restarted.
  const products = await listProducts(paths);
  const changed: Product[] = [];
  for (const product of products) {
    const text = productService(paths, product, node);
    if ((await readFile(paths.unit(productUnit(product.name)), "utf8").catch(() => "")) === text) continue;
    await writeWhole(paths.unit(productUnit(product.name)), text);
    changed.push(product);
  }
  await must(run, "systemctl", ["daemon-reload"]);
  await must(run, "systemctl", ["enable", "--now", "modest-deploy-listener.service", "modest-deploy-deploy.path", "modest-deploy-backup.timer"]);
  await must(run, "systemctl", ["restart", "modest-deploy-listener.service"]);
  for (const product of changed) {
    if ((await run("systemctl", ["is-active", "--quiet", productUnit(product.name)])).code !== 0) continue;
    await run("systemctl", ["restart", productUnit(product.name)]);
    const answering = await answersWithin(product.port);
    server.log(
      answering
        ? `${product.name}: restarted with its updated unit, and answering.`
        : `${product.name}: restarted with its updated unit, but NOT answering: see modest-deploy logs ${product.name}`,
    );
  }
  server.log(`Installed. Point ${domain}'s DNS at this server: GitHub's messages arrive there.`);
  if (before && before.domain !== domain && products.length) {
    server.log(`The deploy domain was ${before.domain}: run modest-deploy launch again for each product, so GitHub's webhooks point to ${domain}.`);
  }
}

export type Added = { name: string; domain: string; redirects: string[]; repo: string; webhook: string; secret: string; deployKey: string };

/**
 * Adds a product. Caddy is asked first, and the settings saved last, so a failure
 * part way leaves nothing that stops it being run again. Run again for a product
 * already added (the same domain and repository), it gives the same secret and key, and
 * its redirects become the ones given.
 */
export async function add(server: Server, name: string, domain: string, repo: string, anyway = false, redirects: string[] = []): Promise<Added> {
  if (!isName(name)) throw new Error("the name must be 2 to 29 lowercase letters, digits, and single hyphens, starting with a letter");
  if (!isDomain(domain)) throw new Error("the domain must be a domain, such as shop.example.org");
  if (!areRedirects(redirects, domain))
    throw new Error(`the redirects must be up to ${MOST_REDIRECTS} domains, each once, other than the product's own, such as www.shop.example.org`);
  if (!isRepo(repo)) throw new Error("the repository must be owner/name, as on GitHub");
  await checked(server, anyway);
  const { paths, run, node } = server;
  const host = await readHost(paths);
  const existing = await readProduct(paths, name);
  if (existing && (existing.domain !== domain || existing.repo.toLowerCase() !== repo.toLowerCase())) {
    throw new Error(`there's already a product called ${name}, for ${existing.domain} and ${existing.repo}`);
  }
  const others = (await listProducts(paths)).filter((p) => p.name !== name);
  const taken = takenDomain({ name, domain, redirects }, others, host);
  if (taken) throw new Error(`${taken} is already in use here`);
  const product: Product = existing
    ? { ...existing, redirects }
    : {
        name,
        domain,
        redirects,
        repo,
        port: freePort(others, await listening(server)),
        branch: "main",
        workflow: ".github/workflows/ci.yml",
      };

  await caddyWith(server, paths.caddySite(name), productSite(product));
  await systemUser(server, productUser(name));
  const builder = buildUser(name);
  await systemUser(server, builder, paths.buildHome(name));
  await folder(server, paths.buildHome(name), 0o700, builder);

  let secret = existing ? (await readFile(paths.secret(name), "utf8").catch(() => "")).trim() : "";
  if (!/^[0-9a-f]{64}$/.test(secret)) {
    secret = randomBytes(32).toString("hex");
    await writeWhole(paths.secret(name), secret, 0o640);
  }
  await chown(paths.secret(name), 0, Number((await must(run, "id", ["-g", LISTENER_USER])).trim()));
  let deployKey = existing ? (await readFile(`${paths.key(name)}.pub`, "utf8").catch(() => "")).trim() : "";
  if (!deployKey) {
    await rm(paths.key(name), { force: true });
    await rm(`${paths.key(name)}.pub`, { force: true });
    await must(run, "ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `modest-deploy ${name}`, "-f", paths.key(name)]);
    // Made by root in a folder only root can write, then given to this product's build user alone.
    await chown(paths.key(name), await uid(server, builder), 0);
    await chmod(paths.key(name), 0o600);
    deployKey = (await readFile(`${paths.key(name)}.pub`, "utf8")).trim();
  }
  if ((await readFile(paths.env(name), "utf8").catch(() => null)) === null) {
    await writeWhole(paths.env(name), `# ${name}'s own keys, one KEY=value a line. After a change: modest-deploy restart ${name}\n`, 0o600);
  }

  await folder(server, paths.code(name), 0o755);
  await folder(server, paths.releases(name), 0o755);
  await folder(server, paths.source(name), 0o700, builder);
  await must(run, "git", ["init", "--quiet", "--bare", paths.source(name)], { as: builder });

  await writeWhole(paths.unit(productUnit(name)), productService(paths, product, node));
  await must(run, "systemctl", ["daemon-reload"]);
  await must(run, "systemctl", ["enable", productUnit(name)]);
  await saveProduct(paths, product);
  return { name, domain, redirects, repo: product.repo, webhook: `https://${host.domain}/deploy/${name}`, secret, deployKey };
}

/** Takes a product off the server, even one whose settings are broken. Its data, keys file, and copies stay, until deleted by hand. */
export async function remove(server: Server, name: string): Promise<string[]> {
  const { paths, run } = server;
  if (!isName(name)) throw new Error(`there's no product called ${name}`);
  // Anything left of it counts, even from an add that stopped part way.
  const parts = [paths.product(name), paths.unit(productUnit(name)), paths.caddySite(name), paths.secret(name), paths.code(name)];
  const there = (
    await Promise.all(
      parts.map((path) =>
        stat(path).then(
          () => true,
          () => false,
        ),
      ),
    )
  ).some(Boolean);
  if (!there) throw new Error(`there's no product called ${name}`);
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
    const from = p.redirects.length ? ` (from ${p.redirects.join(", ")})` : "";
    rows.push(`${p.name}  https://${p.domain}${from}  ${p.repo}  port ${p.port}  ${state}  ${commit}`);
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
export async function backup(server: Server, today = new Date().toISOString().slice(0, 10)): Promise<{ copied: number; failed: number }> {
  const { paths, run, node, cli } = server;
  let copied = 0;
  let failed = 0;
  const failure = (product: string, db: string, why: string) => {
    failed++;
    console.error(`modest-deploy: ${product}: ${db} wasn't copied: ${why}`);
  };
  for (const product of await listProducts(paths)) {
    // One product's trouble (its user missing, a file gone part way) never stops the others' copies.
    try {
      const user = productUser(product.name);
      // Each product's user can reach only its own folder here (the parent can be passed through, not listed).
      await folder(server, paths.copying, 0o711);
      const work = paths.copyingFor(product.name);
      await rm(work, { recursive: true, force: true });
      await folder(server, work, 0o700, user);
      const night = join(paths.backups(product.name), today);
      for (const db of await databases(paths.data(product.name))) {
        const named = relative(paths.data(product.name), db);
        const size = (await stat(db)).size;
        await mkdir(paths.backups(product.name), { recursive: true, mode: 0o700 });
        const free = await statfs(paths.backups(product.name));
        if (free.bavail * free.bsize < size * 2 + 1024 ** 3) {
          failure(product.name, named, "too little room on the disk (it keeps 1GB free)");
          continue;
        }
        const copy = join(work, "copy.db");
        const made = await run(node, [cli, "copy-database", db, copy], { as: user });
        if (made.code !== 0) {
          failure(product.name, named, made.stderr.trim().split("\n").at(-1) ?? "");
          continue;
        }
        const to = join(night, named);
        await mkdir(join(to, ".."), { recursive: true, mode: 0o700 });
        try {
          // Under another name until it's whole, so a copy cut short is never taken for one.
          await takeCopy(copy, `${to}.partial`, await uid(server, user));
          await rename(`${to}.partial`, to);
          copied++;
        } catch (error) {
          await rm(`${to}.partial`, { force: true });
          failure(product.name, named, error instanceof Error ? error.message : String(error));
        }
      }
      await rm(work, { recursive: true, force: true });
      const nights = (await readdir(paths.backups(product.name)).catch(() => [] as string[])).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
      for (const old of nights.slice(0, Math.max(0, nights.length - NIGHTS)))
        await rm(join(paths.backups(product.name), old), { recursive: true, force: true });
    } catch (error) {
      failure(product.name, "its databases", error instanceof Error ? error.message : String(error));
    }
  }
  return { copied, failed };
}

/**
 * Root takes the product's copy by reading it, never by moving it or changing its
 * owner: the folder is the product's, so what's there could be a link to anything.
 * Only a plain file the product owns is read, into a new file only root can read.
 */
export async function takeCopy(from: string, to: string, owner: number): Promise<void> {
  const source = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const found = await source.stat();
    if (!found.isFile() || found.uid !== owner || found.nlink !== 1) throw new Error("it isn't a plain file of the product's own");
    await rm(to, { force: true });
    const target = await open(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const chunk = Buffer.alloc(1024 * 1024);
      for (let read = await source.read(chunk, 0, chunk.length); read.bytesRead; read = await source.read(chunk, 0, chunk.length)) {
        await target.write(chunk, 0, read.bytesRead);
      }
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
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
  // A copy is only kept if SQLite finds it whole.
  const made = new DatabaseSync(to, { readOnly: true });
  try {
    const result = made.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    if (result?.quick_check !== "ok") throw new Error(`the copy isn't whole: ${String(result?.quick_check)}`);
  } finally {
    made.close();
  }
}
