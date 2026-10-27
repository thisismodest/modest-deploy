// Deploying an app: fetch its repository, check the commit is the newest on main,
// build a release from it (its files, and its dependencies as its lockfile says, with
// install scripts off), switch to it, and check it answers; if it doesn't, switch back.
// Run by the deploy service, as root, with git and npm run as the build user.

import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, rename, rm, stat, statfs, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { App } from "./apps.ts";
import { outsidePorts } from "./check.ts";
import { isCommit } from "./names.ts";
import { appUnit, appUser, buildUser, type Layout } from "./paths.ts";
import { must, type Run } from "./run.ts";

export type Deps = {
  run: Run;
  paths: Layout;
  /** Whether the app answers, within the time it's given. */
  answers: (port: number) => Promise<boolean>;
  log: (line: string) => void;
};

export type Outcome = { deployed: string } | { skipped: string };

/** How many releases are kept: the running one, the one before, and one more to go back to by hand. */
const KEPT = 3;

/** Waits up to a minute for the app to answer anything but a server error at /. */
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

/** The commit an app is running, from where its `current` link points, or null. */
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
function asBuilder(deps: Deps, app: App) {
  const { paths } = deps;
  const node = process.execPath;
  const env = {
    PATH: `${dirname(node)}:/usr/local/bin:/usr/bin:/bin`,
    HOME: paths.buildHome(app.name),
    LANG: "C.UTF-8",
    GIT_TERMINAL_PROMPT: "0",
    // git and npm read only these settings: nothing the repository carries (an .npmrc that names
    // another program as git, say) can change what they run.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    npm_config_userconfig: "/dev/null",
    // A path that doesn't exist, in a folder only root can write: npm reads nothing (it won't take /dev/null twice).
    npm_config_globalconfig: "/etc/modest-deploy/npmrc",
    npm_config_git: "git",
    npm_config_ignore_scripts: "true",
    npm_config_registry: "https://registry.npmjs.org/",
    // Its own read-only key, and GitHub's host keys as published (never trusted on first use).
    GIT_SSH_COMMAND: `ssh -F /dev/null -i ${paths.key(app.name)} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${paths.knownHosts}`,
    npm_config_cache: join(paths.buildHome(app.name), "npm-cache"),
    npm_config_update_notifier: "false",
  };
  // After every step, nothing of the build user's is left running: whatever root does next with
  // its files, nothing of the build's can race it, or change a release root has taken over.
  return async (program: string, args: string[], cwd?: string, allowFail = false) => {
    try {
      if (allowFail) return (await deps.run(program, args, { as: buildUser(app.name), env, ...(cwd ? { cwd } : {}) })).code === 0 ? "yes" : "";
      return await must(deps.run, program, args, { as: buildUser(app.name), env, ...(cwd ? { cwd } : {}) });
    } finally {
      await stopBuilder(deps, app.name);
    }
  };
}

/** Stops every process of the app's build user, and waits until they've gone. */
async function stopBuilder(deps: Deps, name: string): Promise<void> {
  await deps.run("pkill", ["-KILL", "-u", buildUser(name)]);
  for (let i = 0; i < 50 && (await deps.run("pgrep", ["-u", buildUser(name)])).code === 0; i++) await new Promise((wait) => setTimeout(wait, 100));
}

/**
 * Each deploy starts the build user afresh: its home emptied, and its copy of the
 * repository given git's settings and no hooks. So nothing a build did last time (had
 * it ever run code of its own) can carry over into this one.
 */
async function startClean(deps: Deps, app: App): Promise<void> {
  const { paths, run } = deps;
  const { name } = app;
  await stopBuilder(deps, name);
  await rm(paths.buildHome(name), { recursive: true, force: true });
  await mkdir(paths.buildHome(name), { recursive: true, mode: 0o700 });
  await must(run, "chown", [`${buildUser(name)}:${buildUser(name)}`, paths.buildHome(name)]);
  const source = paths.source(name);
  if (!(await exists(join(source, "HEAD")))) {
    await mkdir(source, { recursive: true, mode: 0o700 });
    await must(run, "chown", [`${buildUser(name)}:${buildUser(name)}`, source]);
    await asBuilder(deps, app)("git", ["init", "--quiet", "--bare", source]);
  }
  for (const part of ["config", "hooks", "info"]) await rm(join(source, part), { recursive: true, force: true });
  await writeFile(join(source, "config"), "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n", { flag: "wx", mode: 0o644 });
}

/** Refuses a release holding a hard link: root taking it over would take over what it's linked to. */
async function noHardLinks(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if ((await lstat(join(entry.parentPath, entry.name))).nlink > 1) throw new Error(`it holds a hard link (${entry.name}), which isn't allowed`);
  }
}

/** The most a release's files may come to, and how many there may be, before it's refused. */
const MOST_BYTES = 1024 ** 3;
const MOST_FILES = 200_000;
/** What's always left free on the disk the apps share. */
const KEEP_FREE = 1024 ** 3;

const freeBytes = async (path: string) => {
  const found = await statfs(path);
  return found.bavail * found.bsize;
};

/**
 * Refuses a release too large to build, or too large for the disk, before any of it
 * is written: a commit can't fill the disk the other apps share.
 */
async function roomFor(deps: Deps, app: App, commit: string): Promise<void> {
  const listing = await asBuilder(deps, app)("git", ["--git-dir", deps.paths.source(app.name), "ls-tree", "-r", "-l", "--full-tree", commit]);
  const lines = listing.split("\n").filter(Boolean);
  const bytes = lines.reduce((sum, line) => sum + (Number(line.split(/\s+/)[3]) || 0), 0);
  if (lines.length > MOST_FILES || bytes > MOST_BYTES)
    throw new Error(`it's too large to build: ${lines.length} files, ${Math.round(bytes / 1024 ** 2)}MB (at most ${MOST_FILES} files, and 1GB)`);
  const free = await freeBytes(deps.paths.releases(app.name));
  if (free < bytes * 2 + KEEP_FREE)
    throw new Error(`the disk has ${Math.round(free / 1024 ** 2)}MB free, too little to build it and keep 1GB free: make some room`);
}

/**
 * A small file from a release, read by root only if it's a plain file (never a link,
 * which could point anywhere, or a device that never ends), or null if it isn't there.
 */
async function readPlain(path: string, most = 1024 * 1024): Promise<string | null> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw new Error(`${basename(path)} isn't a plain file`);
  });
  if (!file) return null;
  try {
    const found = await file.stat();
    if (!found.isFile()) throw new Error(`${basename(path)} isn't a plain file`);
    if (found.size > most) throw new Error(`${basename(path)} is larger than ${most / 1024}KB`);
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

/** Builds a release of `commit` in place, owned by root and readable by the app only. */
async function build(deps: Deps, app: App, commit: string): Promise<void> {
  const { paths, run } = deps;
  const { name } = app;
  const builder = asBuilder(deps, app);
  const staging = join(paths.releases(name), `.building-${commit}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  await must(run, "chown", [buildUser(name), staging]);
  try {
    await roomFor(deps, app, commit);
    const tarball = join(staging, ".release.tar");
    await builder("git", ["--git-dir", paths.source(name), "archive", "--format=tar", "-o", tarball, commit]);
    await builder("tar", ["-x", "-f", tarball, "-C", staging, "--no-same-owner", "--no-same-permissions"]);
    await rm(tarball);
    const server = await lstat(join(staging, "server.js")).catch(() => null);
    if (!server?.isFile()) throw new Error("it has no server.js to start");
    const pkg = await readPlain(join(staging, "package.json"));
    let dependencies: string[] = [];
    try {
      dependencies = pkg ? Object.keys((JSON.parse(pkg) as { dependencies?: object }).dependencies ?? {}) : [];
    } catch {
      throw new Error("its package.json isn't valid JSON");
    }
    if (dependencies.length) {
      if (!(await exists(join(staging, "package-lock.json"))))
        throw new Error("it has dependencies but no package-lock.json: commit one, so what's installed is exactly what was tested");
      // A project's own .npmrc could still set what the environment doesn't: it's never read.
      await rm(join(staging, ".npmrc"), { force: true });
      await builder(join(dirname(process.execPath), "npm"), ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], staging);
      await rm(join(paths.buildHome(name), "npm-cache"), { recursive: true, force: true });
      if ((await freeBytes(staging)) < KEEP_FREE) throw new Error("its dependencies leave less than 1GB free on the disk: make some room");
    }
    // From here, nobody can change it: root owns it, and only the app's own user can read it.
    await noHardLinks(staging);
    await must(run, "chown", ["-R", "--no-dereference", `root:${appUser(name)}`, staging]);
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
 * An older commit is skipped, so a message sent again can't roll an app back.
 */
export async function deploy(deps: Deps, app: App, wanted: string | "tip"): Promise<Outcome> {
  const { paths } = deps;
  const { name } = app;
  await startClean(deps, app);
  const builder = asBuilder(deps, app);
  const source = paths.source(name);
  const refspec = `+refs/heads/${app.branch}:refs/heads/${app.branch}`;
  try {
    await builder("git", ["--git-dir", source, "fetch", "--quiet", "--prune", "--no-tags", `git@github.com:${app.repo}.git`, refspec]);
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    if (/HOST IDENTIFICATION HAS CHANGED|Host key verification failed/.test(said)) {
      throw new Error(
        "the server answering as github.com didn't have GitHub's host key, so nothing was fetched (if GitHub has changed its keys, run modest-deploy install again to fetch them)",
      );
    }
    if (/Permission denied \(publickey\)|Repository not found/.test(said)) {
      throw new Error(`GitHub refused this server's deploy key for ${app.repo}: add it as a read-only deploy key in the repository's settings`);
    }
    throw error;
  }
  const tip = (await builder("git", ["--git-dir", source, "rev-parse", "--verify", `refs/heads/${app.branch}^{commit}`])).trim();
  if (!isCommit(tip)) throw new Error(`${app.branch} isn't a commit`);
  if (wanted !== "tip" && wanted !== tip) {
    const older = await builder("git", ["--git-dir", source, "merge-base", "--is-ancestor", wanted, tip], undefined, true);
    return {
      skipped: older ? `${wanted.slice(0, 7)} is older than ${app.branch}'s newest, ${tip.slice(0, 7)}` : `${wanted.slice(0, 7)} isn't on ${app.branch}`,
    };
  }
  const before = await running(paths, name);
  if (before === tip) return { skipped: `${tip.slice(0, 7)} is already running` };
  // A commit that failed isn't tried again by a message (one sent again, say), only by hand.
  const failed = join(paths.code(name), "failed");
  if (wanted !== "tip" && (await readPlain(failed).catch(() => null))?.trim() === tip) {
    return { skipped: `${tip.slice(0, 7)} failed before: push a fix, or try again with modest-deploy deploy ${name}` };
  }
  try {
    const outcome = await switchTo(deps, app, tip, before);
    await rm(failed, { force: true });
    return outcome;
  } catch (error) {
    await writeFile(failed, tip).catch(() => {});
    throw error;
  }
}

/** Builds `tip` if it isn't built, switches to it, and checks it; any failure after the switch goes back to `before`. */
async function switchTo(deps: Deps, app: App, tip: string, before: string | null): Promise<Outcome> {
  const { paths, run, log } = deps;
  const { name } = app;
  await mkdir(paths.releases(name), { recursive: true });
  if ((await freeBytes(paths.releases(name))) < KEEP_FREE) throw new Error("the disk has less than 1GB free: make some room");
  log(`${name}: building ${tip.slice(0, 7)}`);
  if (!(await exists(join(paths.release(name, tip), "server.js")))) await build(deps, app, tip);
  await pointAt(paths, name, tip);
  let failure: string;
  try {
    await must(run, "systemctl", ["restart", appUnit(name)]);
    if (!(await deps.answers(app.port))) failure = "didn't answer";
    else if (await listensOutside(deps, app.port)) failure = "listens beyond this machine (it should listen on process.env.HOST)";
    else {
      await prune(paths, name, new Set([tip, ...(before ? [before] : [])]));
      log(`${name}: running ${tip.slice(0, 7)}`);
      return { deployed: tip };
    }
  } catch (error) {
    failure = `failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (before) {
    await pointAt(paths, name, before);
    const back = await run("systemctl", ["restart", appUnit(name)]);
    const restarted =
      back.code !== 0
        ? `and ${before.slice(0, 7)} didn't restart either (${back.stderr.trim()})`
        : (await deps.answers(app.port))
          ? `so ${before.slice(0, 7)} is running again`
          : `and ${before.slice(0, 7)} restarted but isn't answering either`;
    throw new Error(`${tip.slice(0, 7)} ${failure}, ${restarted}: see journalctl -u ${appUnit(name)}`);
  }
  await run("systemctl", ["stop", appUnit(name)]);
  throw new Error(`${tip.slice(0, 7)} ${failure}, and there's nothing before it to go back to: see journalctl -u ${appUnit(name)}`);
}

/** Whether anything listens on the app's port on an address other than this machine's own. */
async function listensOutside(deps: Deps, port: number): Promise<boolean> {
  const ss = await deps.run("ss", ["-Hltn"]);
  return outsidePorts(ss.stdout).some((local) => local.endsWith(`:${port}`));
}
