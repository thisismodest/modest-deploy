// The deploy, against a real git repository standing in for GitHub. systemctl, chown,
// and chmod are recorded rather than run (they need a real server: see the end-to-end
// test); git, tar, and the files are real.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { COMMIT, onServer, PRODUCT } from "../test/helpers.ts";
import { type Deps, deploy, running } from "./deploy.ts";
import type { Layout } from "./paths.ts";
import { type Run, run as realRun } from "./run.ts";

/** A repository standing in for GitHub's, with a commit per entry in `servers` (each a server.js), newest last. */
function origin(dir: string, servers: string[]): string[] {
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  git("config", "user.email", "test@example.org");
  git("config", "user.name", "Test");
  return servers.map((server, i) => {
    execFileSync("sh", ["-c", `printf %s "$1" > "$2"`, "sh", server, join(dir, "server.js")]);
    git("add", "server.js");
    git("commit", "-q", "-m", `version ${i}`);
    return git("rev-parse", "HEAD");
  });
}

type Recorded = string[][];

/** The real runner for git and tar, run as this user (not runuser), with GitHub's address swapped for the stand-in. */
function fakeSystem(remote: string, recorded: Recorded): Run {
  return async (program, args, options = {}) => {
    recorded.push([program, ...args]);
    if (["systemctl", "chown", "chmod"].includes(program)) return { code: 0, stdout: "", stderr: "" };
    const swapped = args.map((a) => (a.startsWith("git@github.com:") ? remote : a));
    const { as: _as, env: _env, ...rest } = options;
    return realRun(program, swapped, rest);
  };
}

async function setUp(paths: Layout, servers: string[]) {
  const remote = join(paths.root, "github", "shop");
  const commits = origin(remote, servers);
  execFileSync("git", ["init", "-q", "--bare", paths.source("shop")]);
  await mkdir(paths.releases("shop"), { recursive: true });
  const recorded: Recorded = [];
  const logs: string[] = [];
  const answers: boolean[] = [];
  const deps: Deps = { run: fakeSystem(remote, recorded), paths, answers: async () => answers.shift() ?? true, log: (l) => logs.push(l) };
  return { commits, recorded, logs, answers, deps, remote };
}

test("the newest commit on main is built, switched to, and restarted, and the release is the repository's files", () =>
  onServer(async (paths) => {
    const { commits, recorded, deps } = await setUp(paths, ["one"]);
    const [first = ""] = commits;
    assert.deepEqual(await deploy(deps, PRODUCT, first), { deployed: first });
    assert.equal(await running(paths, "shop"), first);
    assert.equal(await readFile(join(paths.current("shop"), "server.js"), "utf8"), "one");
    assert.ok(recorded.some((c) => c.join(" ") === "systemctl restart modest-host-shop.service"));
    assert.ok(
      recorded.some((c) => c[0] === "chown" && c.includes("root:mh-shop")),
      "owned by root, readable by the product",
    );
  }));

test("a commit older than main's newest is skipped, so a message sent again can't roll a product back", () =>
  onServer(async (paths) => {
    const { commits, deps } = await setUp(paths, ["one", "two"]);
    const [first = "", second = ""] = commits;
    assert.deepEqual(await deploy(deps, PRODUCT, second), { deployed: second });
    const again = await deploy(deps, PRODUCT, first);
    assert.ok("skipped" in again && /older/.test(again.skipped));
    assert.equal(await running(paths, "shop"), second);
  }));

test("a commit that isn't on main is never deployed", () =>
  onServer(async (paths) => {
    const { deps } = await setUp(paths, ["one"]);
    const outcome = await deploy(deps, PRODUCT, COMMIT);
    assert.ok("skipped" in outcome && /isn't on main/.test(outcome.skipped));
    assert.equal(await running(paths, "shop"), null);
  }));

test("deploying what's already running does nothing", () =>
  onServer(async (paths) => {
    const { commits, recorded, deps } = await setUp(paths, ["one"]);
    await deploy(deps, PRODUCT, "tip");
    const restarts = recorded.filter((c) => c[1] === "restart").length;
    const again = await deploy(deps, PRODUCT, commits[0] ?? "");
    assert.ok("skipped" in again);
    assert.equal(recorded.filter((c) => c[1] === "restart").length, restarts);
  }));

test("a release that doesn't answer is switched back to the one before, which is restarted", () =>
  onServer(async (paths) => {
    const { commits, deps, answers, remote } = await setUp(paths, ["one"]);
    await deploy(deps, PRODUCT, "tip");
    const [, second = ""] = [...commits, ...origin(remote, ["broken"])];
    answers.push(false, true);
    await assert.rejects(deploy(deps, PRODUCT, second), /didn't answer.*running again/);
    assert.equal(await running(paths, "shop"), commits[0]);
    assert.equal(await readFile(join(paths.current("shop"), "server.js"), "utf8"), "one");
  }));

test("a repository with no server.js, or with dependencies but no lockfile, isn't deployed, and nothing is left half-built", () =>
  onServer(async (paths) => {
    const { deps, remote } = await setUp(paths, ["one"]);
    execFileSync("git", ["-C", remote, "rm", "-q", "server.js"]);
    execFileSync("git", ["-C", remote, "commit", "-q", "-m", "gone"]);
    await assert.rejects(deploy(deps, PRODUCT, "tip"), /no server\.js/);
    execFileSync("sh", ["-c", `echo one > "$1/server.js" && echo '{"dependencies":{"modest-auth":"0.3.0"}}' > "$1/package.json"`, "sh", remote]);
    execFileSync("git", ["-C", remote, "add", "."]);
    execFileSync("git", ["-C", remote, "commit", "-q", "-m", "deps"]);
    await assert.rejects(deploy(deps, PRODUCT, "tip"), /no package-lock\.json/);
    assert.equal(await running(paths, "shop"), null);
    const left = execFileSync("ls", ["-A", paths.releases("shop")], { encoding: "utf8" }).trim();
    assert.equal(left, "", "no half-built release");
  }));

test("old releases are removed, keeping the running one and two more", () =>
  onServer(async (paths) => {
    const { deps, remote } = await setUp(paths, ["v0"]);
    await deploy(deps, PRODUCT, "tip");
    for (const version of ["v1", "v2", "v3", "v4"]) {
      origin(remote, [version]);
      await new Promise((wait) => setTimeout(wait, 20));
      await deploy(deps, PRODUCT, "tip");
    }
    const kept = execFileSync("ls", [paths.releases("shop")], { encoding: "utf8" })
      .trim()
      .split("\n");
    assert.equal(kept.length, 3);
    assert.ok(kept.includes((await running(paths, "shop")) ?? ""));
  }));

test("git and npm run as the build user, with GitHub's keys pinned and the product's own deploy key", () =>
  onServer(async (paths) => {
    const seen: { program: string; as?: string | undefined; env?: Record<string, string> | undefined }[] = [];
    const { deps, remote } = await setUp(paths, ["one"]);
    const inner = deps.run;
    deps.run = (program, args, options = {}) => {
      seen.push({ program, as: options.as, env: options.env });
      return inner(program, args, options);
    };
    await writeFile(join(remote, "x"), "x");
    await deploy(deps, PRODUCT, "tip");
    const git = seen.filter((s) => s.program === "git");
    assert.ok(git.length > 0 && git.every((s) => s.as === "modest-host-build"));
    const ssh = git[0]?.env?.GIT_SSH_COMMAND ?? "";
    assert.match(ssh, /StrictHostKeyChecking=yes/);
    assert.match(ssh, /-i \S+\/etc\/modest-host\/keys\/shop /);
  }));

test("a package.json that's a link (to /dev/zero, or a secret) is refused, never read by root", () =>
  onServer(async (paths) => {
    const { deps, remote } = await setUp(paths, ["one"]);
    for (const target of ["/dev/zero", "/etc/passwd"]) {
      execFileSync("sh", ["-c", `rm -f "$1/package.json" && ln -s "$2" "$1/package.json"`, "sh", remote, target]);
      execFileSync("git", ["-C", remote, "add", "-A"]);
      execFileSync("git", ["-C", remote, "commit", "-q", "-m", `link to ${target}`]);
      await assert.rejects(deploy(deps, PRODUCT, "tip"), /package\.json isn't a plain file/);
    }
    assert.equal(await running(paths, "shop"), null);
  }));

test("a version that listens beyond this machine is switched back: it must listen on HOST, behind Caddy", () =>
  onServer(async (paths) => {
    const { commits, deps, remote } = await setUp(paths, ["one"]);
    await deploy(deps, PRODUCT, "tip");
    const [, second = ""] = [...commits, ...origin(remote, ["everywhere"])];
    const inner = deps.run;
    deps.run = async (program, args, options) =>
      program === "ss" ? { code: 0, stdout: "LISTEN 0 511 0.0.0.0:4100 0.0.0.0:*\n", stderr: "" } : inner(program, args, options);
    await assert.rejects(deploy(deps, PRODUCT, second), /listens beyond this machine.*running again/);
    assert.equal(await running(paths, "shop"), commits[0]);
  }));
