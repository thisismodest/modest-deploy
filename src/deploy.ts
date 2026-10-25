// Deploying a product: fetch its repository, check the commit is the newest on main,
// build a release from it (its files, and its dependencies as its lockfile says, with
// install scripts off), switch to it, and check it answers; if it doesn't, switch back.
// Run by the deploy service, as root, with git and npm run as the build user.

import { lstat, mkdir, readdir, readFile, readlink, rename, rm, stat, symlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isCommit } from "./names.ts";
import { BUILD_USER, type Layout, productUnit, productUser } from "./paths.ts";
import type { Product } from "./products.ts";
import { must, type Run } from "./run.ts";

export type Deps = {
  run: Run;
  paths: Layout;
  /** Whether the product answers, within the time it's given. */
  answers: (port: number) => Promise<boolean>;
  log: (line: string) => void;
};

export type Outcome = { deployed: string } | { skipped: string };

/** How many releases are kept: the running one, the one before, and one more to go back to by hand. */
const KEPT = 3;

/** Waits up to a minute for the product to answer anything but a server error at /. */
export async function answersWithin(port: number, seconds = 60): Promise<boolean> {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual", signal: AbortSignal.timeout(5000) });
      await res.body?.cancel();
      if (res.status < 500) return true;
    } catch {}
    await new Promise((wait) => setTimeout(wait, 1000));
  }
  return false;
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** The commit a product is running, from where its `current` link points, or null. */
export async function running(paths: Layout, name: string): Promise<string | null> {
  const target = await readlink(paths.current(name)).catch(() => null);
  const commit = target ? basename(target) : null;
  return commit && isCommit(commit) ? commit : null;
}

/** Points `current` at a release, all at once: a new link beside it, moved over the old. */
async function pointAt(paths: Layout, name: string, commit: string): Promise<void> {
  const next = `${paths.current(name)}.next`;
  await rm(next, { force: true });
  await symlink(paths.release(name, commit), next);
  await rename(next, paths.current(name));
}

/** git and npm, as the build user, with only what they need in their environment. */
function asBuilder(deps: Deps, product: Product) {
  const { paths } = deps;
  const node = process.execPath;
  const env = {
    PATH: `${dirname(node)}:/usr/local/bin:/usr/bin:/bin`,
    HOME: paths.buildHome,
    LANG: "C.UTF-8",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    // Its own read-only key, and GitHub's host keys as published (never trusted on first use).
    GIT_SSH_COMMAND: `ssh -i ${paths.key(product.name)} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${paths.knownHosts}`,
    npm_config_cache: join(paths.buildHome, "npm-cache"),
    npm_config_update_notifier: "false",
  };
  return (program: string, args: string[], cwd?: string) => must(deps.run, program, args, { as: BUILD_USER, env, ...(cwd ? { cwd } : {}) });
}

/** Builds a release of `commit` in place, owned by root and readable by the product only. */
async function build(deps: Deps, product: Product, commit: string): Promise<void> {
  const { paths, run } = deps;
  const { name } = product;
  const builder = asBuilder(deps, product);
  const staging = join(paths.releases(name), `.building-${commit}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  await must(run, "chown", [BUILD_USER, staging]);
  try {
    const tarball = join(staging, ".release.tar");
    await builder("git", ["--git-dir", paths.source(name), "archive", "--format=tar", "-o", tarball, commit]);
    await builder("tar", ["-x", "-f", tarball, "-C", staging, "--no-same-owner", "--no-same-permissions"]);
    await rm(tarball);
    const server = await lstat(join(staging, "server.js")).catch(() => null);
    if (!server?.isFile()) throw new Error("it has no server.js to start");
    const pkg = await readFile(join(staging, "package.json"), "utf8").catch(() => null);
    const dependencies = pkg ? Object.keys((JSON.parse(pkg) as { dependencies?: object }).dependencies ?? {}) : [];
    if (dependencies.length) {
      if (!(await exists(join(staging, "package-lock.json"))))
        throw new Error("it has dependencies but no package-lock.json: commit one, so what's installed is exactly what was tested");
      await builder(join(dirname(process.execPath), "npm"), ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], staging);
    }
    // From here, nobody can change it: root owns it, and only the product's own user can read it.
    await must(run, "chown", ["-R", "--no-dereference", `root:${productUser(name)}`, staging]);
    await must(run, "chmod", ["-R", "u=rwX,g=rX,o=", staging]);
    await rm(paths.release(name, commit), { recursive: true, force: true });
    await rename(staging, paths.release(name, commit));
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Removes old releases, keeping the newest few and never the running one or the one before. */
async function prune(paths: Layout, name: string, keep: Set<string>): Promise<void> {
  const dir = paths.releases(name);
  const found = (await readdir(dir).catch(() => [] as string[])).filter(isCommit);
  const dated = await Promise.all(found.map(async (commit) => ({ commit, at: (await stat(join(dir, commit))).mtimeMs })));
  dated.sort((a, b) => b.at - a.at);
  for (const [i, { commit }] of dated.entries()) {
    if (i >= KEPT && !keep.has(commit)) await rm(join(dir, commit), { recursive: true, force: true });
  }
}

/**
 * Deploys `wanted` (a commit, or "tip" for main's newest), if it's still main's newest.
 * An older commit is skipped, so a message sent again can't roll a product back.
 */
export async function deploy(deps: Deps, product: Product, wanted: string | "tip"): Promise<Outcome> {
  const { paths, run, log } = deps;
  const { name } = product;
  const builder = asBuilder(deps, product);
  const source = paths.source(name);
  const refspec = `+refs/heads/${product.branch}:refs/heads/${product.branch}`;
  try {
    await builder("git", ["--git-dir", source, "fetch", "--quiet", "--prune", "--no-tags", `git@github.com:${product.repo}.git`, refspec]);
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    if (/HOST IDENTIFICATION HAS CHANGED|Host key verification failed/.test(said)) {
      throw new Error(
        "the server answering as github.com didn't have GitHub's host key, so nothing was fetched (if GitHub has changed its keys, run modest-host install again to fetch them)",
      );
    }
    if (/Permission denied \(publickey\)|Repository not found/.test(said)) {
      throw new Error(`GitHub refused this server's deploy key for ${product.repo}: add it as a read-only deploy key in the repository's settings`);
    }
    throw error;
  }
  const tip = (await builder("git", ["--git-dir", source, "rev-parse", "--verify", `refs/heads/${product.branch}^{commit}`])).trim();
  if (!isCommit(tip)) throw new Error(`${product.branch} isn't a commit`);
  if (wanted !== "tip" && wanted !== tip) {
    const older = await run("git", ["--git-dir", source, "merge-base", "--is-ancestor", wanted, tip], { as: BUILD_USER });
    return {
      skipped:
        older.code === 0
          ? `${wanted.slice(0, 7)} is older than ${product.branch}'s newest, ${tip.slice(0, 7)}`
          : `${wanted.slice(0, 7)} isn't on ${product.branch}`,
    };
  }
  const before = await running(paths, name);
  if (before === tip) return { skipped: `${tip.slice(0, 7)} is already running` };

  log(`${name}: building ${tip.slice(0, 7)}`);
  if (!(await exists(join(paths.release(name, tip), "server.js")))) await build(deps, product, tip);
  await pointAt(paths, name, tip);
  await must(run, "systemctl", ["restart", productUnit(name)]);
  if (await deps.answers(product.port)) {
    await prune(paths, name, new Set([tip, ...(before ? [before] : [])]));
    log(`${name}: running ${tip.slice(0, 7)}`);
    return { deployed: tip };
  }
  if (before) {
    await pointAt(paths, name, before);
    await must(run, "systemctl", ["restart", productUnit(name)]);
    throw new Error(`${tip.slice(0, 7)} didn't answer, so ${before.slice(0, 7)} is running again: see journalctl -u ${productUnit(name)}`);
  }
  await run("systemctl", ["stop", productUnit(name)]);
  throw new Error(`${tip.slice(0, 7)} didn't answer, and there's nothing before it to go back to: see journalctl -u ${productUnit(name)}`);
}
