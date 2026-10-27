// The end-to-end test, run as root inside a fresh Ubuntu server with systemd (see
// run.sh). It does what a person would: check, install, add two apps, and deploy
// them through signed webhook messages; then checks every promise on the real system.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

const sh = (program: string, args: string[], options: { cwd?: string; allowFail?: boolean } = {}) => {
  try {
    return execFileSync(program, args, { cwd: options.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (options.allowFail) return `${(error as { stdout?: string }).stdout ?? ""}${(error as { stderr?: string }).stderr ?? ""}`;
    throw error;
  }
};
const step = (what: string) => console.log(`\n== ${what}`);
const ok = (what: string) => console.log(`   ok: ${what}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mh = (...args: string[]) => sh("modest-deploy", args);

const secrets: Record<string, string> = {};
const commits: Record<string, string[]> = { club: [], blog: [] };

/** Commits a version of an app to the stand-in GitHub, returning its commit. */
function commit(name: string, version: string, server = readFileSync("/e2e/app.js", "utf8").replace("__VERSION__", version)): string {
  const work = `/root/work/${name}`;
  writeFileSync(`${work}/server.js`, server);
  sh("git", ["add", "-A"], { cwd: work });
  sh("git", ["commit", "-q", "-m", version], { cwd: work });
  sh("git", ["push", "-q", "origin", "main"], { cwd: work });
  const sha = sh("git", ["rev-parse", "HEAD"], { cwd: work }).trim();
  commits[name]?.push(sha);
  return sha;
}

/** A webhook message as GitHub sends it when CI passes, signed with `secret`. */
async function webhook(name: string, sha: string, secret = secrets[name] ?? "", event = "workflow_run") {
  const body = JSON.stringify({
    action: "completed",
    repository: { full_name: `example/${name}` },
    workflow_run: {
      path: ".github/workflows/ci.yml",
      event: "push",
      head_branch: "main",
      conclusion: "success",
      head_sha: sha,
      head_repository: { full_name: `example/${name}` },
    },
  });
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return fetch(`http://127.0.0.1:9327/deploy/${name}`, { method: "POST", body, headers: { "x-github-event": event, "x-hub-signature-256": signature } });
}

/** Waits until no deploy is waiting or running. */
async function settled() {
  await sleep(1500);
  for (let i = 0; i < 240; i++) {
    const waiting = readdirSync("/var/spool/modest-deploy/requests").length;
    const state = sh("systemctl", ["is-active", "modest-deploy-deploy.service"], { allowFail: true }).trim();
    if (!waiting && state !== "activating") return;
    await sleep(500);
  }
  throw new Error("the deploy never finished");
}

const answer = async (port: number, path = "/") => {
  try {
    return await (await fetch(`http://127.0.0.1:${port}${path}`)).text();
  } catch {
    return "(nothing)";
  }
};

step("check, on a server set up as the README says");
console.log(mh("check"));
ok("every check passes");

step("install");
console.log(mh("install", "--domain", "deploy.example.org"));
for (const unit of ["modest-deploy-listener.service", "modest-deploy-deploy.path", "modest-deploy-backup.timer"]) {
  assert.equal(sh("systemctl", ["is-active", unit]).trim(), "active", unit);
}
ok("the listener, the deploy path, and the backup timer are running");

step("add two apps");
const added: Record<string, { port?: number; deployKey: string; secret: string; webhook: string }> = {};
for (const name of ["club", "blog"]) {
  const out = mh("add", name, "--domain", `${name}.example.org`, "--repo", `example/${name}`, "--json").trim().split("\n").at(-1) ?? "";
  added[name] = JSON.parse(out);
  secrets[name] = added[name]?.secret ?? "";
}
assert.equal(added.club?.webhook, "https://deploy.example.org/deploy/club");
const ports = {
  club: JSON.parse(readFileSync("/etc/modest-deploy/apps/club.json", "utf8")).port,
  blog: JSON.parse(readFileSync("/etc/modest-deploy/apps/blog.json", "utf8")).port,
};
ok(`added, on ports ${ports.club} and ${ports.blog}`);

step("the stand-in GitHub");
sh("sh", ["-c", "mkdir -p /home/git/.ssh /home/git/example && chown -R git:git /home/git"]);
writeFileSync("/home/git/.ssh/authorized_keys", `${added.club?.deployKey}\n${added.blog?.deployKey}\n`);
sh("chown", ["git:git", "/home/git/.ssh/authorized_keys"]);
sh("git", ["config", "--global", "--add", "safe.directory", "*"]);
for (const name of ["club", "blog"]) {
  sh("runuser", ["-u", "git", "--", "git", "init", "-q", "--bare", "-b", "main", `/home/git/example/${name}.git`]);
  sh("git", ["clone", "-q", `/home/git/example/${name}.git`, `/root/work/${name}`]);
  sh("git", ["config", "user.email", "e2e@example.org"], { cwd: `/root/work/${name}` });
  sh("git", ["config", "user.name", "E2E"], { cwd: `/root/work/${name}` });
  sh("git", ["checkout", "-q", "-b", "main"], { cwd: `/root/work/${name}` });
  writeFileSync(`/root/work/${name}/package.json`, JSON.stringify({ name, private: true, type: "module", dependencies: { "modest-auth": "0.3.0" } }));
  sh("npm", ["install", "--package-lock-only", "--ignore-scripts", "--silent"], { cwd: `/root/work/${name}` });
}
ok("two repositories, reachable as git@github.com:example/<name>.git");

step("a stand-in GitHub that isn't GitHub is refused: its host key isn't GitHub's");
const v1 = commit("club", "club v1");
assert.equal((await webhook("club", v1)).status, 202);
await settled();
assert.equal(await answer(ports.club), "(nothing)");
assert.match(sh("journalctl", ["-u", "modest-deploy-deploy.service", "--no-pager"]), /didn't have GitHub's host key/);
ok("nothing deployed: GitHub's real host keys are pinned");
const hostKey = readFileSync("/etc/ssh/ssh_host_ed25519_key.pub", "utf8").split(" ").slice(0, 2).join(" ");
writeFileSync("/etc/modest-deploy/keys/known_hosts", `github.com ${hostKey}\n`);

step("a signed message for a passed CI run deploys");
const response = await webhook("club", v1);
assert.equal(response.status, 202);
assert.match(await response.text(), /Deploying/);
await settled();
assert.equal(await answer(ports.club), "club v1");
ok("club v1 is running, with modest-auth installed from npm");
await webhook("blog", commit("blog", "blog v1"));
await settled();
assert.equal(await answer(ports.blog), "blog v1");
ok("blog v1 is running");

step("through Caddy, on HTTPS");
const viaCaddy = sh("curl", ["-sk", "--resolve", "club.example.org:443:127.0.0.1", "https://club.example.org/"]);
assert.equal(viaCaddy, "club v1");
const deployDomain = sh("curl", [
  "-sk",
  "-o",
  "/dev/null",
  "-w",
  "%{http_code}",
  "--resolve",
  "deploy.example.org:443:127.0.0.1",
  "https://deploy.example.org/anything",
]);
assert.equal(deployDomain, "404");
const viaDeploy = sh("curl", [
  "-sk",
  "-o",
  "/dev/null",
  "-w",
  "%{http_code}",
  "-X",
  "POST",
  "--resolve",
  "deploy.example.org:443:127.0.0.1",
  "https://deploy.example.org/deploy/club",
]);
assert.equal(viaDeploy, "401");
ok("the app answers on its domain; the deploy domain only passes /deploy/ on, and refuses an unsigned message");

step("an unsigned or wrongly signed message is refused, and leaves nothing");
assert.equal((await webhook("club", v1, "wrong")).status, 401);
assert.equal(readdirSync("/var/spool/modest-deploy/requests").length, 0);
ok("refused");

step("each app is sandboxed");
const withBpf = sh("systemctl", ["--version"]).includes("+BPF_FRAMEWORK");
const probe = JSON.parse(await answer(ports.club, "/probe?other=blog")) as Record<string, string>;
console.log(probe);
for (const [what, result] of Object.entries(probe)) {
  if (what === "write its own data") assert.equal(result, "allowed", what);
  // SocketBindDeny needs systemd built with its BPF framework: Ubuntu 26.04's is, 24.04's isn't.
  else if (what !== "listen on another port" || withBpf) assert.notEqual(result, "allowed", what);
}
ok(
  withBpf
    ? "it can write its own data, and nothing else, not even listen on another port"
    : "it can write its own data, and nothing else it tried (but another port: see the threat model's known limits)",
);

step("each app's build user reaches only its own key and source");
for (const path of ["/etc/modest-deploy/keys/blog", "/srv/modest-deploy/blog/source.git/HEAD", "/etc/modest-deploy/secrets/blog"]) {
  assert.match(sh("runuser", ["-u", "mb-club", "--", "cat", path], { allowFail: true }), /Permission denied/, path);
}
assert.match(sh("runuser", ["-u", "mb-club", "--", "ls", "/etc/modest-deploy/keys"], { allowFail: true }), /Permission denied/);
ok("club's build user can't read blog's key, source, or secret, nor list the keys");

step("a newer version deploys; an old message sent again doesn't roll it back");
const v2 = commit("club", "club v2");
await webhook("club", v2);
await settled();
assert.equal(await answer(ports.club), "club v2");
await webhook("club", v1);
await settled();
assert.equal(await answer(ports.club), "club v2");
assert.match(sh("journalctl", ["-u", "modest-deploy-deploy.service", "--no-pager"]), /older than main's newest/);
ok("v2 running, and v1's message again was skipped");

step("a version that doesn't start is switched back");
const v3 = commit("club", "broken", 'throw new Error("this version is broken");\n');
await webhook("club", v3);
await settled();
assert.equal(await answer(ports.club), "club v2");
assert.match(sh("journalctl", ["-u", "modest-deploy-deploy.service", "--no-pager"]), /didn't answer, so \w+ is running again/);
ok("v2 is running again");

step("backup");
console.log(mh("backup"));
const night = new Date().toISOString().slice(0, 10);
const copy = `/var/backups/modest-deploy/club/${night}/app.db`;
assert.equal((statSync(copy).mode & 0o777).toString(8), "600");
assert.equal(statSync(copy).uid, 0);
const { DatabaseSync } = await import("node:sqlite");
assert.equal(new DatabaseSync(copy, { readOnly: true }).prepare("select count(*) as n from auth_users").get()?.n, 0);
assert.equal(statSync("/var/lib/modest-deploy/club/app.db").uid, Number(sh("id", ["-u", "md-club"]).trim()), "the app's own files stay its own");
ok("a working copy, readable by root only, and the app's files untouched");

step("run again: add gives the same secret and key; install brings every unit up to date");
const again = JSON.parse(mh("add", "club", "--domain", "club.example.org", "--repo", "example/club", "--json").trim().split("\n").at(-1) ?? "{}");
assert.equal(again.secret, secrets.club);
assert.equal(again.deployKey, added.club?.deployKey);
assert.match(
  sh("modest-deploy", ["add", "club", "--domain", "other.example.org", "--repo", "example/club"], { allowFail: true }),
  /already an app called club/,
);
// Caddy itself checks the redirect's site before it's kept (add validates, then reloads).
mh("add", "club", "--domain", "club.example.org", "--repo", "example/club", "--redirect", "www.club.example.org");
assert.match(readFileSync("/etc/modest-deploy/caddy/club.caddy", "utf8"), /www\.club\.example\.org \{\n\tredir https:\/\/club\.example\.org\{uri\} permanent/);
assert.match(
  sh("modest-deploy", ["add", "blog", "--domain", "blog.example.org", "--repo", "example/blog", "--redirect", "www.club.example.org"], { allowFail: true }),
  /www\.club\.example\.org is already in use here/,
);
console.log(mh("install"));
assert.equal(await answer(ports.club), "club v2");
ok("the same secret and key; a different domain refused; a redirect Caddy accepts, and one already in use refused; install again keeps everything running");

step("list, and remove");
console.log(mh("list"));
console.log(mh("remove", "blog"));
assert.equal(sh("systemctl", ["is-active", "modest-deploy-blog.service"], { allowFail: true }).trim(), "inactive");
assert.equal(readFileSync("/var/lib/modest-deploy/blog/note.txt", "utf8"), "kept");
assert.equal((await webhook("blog", commits.blog?.[0] ?? "")).status, 401, "the same answer as an app that never existed");
ok("removed; its data kept; its webhook answers as if it never existed");

step("check, again, with everything running");
console.log(mh("check"));
ok("still passes: nothing listens to the outside but SSH, HTTP, and HTTPS");

console.log("\nEnd to end: every step passed.");
