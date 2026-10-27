// The acceptance checks (docs/acceptance-checks.md), run as root inside the end-to-end
// server after inside.ts. Each confirms that a protection the README or the threat model
// promises holds on the real system, by trying what it guards against: written from those
// documents, not from the code. A check that fails is a finding, not something to fix
// here. Numbers are the list's.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { createSocket } from "node:dgram";
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { connect, createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";

// ---- Running programs

type Ran = { code: number; out: string };
const run = (program: string, args: string[], options: { cwd?: string; input?: string; timeout?: number } = {}): Ran => {
  try {
    const out = execFileSync(program, args, {
      cwd: options.cwd,
      input: options.input,
      encoding: "utf8",
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      timeout: options.timeout ?? 600000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, out };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failed.status ?? 1, out: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  }
};
const sh = (program: string, args: string[], options: { cwd?: string; input?: string } = {}) => {
  const ran = run(program, args, options);
  if (ran.code !== 0) throw new Error(`${program} ${args.join(" ")} failed (${ran.code}): ${ran.out.slice(0, 2000)}`);
  return ran.out;
};
/** modest-deploy itself; add and install fetch GitHub's host keys again, so the stand-in is pinned after. */
const md = (...args: string[]) => {
  const ran = run("modest-deploy", args);
  if (args[0] === "add" || args[0] === "install") pinStandIn();
  return ran;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Where the journal is now, so a check reads only what was logged after it. */
const now = () =>
  run("journalctl", ["-n", "0", "--show-cursor", "--no-pager"])
    .out.match(/-- cursor: (.*)/)?.[1]
    ?.trim() ?? "";
const journal = async (unit: string, since: string) => {
  await sleep(1000);
  return run("journalctl", ["-u", unit, `--after-cursor=${since}`, "-o", "cat", "--no-pager"]).out;
};
const DEPLOY = "modest-deploy-deploy.service";
const REQUESTS = "/var/spool/modest-deploy/requests";

// ---- Recording outcomes

type Outcome = { n: number; what: string; outcome: "passed" | "failed" | "skipped"; note: string };
const outcomes: Outcome[] = [];
const SKIP = Symbol("skip");
const skip = (reason: string): never => {
  throw { [SKIP]: reason };
};
const notes: string[] = [];
const note = (line: string) => {
  notes.push(line);
  console.log(`   ${line}`);
};

async function check(n: number, what: string, body: () => Promise<void> | void) {
  console.log(`\n== ${n}. ${what}`);
  notes.length = 0;
  try {
    await body();
    outcomes.push({ n, what, outcome: "passed", note: notes.join("; ") });
    console.log("   passed");
  } catch (error) {
    const skipped = (error as { [SKIP]?: string })?.[SKIP];
    if (skipped !== undefined) {
      outcomes.push({ n, what, outcome: "skipped", note: skipped });
      console.log(`   skipped: ${skipped}`);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      outcomes.push({ n, what, outcome: "failed", note: [...notes, message].join("; ") });
      console.log(`   FAILED: ${message}`);
      await recover();
    }
  }
}

// ---- The stand-in GitHub, and the products' repositories

const work = (name: string) => `/root/work/${name}`;
const probeSource = (version: string, mode = "normal") => readFileSync("/e2e/probe.js", "utf8").replace("__VERSION__", version).replace("__MODE__", mode);

function makeRepo(name: string) {
  rmSync(work(name), { recursive: true, force: true });
  run("rm", ["-rf", `/home/git/example/${name}.git`]);
  sh("runuser", ["-u", "git", "--", "git", "init", "-q", "--bare", "-b", "main", `/home/git/example/${name}.git`]);
  sh("git", ["clone", "-q", `/home/git/example/${name}.git`, work(name)]);
  sh("git", ["config", "user.email", "e2e@example.org"], { cwd: work(name) });
  sh("git", ["config", "user.name", "E2E"], { cwd: work(name) });
  sh("git", ["checkout", "-q", "-b", "main"], { cwd: work(name) });
}

/** The package.json every probe version has, and its lockfile (no dependencies, so no network). */
function basePackage(name: string, extra: Record<string, unknown> = {}) {
  writeFileSync(`${work(name)}/package.json`, JSON.stringify({ name, version: "1.0.0", private: true, type: "module", ...extra }, null, 2));
  rmSync(`${work(name)}/package-lock.json`, { force: true });
  sh("npm", ["install", "--package-lock-only", "--ignore-scripts", "--silent"], { cwd: work(name) });
}

/** Commits whatever is in the working copy and pushes it to main, returning the commit. */
function push(name: string, message: string): string {
  sh("git", ["add", "-A"], { cwd: work(name) });
  sh("git", ["commit", "-q", "--allow-empty", "-m", message], { cwd: work(name) });
  sh("git", ["push", "-q", "-f", "origin", "main"], { cwd: work(name) });
  return sh("git", ["rev-parse", "HEAD"], { cwd: work(name) }).trim();
}

/** A new version of a probe product, pushed but not yet deployed. */
let counter = 0;
function version(name: string, mode = "normal"): { sha: string; label: string } {
  counter += 1;
  const label = `${name} v${counter}`;
  writeFileSync(`${work(name)}/server.js`, probeSource(label, mode));
  return { sha: push(name, label), label };
}

// ---- Webhook messages

type Run = {
  path: string;
  event: string;
  head_branch: string;
  conclusion: string | null;
  head_sha: string;
  head_repository: { full_name: string };
};
type Body = { action: string; repository: { full_name: string }; workflow_run: Run; note?: string; padding?: string };
type Message = { path: string; body: string; headers: Record<string, string> };

const secrets: Record<string, string> = {};
const sign = (body: string, secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

/** A webhook message as GitHub sends it when CI passes on main, changed by `change`, signed with `secret`. */
function message(name: string, sha: string, options: { secret?: string; change?: (body: Body) => void; event?: string } = {}): Message {
  const body: Body = {
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
  };
  options.change?.(body);
  const text = JSON.stringify(body);
  return {
    path: `/deploy/${name}`,
    body: text,
    headers: {
      "content-type": "application/json",
      "x-github-event": options.event ?? "workflow_run",
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": sign(text, options.secret ?? secrets[name] ?? ""),
    },
  };
}

type Answer = { status: number; headers: string[]; body: string };
/** Sends a message to the listener, answering with everything that came back. */
const send = (m: Message): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: 9327, method: "POST", path: m.path, headers: m.headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.rawHeaders, body }));
    });
    req.on("error", reject);
    req.end(m.body);
  });

/** Waits until no deploy is waiting or running. */
async function settled() {
  await sleep(1500);
  for (let i = 0; i < 1200; i++) {
    const waiting = existsSync(REQUESTS) ? readdirSync(REQUESTS).length : 0;
    const state = run("systemctl", ["is-active", DEPLOY]).out.trim();
    if (!waiting && state !== "activating") return;
    await sleep(500);
  }
  throw new Error("the deploy never finished");
}

// ---- The products

const productPort = (name: string): number => JSON.parse(readFileSync(`/etc/modest-deploy/products/${name}.json`, "utf8")).port;
const answer = async (name: string, path = "/") => {
  try {
    return await (await fetch(`http://127.0.0.1:${productPort(name)}${path}`, { signal: AbortSignal.timeout(10000) })).text();
  } catch {
    return "(nothing)";
  }
};
const mainPid = (name: string) => run("systemctl", ["show", "-p", "MainPID", "--value", `modest-deploy-${name}.service`]).out.trim();
const uid = (user: string) => Number(sh("id", ["-u", user]).trim());

type Tried = { result: string; value?: unknown };
type Action = Record<string, unknown> & { op: string };
async function tryAs(name: string, actions: Action[]): Promise<Tried[]> {
  const response = await fetch(`http://127.0.0.1:${productPort(name)}/try`, { method: "POST", body: JSON.stringify(actions) });
  return JSON.parse(await response.text());
}
const tryOne = async (name: string, action: Action) => (await tryAs(name, [action]))[0] ?? { result: "no answer" };

/** Deploys a pushed version through a signed message, and checks it's what answers. */
async function deploy(name: string, v: { sha: string; label: string }) {
  await send(message(name, v.sha));
  await settled();
  assert.equal(await answer(name), v.label, `${v.label} should be live`);
}

/** Pushes a version, sends its message, and says whether it went live, and what's live. */
async function attempt(name: string, mode: string, before: string) {
  const v = version(name, mode);
  await send(message(name, v.sha));
  await settled();
  const live = await answer(name);
  return { v, live, stayed: live === before };
}

// ---- Markers: what a script that mustn't run leaves behind, if it does

const marks: string[] = [];
const markServer = createServer((socket) => {
  let text = "";
  socket.on("data", (chunk) => {
    text += chunk;
  });
  socket.on("end", () => marks.push(text.trim()));
  socket.on("error", () => {});
}).listen(47011, "127.0.0.1");
const MARK = "/usr/local/bin/e2e-mark";
writeFileSync(
  MARK,
  `#!/bin/sh
# Leaves a trace that something ran, wherever it can: files, and a line to checks.ts.
label="$1"
touch "/var/e2e-markers/$label" "/tmp/e2e-marker-$label" "$HOME/e2e-marker-$label" "./e2e-marker-$label" 2>/dev/null
bash -c "echo $label > /dev/tcp/127.0.0.1/47011" 2>/dev/null
exit 0
`,
);
chmodSync(MARK, 0o755);
writeFileSync("/usr/local/bin/e2e-evil-git", `#!/bin/sh\n${MARK} npmrc-git\nexec /usr/bin/git "$@"\n`);
writeFileSync("/usr/local/bin/e2e-evil-shell", `#!/bin/sh\n${MARK} npmrc-script-shell\nexec /bin/sh "$@"\n`);
chmodSync("/usr/local/bin/e2e-evil-git", 0o755);
chmodSync("/usr/local/bin/e2e-evil-shell", 0o755);
mkdirSync("/var/e2e-markers", { recursive: true });
chmodSync("/var/e2e-markers", 0o1777);

const clearMarkers = () => {
  marks.length = 0;
  run("sh", ["-c", "rm -f /var/e2e-markers/*; find / -xdev -name 'e2e-marker-*' -not -path '/proc/*' -delete"]);
};
const markers = async () => {
  await sleep(500);
  const files = run("sh", ["-c", "ls /var/e2e-markers; find / -xdev -name 'e2e-marker-*' -not -path '/proc/*'"]).out.trim();
  return [...marks, ...files.split("\n").filter(Boolean)];
};

/**
 * GitHub's real host keys are fetched at install (and add); the stand-in GitHub is this
 * server's own sshd, so, as inside.ts does, its key takes their place afterwards.
 */
function pinStandIn() {
  const hostKey = readFileSync("/etc/ssh/ssh_host_ed25519_key.pub", "utf8").split(" ").slice(0, 2).join(" ");
  writeFileSync("/etc/modest-deploy/keys/known_hosts", `github.com ${hostKey}\n`);
}

// ---- Setup: two probe products, alpha and beta, live

console.log("== setup: products alpha and beta, from local repositories");
const added: Record<string, { deployKey: string; secret: string }> = {};
for (const name of ["alpha", "beta"]) {
  const extra = name === "alpha" ? ["--redirect", "www.alpha.example.org"] : [];
  const out = sh("modest-deploy", ["add", name, "--domain", `${name}.example.org`, "--repo", `example/${name}`, ...extra, "--json"]);
  const result = JSON.parse(out.trim().split("\n").at(-1) ?? "{}");
  added[name] = result;
  secrets[name] = result.secret;
  writeFileSync("/home/git/.ssh/authorized_keys", `${readFileSync("/home/git/.ssh/authorized_keys", "utf8")}${result.deployKey}\n`);
  makeRepo(name);
  basePackage(name);
}
pinStandIn();
const live: Record<string, { sha: string; label: string }> = {};
for (const name of ["alpha", "beta"]) {
  live[name] = version(name);
  await deploy(name, live[name]);
}
console.log("   alpha and beta are live");
const alphaPort = productPort("alpha");
const betaPort = productPort("beta");

/** After a check fails partway, puts alpha back as it was: a clean working copy, an ordinary version live. */
async function recover() {
  try {
    if (!existsSync(work("alpha"))) return;
    for (const entry of readdirSync(work("alpha"))) if (entry !== ".git") rmSync(`${work("alpha")}/${entry}`, { recursive: true, force: true });
    sh("git", ["rm", "-rq", "--cached", "--ignore-unmatch", "."], { cwd: work("alpha") });
    basePackage("alpha");
    pinStandIn();
    await refresh();
  } catch (error) {
    console.log(`   (couldn't put alpha back: ${error instanceof Error ? error.message : error})`);
  }
}

/** Deploys a fresh, ordinary version of alpha, making it the one that's live. */
async function refresh(name = "alpha") {
  const v = version(name);
  await deploy(name, v);
  live[name] = v;
  return v;
}
const isLive = async (name = "alpha") => (await answer(name)) === live[name]?.label;

// Check 11 runs alongside the others, as a slow sender would.
const slowBody = (async () => {
  const started = Date.now();
  const socket = connect(9327, "127.0.0.1");
  socket.on("error", () => {});
  const closed = new Promise<number>((resolve) => socket.on("close", () => resolve(Date.now() - started)));
  socket.write("POST /deploy/alpha HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n");
  const drip = setInterval(() => socket.writable && socket.write("x"), 1000);
  await sleep(3000);
  const meanwhile = await send(message("nosuch", "0".repeat(40), { secret: "wrong" })).catch(() => ({ status: 0 }));
  const took = await Promise.race([closed, sleep(330000).then(() => -1)]);
  clearInterval(drip);
  socket.destroy();
  return { took, meanwhile: meanwhile.status };
})();

// ---- A forged deploy message, and one that isn't a passed CI run on main

{
  const pending = version("alpha");
  const before = mainPid("alpha");

  await check(2, "no signature, an empty one, a wrong-length one, or a SHA-1 one: refused, no deploy", async () => {
    const good = message("alpha", pending.sha);
    const sha1 = `sha1=${createHmac("sha1", secrets.alpha ?? "")
      .update(good.body)
      .digest("hex")}`;
    const variants: Record<string, Record<string, string>> = {
      "no signature": {},
      "an empty one": { "x-hub-signature-256": "" },
      "sha256= and nothing": { "x-hub-signature-256": "sha256=" },
      "a wrong length": { "x-hub-signature-256": (good.headers["x-hub-signature-256"] ?? "").slice(0, 40) },
      "SHA-1, as x-hub-signature": { "x-hub-signature": sha1 },
      "SHA-1, in the SHA-256 header": { "x-hub-signature-256": sha1 },
    };
    for (const [what, signature] of Object.entries(variants)) {
      const headers = { ...good.headers };
      delete headers["x-hub-signature-256"];
      const answered = await send({ ...good, headers: { ...headers, ...signature } });
      note(`${what}: ${answered.status}`);
      assert.ok(answered.status >= 400, `${what} answered ${answered.status}`);
    }
    await settled();
    assert.ok(await isLive(), "nothing deployed");
  });

  await check(1, "one byte of a signed body changed, the signature kept: nothing deploys", async () => {
    const good = message("alpha", pending.sha, { change: (b) => (b.note = "a") });
    const changed = { ...good, body: good.body.replace('"note":"a"', '"note":"b"') };
    assert.notEqual(changed.body, good.body);
    const answered = await send(changed);
    note(`answered ${answered.status}`);
    assert.ok(answered.status >= 400);
    await settled();
    assert.ok(await isLive(), "nothing deployed");
  });

  await check(3, "alpha's message signed with beta's secret, to alpha's path: refused", async () => {
    const answered = await send(message("alpha", pending.sha, { secret: secrets.beta ?? "" }));
    note(`answered ${answered.status}`);
    assert.ok(answered.status >= 400);
    await settled();
    assert.ok(await isLive(), "nothing deployed");
  });

  await check(4, "malformed JSON and valid JSON, both wrongly signed: the same answer, and no JSON error logged", async () => {
    const since = now();
    const valid = message("alpha", pending.sha, { secret: "wrong" });
    const malformed = { ...valid, body: "{not json", headers: { ...valid.headers, "x-hub-signature-256": sign("{not json", "wrong") } };
    const a = await send(valid);
    const b = await send(malformed);
    assert.equal(a.status, b.status);
    assert.equal(a.body, b.body);
    const logged = await journal("modest-deploy-listener.service", since);
    assert.doesNotMatch(logged, /JSON|SyntaxError|Unexpected token/, "the listener read the body as JSON before checking it");
    note(`both ${a.status}`);
  });

  await check(5, "correctly signed messages for anything but a passed CI run on main: none deploys", async () => {
    const cases: Record<string, { change?: (b: Body) => void; event?: string }> = {
      "a push event": { event: "push" },
      "conclusion failure": { change: (b) => (b.workflow_run.conclusion = "failure") },
      "conclusion null": { change: (b) => (b.workflow_run.conclusion = null) },
      "action requested": { change: (b) => (b.action = "requested") },
      "action in_progress": { change: (b) => (b.action = "in_progress") },
      "head branch dev": { change: (b) => (b.workflow_run.head_branch = "dev") },
      "another workflow": { change: (b) => (b.workflow_run.path = ".github/workflows/release.yml") },
      "another repository": { change: (b) => (b.repository.full_name = "example/beta") },
      "another head repository (a fork)": { change: (b) => (b.workflow_run.head_repository.full_name = "fork/alpha") },
      "event pull_request": { change: (b) => (b.workflow_run.event = "pull_request") },
    };
    for (const [what, options] of Object.entries(cases)) {
      const answered = await send(message("alpha", pending.sha, options));
      await settled();
      const stayed = await isLive();
      note(`${what}: ${answered.status}${stayed ? "" : ", DEPLOYED"}`);
      assert.ok(stayed, `${what} deployed`);
    }
    assert.equal(mainPid("alpha"), before, "alpha wasn't restarted");
  });

  await check(12, "a product that doesn't exist gets the same answer as a wrong signature", async () => {
    const wrong = message("alpha", pending.sha, { secret: "wrong" });
    const a = await send(wrong);
    const b = await send({ ...wrong, path: "/deploy/nosuch" });
    const strip = (headers: string[]) => headers.flatMap((h, i) => (i % 2 === 0 && h.toLowerCase() !== "date" ? [`${h}: ${headers[i + 1]}`] : []));
    assert.equal(a.status, b.status);
    assert.deepEqual(strip(a.headers), strip(b.headers));
    assert.equal(a.body, b.body);
    note(`both ${a.status} ${JSON.stringify(a.body)}`);
  });

  await check(13, "a head_sha, repository, or branch that's anything but what it should be: none deploys, nothing runs", async () => {
    rmSync("/tmp/e2e-stray", { recursive: true, force: true });
    const shas = [
      pending.sha.slice(0, 39),
      `${pending.sha}0`,
      pending.sha.toUpperCase(),
      "$(touch /tmp/e2e-stray-sha)",
      "--upload-pack=touch /tmp/e2e-stray-upload",
      `${pending.sha.slice(0, 30)};touch /tmp/e2e-stray`,
    ];
    for (const sha of shas) {
      const answered = await send(message("alpha", sha));
      note(`head_sha ${JSON.stringify(sha.slice(0, 44))}: ${answered.status}`);
    }
    await send(message("alpha", pending.sha, { change: (b) => (b.repository.full_name = "example/alpha;touch /tmp/e2e-stray-repo") }));
    await send(message("alpha", pending.sha, { change: (b) => (b.workflow_run.head_branch = "main$(touch /tmp/e2e-stray-branch)") }));
    await settled();
    assert.ok(await isLive(), "nothing deployed");
    const stray = run("sh", ["-c", "find / -xdev -name 'e2e-stray*' -not -path '/proc/*'"]).out.trim();
    assert.equal(stray, "", "a file appeared");
  });

  await check(10, "a signed body over 1MB is refused, and one just under is handled", async () => {
    const big = message("alpha", pending.sha, { change: (b) => (b.padding = "x".repeat(1048577)) });
    const answered = await send(big).catch((error: Error) => ({ status: 0, headers: [], body: error.message }));
    note(`${big.body.length} bytes: ${answered.status}`);
    assert.ok(answered.status === 0 || answered.status >= 400);
    await settled();
    assert.ok(await isLive(), "the oversized message deployed");
    const under = message("alpha", pending.sha, { change: (b) => (b.padding = "x".repeat(999000)) });
    const handled = await send(under);
    note(`${under.body.length} bytes: ${handled.status}`);
    await settled();
    assert.equal(await answer("alpha"), pending.label, "the message just under 1MB deployed");
    live.alpha = pending;
  });

  await check(1, "a valid workflow_run body signed with alpha's secret deploys (after all the above)", async () => {
    // The message just under 1MB above deployed it; one more ordinary one confirms.
    const v = version("alpha");
    await deploy("alpha", v);
    live.alpha = v;
  });
}

// ---- An old message sent again, and a captured delivery

await check(6, "commit A deployed, then B: A's signed message again (a new delivery id) leaves B live", async () => {
  const a = live.alpha;
  assert.ok(a);
  const b = await refresh();
  await send(message("alpha", a.sha));
  await settled();
  assert.equal(await answer("alpha"), b.label);
});

await check(7, "a signed message for B while main's tip is C: B isn't deployed", async () => {
  const b = version("alpha");
  const c = version("alpha");
  await send(message("alpha", b.sha));
  await settled();
  const now = await answer("alpha");
  note(`live after B's message: ${now} (C is ${c.label})`);
  assert.notEqual(now, b.label);
  await deploy("alpha", c);
  live.alpha = c;
});

await check(8, "a delivery already acted on, sent again exactly: no second deploy or restart", async () => {
  const v = version("alpha");
  const m = message("alpha", v.sha);
  await send(m);
  await settled();
  assert.equal(await answer("alpha"), v.label);
  live.alpha = v;
  const pid = mainPid("alpha");
  const since = now();
  const again = await send(m);
  await settled();
  note(`sent again: ${again.status}`);
  assert.equal(mainPid("alpha"), pid, "alpha was restarted");
  note(`deploy service, after: ${JSON.stringify((await journal(DEPLOY, since)).trim().slice(0, 300))}`);
});

await check(9, "a commit that failed isn't tried again by a message, only by hand", async () => {
  const before = live.alpha?.label ?? "";
  const d = version("alpha", "crash");
  await send(message("alpha", d.sha));
  await settled();
  assert.equal(await answer("alpha"), before, "the previous version serves again");
  const pid = mainPid("alpha");
  const since = now();
  await send(message("alpha", d.sha));
  await settled();
  const byMessage = await journal(DEPLOY, since);
  assert.equal(mainPid("alpha"), pid, "alpha was restarted by the second message");
  assert.doesNotMatch(byMessage, /didn't answer/, "the failed commit was tried again by a message");
  const byHand = now();
  const out = md("deploy", "alpha");
  await settled();
  const tried = await journal(DEPLOY, byHand);
  note(`by hand: ${out.out.trim().slice(0, 200)}`);
  assert.match(tried, /didn't answer/, "deploy by hand tried it");
  assert.equal(await answer("alpha"), before);
});

// ---- A bad deploy, and what a product must do

await check(26, "a version that crashes, never answers, or answers 500: each time, the previous serves again", async () => {
  const before = live.alpha?.label ?? "";
  for (const mode of ["crash", "silent", "error"]) {
    const result = await attempt("alpha", mode, before);
    note(`${mode}: live is ${result.live}`);
    assert.ok(result.stayed, `${mode}: ${result.live}`);
  }
});

await check(62, "an app with no server.js isn't deployed", async () => {
  const before = live.alpha?.label ?? "";
  rmSync(`${work("alpha")}/server.js`);
  push("alpha", "no server.js");
  const sha = sh("git", ["rev-parse", "HEAD"], { cwd: work("alpha") }).trim();
  await send(message("alpha", sha));
  await settled();
  assert.equal(await answer("alpha"), before);
  await refresh();
});

await check(29, "a version listening on 0.0.0.0, or on ::, doesn't stay live", async () => {
  for (const mode of ["any", "any6"]) {
    const before = live.alpha?.label ?? "";
    const result = await attempt("alpha", mode, before);
    const listening = run("ss", ["-ltnH", `sport = :${alphaPort}`]).out.trim();
    note(`${mode}: live is ${result.live}; listening: ${listening.replace(/\s+/g, " ")}`);
    assert.ok(result.stayed, `${mode} stayed live`);
    for (const line of listening.split("\n").filter(Boolean)) assert.match(line, /127\.0\.0\.1:/, `listening beyond 127.0.0.1: ${line}`);
  }
  // Not a promise the documents settle: 127.0.0.1 and :: at once. Noted, not judged.
  const before = live.alpha?.label ?? "";
  const both = await attempt("alpha", "both", before);
  note(`127.0.0.1 and :: at once (not judged): ${both.stayed ? "switched back" : "stayed live"}`);
  if (!both.stayed) await refresh();
});

await check(61, "the app gets PORT, HOST=127.0.0.1, and DATA_DIR; its port is reached only from this machine", async () => {
  const env = JSON.parse(await answer("alpha", "/env"));
  note(JSON.stringify(env));
  assert.equal(env.PORT, String(alphaPort));
  assert.equal(env.HOST, "127.0.0.1");
  assert.equal(env.DATA_DIR, "/var/lib/modest-deploy/alpha");
  const outside = sh("hostname", ["-I"]).trim().split(/\s+/)[0] ?? "";
  const reached = await fetch(`http://${outside}:${alphaPort}/`, { signal: AbortSignal.timeout(5000) }).then(
    (r) => `answered ${r.status}`,
    (e: Error) => (e.cause as { code?: string })?.code ?? e.message,
  );
  note(`from this server's own outside address ${outside}: ${reached}`);
  assert.doesNotMatch(reached, /answered/);
});

// ---- Install scripts, and a repository's own settings

await check(22, "a dependency's and the product's own install scripts don't run, and the deploy succeeds", async () => {
  mkdirSync(`${work("alpha")}/dep`, { recursive: true });
  const scripts = (who: string) => ({
    preinstall: `${MARK} ${who}-preinstall`,
    install: `${MARK} ${who}-install`,
    postinstall: `${MARK} ${who}-postinstall`,
    prepare: `${MARK} ${who}-prepare`,
  });
  writeFileSync(`${work("alpha")}/dep/package.json`, JSON.stringify({ name: "dep", version: "1.0.0", scripts: scripts("dep") }));
  basePackage("alpha", { dependencies: { dep: "file:./dep" }, scripts: scripts("product") });
  const v = version("alpha");
  clearMarkers();
  await deploy("alpha", v);
  live.alpha = v;
  assert.deepEqual(await markers(), [], "an install script ran");
});

await check(23, "a package.json out of step with its lockfile: the deploy fails, the previous keeps running", async () => {
  const before = live.alpha?.label ?? "";
  const lock = readFileSync(`${work("alpha")}/package-lock.json`, "utf8");
  basePackage("alpha", { dependencies: { dep: "file:./dep", other: "file:./other" } });
  writeFileSync(`${work("alpha")}/package-lock.json`, lock);
  const result = await attempt("alpha", "normal", before);
  assert.ok(result.stayed, `live is ${result.live}`);
  rmSync(`${work("alpha")}/dep`, { recursive: true, force: true });
  basePackage("alpha");
  await refresh();
});

await check(24, "a repository's .npmrc can't choose git, the script shell, scripts on, or the registry", async () => {
  // A git dependency from the stand-in GitHub, which root reaches with its own key to make the lockfile.
  if (!existsSync("/root/.ssh/id_ed25519")) {
    mkdirSync("/root/.ssh", { recursive: true });
    sh("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", "/root/.ssh/id_ed25519"]);
    writeFileSync("/root/.ssh/config", "Host github.com\n  IdentityFile /root/.ssh/id_ed25519\n  StrictHostKeyChecking accept-new\n");
    writeFileSync(
      "/home/git/.ssh/authorized_keys",
      `${readFileSync("/home/git/.ssh/authorized_keys", "utf8")}${readFileSync("/root/.ssh/id_ed25519.pub", "utf8")}`,
    );
  }
  // npm asks for git@github.com/example/..., an absolute path, where GitHub's own answers.
  if (!existsSync("/example")) symlinkSync("/home/git/example", "/example");
  makeRepo("gitdep");
  writeFileSync(
    `${work("gitdep")}/package.json`,
    JSON.stringify({ name: "gitdep", version: "1.0.0", scripts: { prepare: `${MARK} gitdep-prepare`, postinstall: `${MARK} gitdep-postinstall` } }),
  );
  writeFileSync(`${work("gitdep")}/index.js`, "export default 1;\n");
  push("gitdep", "gitdep");
  const npmrc = [
    "git=/usr/local/bin/e2e-evil-git",
    "script-shell=/usr/local/bin/e2e-evil-shell",
    "ignore-scripts=false",
    "registry=http://127.0.0.1:9/",
    "",
  ].join("\n");

  // First with a dependency from npm itself, which can only install if the registry setting is ignored.
  basePackage("alpha", { dependencies: { "modest-auth": "0.3.0" }, scripts: { postinstall: `${MARK} product-postinstall` } });
  writeFileSync(`${work("alpha")}/.npmrc`, npmrc);
  const registry = version("alpha");
  clearMarkers();
  await send(message("alpha", registry.sha));
  await settled();
  const viaRegistry = await answer("alpha");
  note(`with a registry dependency: live is ${viaRegistry}`);
  assert.deepEqual(await markers(), [], "something the .npmrc named ran");
  assert.equal(viaRegistry, registry.label, "the deploy failed: the .npmrc's registry was used");
  live.alpha = registry;

  // Then with a git dependency, which npm fetches with whatever git it's told to.
  rmSync(`${work("alpha")}/.npmrc`);
  basePackage("alpha", { dependencies: { gitdep: "git+ssh://git@github.com/example/gitdep.git" } });
  writeFileSync(`${work("alpha")}/.npmrc`, npmrc);
  const viaGit = version("alpha");
  clearMarkers();
  await send(message("alpha", viaGit.sha));
  await settled();
  const liveNow = await answer("alpha");
  note(`with a git dependency: ${liveNow === viaGit.label ? "deployed" : `not deployed (live is ${liveNow})`}`);
  const found = await markers();
  assert.deepEqual(found, [], "something the .npmrc or the git dependency named ran");
  if (liveNow === viaGit.label) live.alpha = viaGit;
  rmSync(`${work("alpha")}/.npmrc`);
  basePackage("alpha");
  await refresh();
});

await check(25, "a .gitattributes filter, and a .gitmodules with an odd URL: nothing they name runs", async () => {
  writeFileSync(`${work("alpha")}/.gitattributes`, "* filter=e2e diff=e2e merge=e2e\n");
  writeFileSync(
    `${work("alpha")}/.gitmodules`,
    `[submodule "sub"]\n\tpath = sub\n\turl = ext::${MARK} gitmodules-ext\n[submodule "opt"]\n\tpath = opt\n\turl = --upload-pack=${MARK}\n`,
  );
  // Submodule entries (gitlinks) with nothing checked out, so committed by hand rather than by push's add -A.
  const head = sh("git", ["rev-parse", "HEAD"], { cwd: work("alpha") }).trim();
  counter += 1;
  const v = { label: `alpha v${counter}`, sha: "" };
  writeFileSync(`${work("alpha")}/server.js`, probeSource(v.label));
  sh("git", ["add", "server.js", ".gitattributes", ".gitmodules"], { cwd: work("alpha") });
  sh("git", ["update-index", "--add", "--cacheinfo", `160000,${head},sub`], { cwd: work("alpha") });
  sh("git", ["update-index", "--add", "--cacheinfo", `160000,${head},opt`], { cwd: work("alpha") });
  sh("git", ["commit", "-q", "-m", v.label], { cwd: work("alpha") });
  sh("git", ["push", "-q", "-f", "origin", "main"], { cwd: work("alpha") });
  v.sha = sh("git", ["rev-parse", "HEAD"], { cwd: work("alpha") }).trim();
  clearMarkers();
  await send(message("alpha", v.sha));
  await settled();
  const now = await answer("alpha");
  note(now === v.label ? "deployed" : `not deployed (live is ${now})`);
  assert.deepEqual(await markers(), [], "something they named ran");
  sh("git", ["rm", "-q", "--cached", "sub", "opt"], { cwd: work("alpha") });
  rmSync(`${work("alpha")}/.gitattributes`);
  rmSync(`${work("alpha")}/.gitmodules`);
  await refresh();
});

// ---- A release too large, or tricking root

await check(36, "a release over 1GB, and one with 200,001 files: both refused, with no partial copy left", async () => {
  // The releases kept: a refused one mustn't leave one of its own (a record of the failure is fine).
  const listing = () => run("sh", ["-c", "find /srv/modest-deploy/alpha/releases -maxdepth 1 | sort"]).out;
  const usage = () => Number(run("du", ["-sxm", "/srv/modest-deploy/alpha"]).out.split(/\s/)[0]);
  const before = live.alpha?.label ?? "";
  const shape = listing();
  const size = usage();

  // Zeros: small in git, but 1.1GB (over 10^9 and over 2^30 bytes) once checked out.
  writeFileSync(`${work("alpha")}/big.bin`, "");
  truncateSync(`${work("alpha")}/big.bin`, 1_100_000_000);
  const big = await attempt("alpha", "normal", before);
  note(`over 1GB: live is ${big.live}; release folder grew by ${usage() - size}MB`);
  assert.ok(big.stayed, "the release over 1GB went live");
  assert.equal(listing(), shape, "a partial copy was left");
  assert.ok(usage() - size < 100, "a partial copy was left");
  rmSync(`${work("alpha")}/big.bin`);

  for (let d = 0; d < 201; d++) {
    mkdirSync(`${work("alpha")}/many/${d}`, { recursive: true });
    for (let f = 0; f < 1000 && d * 1000 + f < 200001; f++) writeFileSync(`${work("alpha")}/many/${d}/${f}`, "");
  }
  const many = await attempt("alpha", "normal", before);
  note(`200,001 files: live is ${many.live}`);
  assert.ok(many.stayed, "the release with 200,001 files went live");
  assert.equal(listing(), shape, "a partial copy was left");
  rmSync(`${work("alpha")}/many`, { recursive: true });
  await refresh();
});

await check(37, "on a small filesystem, a release that would leave under 1GB free: refused", async () => {
  // Alpha's releases, as they are, moved onto a filesystem of their own with under 1GB to spare.
  const releases = "/srv/modest-deploy/alpha/releases";
  const small = "/mnt/e2e-small";
  const before = live.alpha?.label ?? "";
  const used = Number(run("du", ["-sxm", releases]).out.split(/\s/)[0]);
  const [mode, uid, gid] = run("stat", ["-c", "%a %u %g", releases]).out.trim().split(" ");
  mkdirSync(small, { recursive: true });
  sh("mount", ["-t", "tmpfs", "-o", `size=${used + 900}m,mode=${mode},uid=${uid},gid=${gid}`, "tmpfs", small]);
  const since = now();
  try {
    sh("cp", ["-a", `${releases}/.`, `${small}/`]);
    sh("mount", ["--bind", small, releases]);
    note(`free for alpha's releases: ${run("df", ["-m", "--output=avail", releases]).out.trim().split("\n").at(-1)?.trim()}MB`);
    const tried = await attempt("alpha", "normal", before);
    note(`live is ${tried.live}`);
    assert.ok(tried.stayed, "a release went live leaving under 1GB free");
    assert.match(await journal(DEPLOY, since), /keep 1GB free|less than 1GB free/, "refused, but not for the room it needed");
  } finally {
    run("umount", [releases]);
    run("umount", [small]);
  }
  // The same version, with room to spare, goes live: it was the room that stopped it.
  await refresh();
});

await check(38, "package.json as a link to /etc/shadow, or 50MB: refused, and root's output never holds the target", async () => {
  const before = live.alpha?.label ?? "";
  const shadow = readFileSync("/etc/shadow", "utf8").split("\n")[0] ?? "";
  const original = readFileSync(`${work("alpha")}/package.json`, "utf8");
  const since = now();
  rmSync(`${work("alpha")}/package.json`);
  symlinkSync("/etc/shadow", `${work("alpha")}/package.json`);
  const linked = await attempt("alpha", "normal", before);
  note(`a link: live is ${linked.live}`);
  assert.ok(linked.stayed, "a release whose package.json is a link went live");
  rmSync(`${work("alpha")}/package.json`);
  writeFileSync(`${work("alpha")}/package.json`, original.replace("{", `{${" ".repeat(50 * 1024 * 1024)}`));
  const large = await attempt("alpha", "normal", before);
  note(`50MB: live is ${large.live}`);
  assert.ok(large.stayed, "a release with a 50MB package.json went live");
  const logged = await journal(DEPLOY, since);
  assert.ok(!logged.includes(shadow), "the deploy's output holds /etc/shadow");
  writeFileSync(`${work("alpha")}/package.json`, original);
  await refresh();
});

await check(60, "deploy by hand: main's tip, with no CI message at all", async () => {
  const v = version("alpha");
  const out = md("deploy", "alpha");
  assert.equal(out.code, 0, out.out);
  await settled();
  assert.equal(await answer("alpha"), v.label);
  live.alpha = v;
});

// ---- A server pretending to be GitHub

await check(47, "github.com answering with another host key: the fetch fails, and known_hosts is unchanged", async () => {
  const path = "/etc/modest-deploy/keys/known_hosts";
  const kept = readFileSync(path);
  rmSync("/tmp/e2e-other", { force: true });
  sh("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", "/tmp/e2e-other"]);
  const other = `github.com ${readFileSync("/tmp/e2e-other.pub", "utf8").split(" ").slice(0, 2).join(" ")}\n`;
  writeFileSync(path, other);
  try {
    const before = live.alpha?.label ?? "";
    const result = await attempt("alpha", "normal", before);
    assert.ok(result.stayed, "deployed from a server that wasn't GitHub");
    assert.equal(readFileSync(path, "utf8"), other, "known_hosts changed");
  } finally {
    writeFileSync(path, kept);
  }
  await refresh();
});

// ---- A burst, and the deploy queue

await check(53, "50 valid requests in a second: the deploy service never hits its start limit, and main's tip ends up live", async () => {
  const v = version("alpha");
  const sent = [];
  for (let i = 0; i < 50; i++) {
    sent.push(send(message("alpha", v.sha)));
    await sleep(20);
  }
  const statuses = (await Promise.all(sent)).map((a) => a.status);
  note(`answers: ${[...new Set(statuses)].join(", ")}`);
  await settled();
  const result = run("systemctl", ["show", "-p", "Result", "--value", DEPLOY]).out.trim();
  const path = run("systemctl", ["is-active", "modest-deploy-deploy.path"]).out.trim();
  note(`deploy service result ${result}; path unit ${path}`);
  assert.notEqual(result, "start-limit-hit");
  assert.equal(path, "active");
  assert.equal(await answer("alpha"), v.label);
  live.alpha = v;
});

/** Holds the deploy service back while files are put in the queue, then lets it run. */
async function withQueueHeld(fill: () => void) {
  sh("systemctl", ["stop", "modest-deploy-deploy.path"]);
  try {
    fill();
  } finally {
    sh("systemctl", ["start", "modest-deploy-deploy.path"]);
  }
  for (let i = 0; i < 120 && readdirSync(REQUESTS).length; i++) await sleep(500);
  await settled().catch(() => {});
}

await check(16, "request files naming an unknown product, or with a bad commit: the deploy service starts and does nothing", async () => {
  const pending = version("alpha");
  // What a real request looks like, as the listener writes it.
  sh("systemctl", ["stop", "modest-deploy-deploy.path"]);
  let file = "";
  let content = "";
  let owner = { uid: 0, gid: 0, mode: 0o600 };
  try {
    await send(message("alpha", pending.sha));
    await sleep(1000);
    file = readdirSync(REQUESTS)[0] ?? "";
    assert.ok(file, "the listener wrote a request");
    content = readFileSync(`${REQUESTS}/${file}`, "utf8");
    const stat = statSync(`${REQUESTS}/${file}`);
    owner = { uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 };
    rmSync(`${REQUESTS}/${file}`);
  } finally {
    sh("systemctl", ["start", "modest-deploy-deploy.path"]);
  }
  note(`a request: ${file.replaceAll(pending.sha, "<commit>")} holding ${JSON.stringify(content.replaceAll(pending.sha, "<commit>"))}`);
  const pid = mainPid("alpha");
  const since = now();
  await withQueueHeld(() => {
    const variants = [
      [file.replaceAll("alpha", "nosuch"), content.replaceAll("alpha", "nosuch")],
      [file.replaceAll(pending.sha, "z".repeat(40)), content.replaceAll(pending.sha, "z".repeat(40))],
      [file.replaceAll(pending.sha, pending.sha.slice(0, 39)), content.replaceAll(pending.sha, pending.sha.slice(0, 39))],
    ];
    for (const [name = "", text = ""] of variants) {
      writeFileSync(`${REQUESTS}/${name}`, text);
      chownSync(`${REQUESTS}/${name}`, owner.uid, owner.gid);
      chmodSync(`${REQUESTS}/${name}`, owner.mode);
    }
  });
  const logged = await journal(DEPLOY, since);
  note(`the deploy service said: ${JSON.stringify(logged.trim().slice(0, 400))}`);
  assert.ok(logged.trim() || run("systemctl", ["show", "-p", "ExecMainStartTimestamp", "--value", DEPLOY]).out.trim(), "the deploy service ran");
  assert.equal(await answer("alpha"), live.alpha?.label, "a bad request deployed alpha");
  assert.equal(mainPid("alpha"), pid, "alpha was restarted");
  assert.deepEqual(readdirSync(REQUESTS), []);
  await deploy("alpha", pending);
  live.alpha = pending;
});

await check(35, "a FIFO, a link to /etc/shadow, a folder, and a 10MB file in the queue: each removed unread; a valid request after still deploys", async () => {
  await withQueueHeld(() => {
    sh("mkfifo", [`${REQUESTS}/e2e-fifo`]);
    symlinkSync("/etc/shadow", `${REQUESTS}/e2e-link`);
    mkdirSync(`${REQUESTS}/e2e-folder`);
    writeFileSync(`${REQUESTS}/e2e-large`, "x".repeat(10 * 1024 * 1024));
  });
  const left = readdirSync(REQUESTS);
  note(`left in the queue: ${JSON.stringify(left)}`);
  assert.deepEqual(left, []);
  await refresh();
});

// ---- The build user

await check(32, "a process left running as the build user: none remains after the deploy", async () => {
  sh("runuser", ["-u", "mb-alpha", "--", "sh", "-c", "nohup sleep 100000 >/dev/null 2>&1 &"]);
  assert.notEqual(run("pgrep", ["-u", "mb-alpha"]).out.trim(), "", "the planted process started");
  await refresh();
  const left = run("pgrep", ["-u", "mb-alpha", "-a"]).out.trim();
  assert.equal(left, "", `still running: ${left}`);
});

await check(33, "files planted in the build user's home, a hook, core.fsmonitor or core.sshCommand: none runs, and the home is empty", async () => {
  const home = sh("getent", ["passwd", "mb-alpha"]).split(":")[5] ?? "";
  const source = "/srv/modest-deploy/alpha/source.git";
  assert.ok(home && existsSync(source), `home ${home}, source ${source}`);
  mkdirSync(`${home}/.ssh`, { recursive: true });
  writeFileSync(`${home}/.ssh/config`, `Host *\n  ProxyCommand ${MARK} ssh-config\n  LocalCommand ${MARK} ssh-local\n  PermitLocalCommand yes\n`);
  writeFileSync(`${home}/.gitconfig`, `[core]\n\tfsmonitor = ${MARK} home-fsmonitor\n\tpager = ${MARK} home-pager\n[alias]\n\tfetch = !${MARK} home-alias\n`);
  writeFileSync(`${home}/.npmrc`, "script-shell=/usr/local/bin/e2e-evil-shell\nignore-scripts=false\n");
  writeFileSync(`${home}/.bashrc`, `${MARK} home-bashrc\n`);
  writeFileSync(`${home}/.profile`, `${MARK} home-profile\n`);
  sh("git", ["config", "--file", `${source}/config`, "core.fsmonitor", `${MARK} repo-fsmonitor`]);
  sh("git", ["config", "--file", `${source}/config`, "core.sshCommand", `${MARK} repo-sshcommand`]);
  mkdirSync(`${source}/hooks`, { recursive: true });
  for (const hook of ["reference-transaction", "post-checkout", "post-merge", "pre-auto-gc", "post-rewrite"]) {
    writeFileSync(`${source}/hooks/${hook}`, `#!/bin/sh\n${MARK} hook-${hook}\n`);
    chmodSync(`${source}/hooks/${hook}`, 0o755);
  }
  sh("chown", ["-R", "mb-alpha:", home, source]);
  clearMarkers();
  await refresh();
  assert.deepEqual(await markers(), [], "something planted ran");
  const inHome = readdirSync(home);
  note(`home holds ${JSON.stringify(inHome)}`);
  assert.deepEqual(inHome, [], "the home isn't empty");
  const config = readFileSync(`${source}/config`, "utf8");
  assert.doesNotMatch(config, /e2e-mark/, "the repository copy's settings weren't rewritten");
});

await check(31, "as alpha's build user: beta's deploy key and repository copy can't be read; its own can", async () => {
  const as = (path: string) => run("runuser", ["-u", "mb-alpha", "--", "cat", path]).code;
  assert.notEqual(as("/etc/modest-deploy/keys/beta"), 0, "beta's key");
  assert.notEqual(as("/srv/modest-deploy/beta/source.git/HEAD"), 0, "beta's repository copy");
  assert.equal(as("/etc/modest-deploy/keys/alpha"), 0, "its own key");
  assert.equal(as("/srv/modest-deploy/alpha/source.git/HEAD"), 0, "its own repository copy");
});

// ---- A product reaching another, or the server

await check(17, "alpha can't read beta's environment, data, or code, /root, host keys, deploy keys, webhook secrets, or /etc/shadow", async () => {
  await tryAs("beta", [{ op: "write", path: "/var/lib/modest-deploy/beta/private.txt" }]);
  const paths = [
    "/etc/modest-deploy/env/beta.env",
    "/var/lib/modest-deploy/beta/private.txt",
    "/srv/modest-deploy/beta/current/server.js",
    "/srv/modest-deploy/beta/current/package.json",
    "/root/.ssh/id_ed25519",
    "/root/work/beta/server.js",
    "/etc/ssh/ssh_host_ed25519_key",
    "/etc/modest-deploy/keys/alpha",
    "/etc/modest-deploy/keys/beta",
    "/etc/modest-deploy/secrets/alpha",
    "/etc/modest-deploy/secrets/beta",
    "/etc/shadow",
  ];
  const results = await tryAs(
    "alpha",
    paths.map((path) => ({ op: "read", path })),
  );
  const listed = await tryAs("alpha", [
    { op: "list", path: "/root" },
    { op: "list", path: "/var/lib/modest-deploy/beta" },
    { op: "list", path: "/etc/modest-deploy/secrets" },
  ]);
  const allowed = [...paths, "list /root", "list beta's data", "list the secrets"].filter(
    (_, i) => ([...results, ...listed][i]?.result ?? "allowed") === "allowed",
  );
  note(`read: ${paths.map((p, i) => `${p} ${results[i]?.result}`).join(", ")}`);
  assert.deepEqual(allowed, [], "alpha could read these");
});

await check(18, "alpha can't write its code, /etc, /usr, or beta's data; it can write DATA_DIR; its /tmp and /var/tmp are its own", async () => {
  const code = realpathSync("/srv/modest-deploy/alpha/current");
  const paths = [`${code}/server.js`, `${code}/e2e-new`, "/etc/e2e-probe", "/usr/e2e-probe", "/var/lib/modest-deploy/beta/e2e-probe"];
  const results = await tryAs(
    "alpha",
    paths.map((path) => ({ op: "write", path })),
  );
  note(paths.map((p, i) => `${p} ${results[i]?.result}`).join(", "));
  assert.deepEqual(
    paths.filter((_, i) => results[i]?.result === "allowed"),
    [],
    "alpha could write these",
  );
  assert.equal((await tryOne("alpha", { op: "write", path: "/var/lib/modest-deploy/alpha/e2e-probe" })).result, "allowed", "DATA_DIR");
  // The list says /var/tmp can't be written; the threat model promises a private /tmp, and
  // systemd's private /tmp is /var/tmp's too: so both are checked for being alpha's alone.
  for (const tmp of ["/tmp", "/var/tmp"]) {
    const wrote = await tryOne("alpha", { op: "write", path: `${tmp}/e2e-alpha-tmp` });
    note(`${tmp}: ${wrote.result}`);
    const seen = await tryOne("beta", { op: "read", path: `${tmp}/e2e-alpha-tmp` });
    assert.notEqual(seen.result, "allowed", `beta sees alpha's ${tmp}`);
    assert.equal(existsSync(`${tmp}/e2e-alpha-tmp`), false, `the server's ${tmp} holds alpha's file`);
  }
});

await check(19, "from alpha: none of beta's processes, no sudo or su, and empty capability sets", async () => {
  const betaPid = mainPid("beta");
  const proc = await tryOne("alpha", { op: "list", path: "/proc" });
  const pids = ((proc.value as string[]) ?? []).filter((p) => /^\d+$/.test(p));
  note(`alpha sees ${pids.length} processes`);
  assert.ok(!pids.includes(betaPid), "alpha sees beta's process");
  const direct = await tryOne("alpha", { op: "read", path: `/proc/${betaPid}/environ` });
  assert.notEqual(direct.result, "allowed", "alpha reads beta's environment through /proc");
  const sudo = await tryOne("alpha", { op: "exec", file: "sudo", args: ["-n", "true"] });
  const su = await tryOne("alpha", { op: "exec", file: "su", args: ["-c", "true", "root"] });
  note(`sudo ${sudo.result}, su ${su.result}`);
  assert.notEqual(sudo.result, "allowed");
  assert.notEqual(su.result, "allowed");
  const status = String((await tryOne("alpha", { op: "status" })).value ?? "");
  const caps = Object.fromEntries([...status.matchAll(/^(Cap\w+|NoNewPrivs):\s+(\S+)/gm)].map((m) => [m[1], m[2]]));
  note(JSON.stringify(caps));
  for (const set of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) assert.equal(caps[set], "0000000000000000", set);
  assert.equal(caps.NoNewPrivs, "1");
});

await check(21, "alpha's code is owned by root, readable by alpha's user, and not by beta's user or the build user", async () => {
  const file = `${realpathSync("/srv/modest-deploy/alpha/current")}/server.js`;
  assert.equal(statSync(file).uid, 0);
  const as = (user: string) => run("runuser", ["-u", user, "--", "cat", file]).code;
  assert.equal(as("md-alpha"), 0, "alpha's user");
  assert.notEqual(as("md-beta"), 0, "beta's user");
  assert.notEqual(as("mb-alpha"), 0, "the build user");
});

await check(28, "alpha binding beta's port, 8080 on 0.0.0.0, or UDP fails with EPERM; its own port works", async () => {
  if (!sh("systemctl", ["--version"]).includes("+BPF_FRAMEWORK")) skip("this systemd has no BPF framework, so SocketBindDeny can't hold");
  sh("systemctl", ["stop", "modest-deploy-beta.service"]);
  try {
    const results = await tryAs("alpha", [
      { op: "bind", port: betaPort, host: "127.0.0.1" },
      { op: "bind", port: 8080, host: "0.0.0.0" },
      { op: "bind", port: 5301, host: "127.0.0.1", udp: true },
      { op: "bind", port: 5301, host: "0.0.0.0", udp: true },
      { op: "bind", port: alphaPort, host: "127.0.0.1", udp: true },
      { op: "bind", port: alphaPort, host: "127.0.0.1" },
    ]);
    const what = [
      "beta's port",
      "8080 on 0.0.0.0",
      "UDP 5301 on 127.0.0.1",
      "UDP 5301 on 0.0.0.0",
      "UDP on its own port number",
      "its own port (in use by itself)",
    ];
    note(what.map((w, i) => `${w}: ${results[i]?.result}`).join(", "));
    for (let i = 0; i < 4; i++) assert.equal(results[i]?.result, "EPERM", what[i]);
    assert.notEqual(results[5]?.result, "EPERM", "its own port");
    assert.equal(await answer("alpha"), live.alpha?.label);
  } finally {
    sh("systemctl", ["start", "modest-deploy-beta.service"]);
  }
});

await check(30, "alpha opening a listener beyond 127.0.0.1 at run time: check and the nightly run report it", async () => {
  const held = await tryOne("alpha", { op: "hold", port: alphaPort, host: "::" });
  if (held.result !== "allowed") skip(`alpha couldn't listen on :: (${held.result}), so there's nothing to report`);
  try {
    const listening = run("ss", ["-ltnH", `sport = :${alphaPort}`]).out.replace(/\s+/g, " ");
    note(`listening: ${listening}`);
    const checked = md("check");
    note(`check: exit ${checked.code}; ${JSON.stringify(checked.out.split("\n").filter((l) => l.includes(String(alphaPort))))}`);
    assert.notEqual(checked.code, 0, "check passed with alpha listening on ::");
    const nightly = run("systemctl", ["show", "-p", "Unit", "--value", "modest-deploy-backup.timer"]).out.trim();
    const since = now();
    run("systemctl", ["start", nightly]);
    const said = await journal(nightly, since);
    note(`the nightly run (${nightly}) said: ${JSON.stringify(said.split("\n").filter((l) => /listen|port|outside|alpha/i.test(l)))}`);
    assert.match(said, new RegExp(`${alphaPort}|listen`), "the nightly run didn't say so");
  } finally {
    await tryOne("alpha", { op: "close" });
  }
});

await check(20, "alpha allocating without limit is stopped at its memory limit; beta and the server stay up", async () => {
  const limit = run("systemctl", ["show", "-p", "MemoryMax", "--value", "modest-deploy-alpha.service"]).out.trim();
  note(`MemoryMax ${limit}`);
  assert.notEqual(limit, "infinity", "alpha has no memory limit");
  const since = now();
  const outcome = await fetch(`http://127.0.0.1:${alphaPort}/alloc`, { signal: AbortSignal.timeout(180000) }).then(
    () => "answered",
    (e: Error) => (e.cause as { code?: string })?.code ?? e.name,
  );
  note(`the allocation ended: ${outcome}`);
  assert.equal(await answer("beta"), live.beta?.label, "beta is up");
  const logged = await journal("modest-deploy-alpha.service", since);
  assert.match(logged, /oom|memory/i, "systemd doesn't say it was stopped for memory");
  for (let i = 0; i < 120 && !(await isLive()); i++) await sleep(1000);
  assert.ok(await isLive(), "alpha came back");
});

await check(58, "a product that keeps crashing restarts with growing delays", async () => {
  const props = run("systemctl", ["show", "-p", "Restart,RestartUSec,RestartSteps,RestartMaxDelayUSec", "modest-deploy-alpha.service"]).out.trim();
  note(props.replace(/\n/g, ", "));
  const delays: number[] = [];
  for (let i = 0; i < 5; i++) {
    const pid = mainPid("alpha");
    const killed = Date.now();
    run("kill", ["-9", pid]);
    let next = pid;
    while ((next === pid || next === "0") && Date.now() - killed < 120000) {
      await sleep(100);
      next = mainPid("alpha");
    }
    delays.push((Date.now() - killed) / 1000);
  }
  note(`restarted after ${delays.map((d) => `${d.toFixed(1)}s`).join(", ")}`);
  assert.ok((delays.at(-1) ?? 0) > (delays[0] ?? 0) + 1, "the delays didn't grow");
  for (let i = 0; i < 120 && !(await isLive()); i++) await sleep(1000);
  assert.ok(await isLive(), "alpha came back");
});

// ---- The deploy service, as a unit

await check(39, "the deploy unit has MemoryMax=1G and no devices", async () => {
  const props = run("systemctl", ["show", "-p", "MemoryMax,PrivateDevices,DevicePolicy,DeviceAllow", DEPLOY]).out.trim();
  note(props.replace(/\n/g, ", "));
  assert.match(props, /MemoryMax=1073741824/);
  assert.ok(/PrivateDevices=yes/.test(props) || (/DevicePolicy=closed|DevicePolicy=strict/.test(props) && /DeviceAllow=$/m.test(props)), "devices");
});

// ---- Domains and redirects

await check(56, "add gives a system user, a folder, an environment file (600, for it alone), a unit, and a Caddy site Caddy accepts", async () => {
  sh("id", ["md-alpha"]);
  const folder = statSync("/var/lib/modest-deploy/alpha");
  assert.ok(folder.isDirectory());
  assert.equal(folder.uid, uid("md-alpha"));
  const env = statSync("/etc/modest-deploy/env/alpha.env");
  note(`environment file: mode ${(env.mode & 0o777).toString(8)}, owner ${env.uid} (md-alpha is ${uid("md-alpha")})`);
  assert.equal(env.mode & 0o777, 0o600);
  // "The product's": for alpha alone. systemd reads it as root, so root's, or alpha's, keeps it so.
  assert.ok([0, uid("md-alpha")].includes(env.uid), "owned by someone else");
  assert.notEqual(run("runuser", ["-u", "md-beta", "--", "cat", "/etc/modest-deploy/env/alpha.env"]).code, 0, "beta's user reads it");
  assert.equal(run("systemctl", ["is-enabled", "modest-deploy-alpha.service"]).out.trim(), "enabled");
  assert.match(readFileSync("/etc/modest-deploy/caddy/alpha.caddy", "utf8"), /alpha\.example\.org/);
  const valid = run("caddy", ["validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]);
  assert.equal(valid.code, 0, valid.out.slice(-500));
});

await check(57, "a domain another product uses: refused", async () => {
  for (const domain of ["alpha.example.org", "www.alpha.example.org", "deploy.example.org"]) {
    const out = md("add", "gamma", "--domain", domain, "--repo", "example/gamma");
    note(`${domain}: exit ${out.code}`);
    assert.notEqual(out.code, 0, domain);
    assert.equal(existsSync("/etc/modest-deploy/products/gamma.json"), false, `${domain}: gamma was added`);
  }
});

await check(40, "a redirect that's another product's domain or redirect, the deploy domain, or not a domain: refused", async () => {
  const site = readFileSync("/etc/modest-deploy/caddy/beta.caddy", "utf8");
  for (const redirect of [
    "alpha.example.org",
    "www.alpha.example.org",
    "deploy.example.org",
    "a b",
    "x/../y",
    "*.x",
    "beta.example.org",
    "evil.example.org/x",
    "-x.example.org",
  ]) {
    const out = md("add", "beta", "--domain", "beta.example.org", "--repo", "example/beta", "--redirect", redirect);
    note(`${JSON.stringify(redirect)}: exit ${out.code}`);
    assert.notEqual(out.code, 0, redirect);
    assert.equal(readFileSync("/etc/modest-deploy/caddy/beta.caddy", "utf8"), site, `${redirect} changed beta's site`);
  }
});

await check(42, "more redirects than the maximum: refused", async () => {
  const many = Array.from({ length: 50 }, (_, i) => `r${i}.beta.example.org`).join(",");
  const out = md("add", "beta", "--domain", "beta.example.org", "--repo", "example/beta", "--redirect", many);
  note(`50 redirects: exit ${out.code}`);
  assert.notEqual(out.code, 0);
  for (const count of [2, 3, 5, 10]) {
    const some = Array.from({ length: count }, (_, i) => `r${i}.beta.example.org`).join(",");
    note(`${count}: exit ${md("add", "beta", "--domain", "beta.example.org", "--repo", "example/beta", "--redirect", some).code}`);
  }
  assert.equal(md("add", "beta", "--domain", "beta.example.org", "--repo", "example/beta").code, 0);
});

await check(41, "a redirect domain, with an odd Host, path, or query: always to alpha's own domain, the same path; alpha never sees it", async () => {
  rmSync("/var/lib/modest-deploy/alpha/seen.log", { force: true });
  const curl = (host: string, path: string) =>
    sh("curl", [
      "-sk",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code} %{redirect_url}",
      "--path-as-is",
      "--resolve",
      `${host}:443:127.0.0.1`,
      "-H",
      `Host: ${host}`,
      `https://${host}${path}`,
    ]);
  const paths = [
    "/e2e-redirect",
    "/e2e-redirect/../../etc/passwd",
    "/e2e-redirect?next=https://evil.example.org/",
    "//evil.example.org/e2e-redirect",
    "/e2e-redirect%0d%0aLocation:%20https://evil.example.org/",
  ];
  for (const path of paths) {
    const [status = "", location = ""] = curl("www.alpha.example.org", path).split(" ");
    note(`${path}: ${status} ${location}`);
    assert.match(status, /^30[178]$/, path);
    assert.equal(new URL(location).host, "alpha.example.org", path);
    // The same path, as a browser would ask for it (dot segments resolved, as Caddy does).
    const asked = new URL(`https://www.alpha.example.org${path}`);
    assert.equal(new URL(location).pathname + new URL(location).search, asked.pathname + asked.search, `the same path: ${location}`);
  }
  for (const host of ["WWW.ALPHA.EXAMPLE.ORG", "www.alpha.example.org.", "www.alpha.example.org:443"]) {
    const answered = run("curl", [
      "-sk",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code} %{redirect_url}",
      "--resolve",
      "www.alpha.example.org:443:127.0.0.1",
      "-H",
      `Host: ${host}`,
      "https://www.alpha.example.org/e2e-redirect-host",
    ]).out;
    note(`Host ${host}: ${answered}`);
    const location = answered.split(" ")[1] ?? "";
    if (location) assert.equal(new URL(location).host, "alpha.example.org", host);
  }
  await sleep(500);
  const seen = existsSync("/var/lib/modest-deploy/alpha/seen.log") ? readFileSync("/var/lib/modest-deploy/alpha/seen.log", "utf8") : "";
  assert.doesNotMatch(seen, /e2e-redirect/, "alpha saw a request for its redirect domain");
});

// ---- Backups

const backups = "/var/backups/modest-deploy/alpha";
const filesUnder = (path: string): string[] => (existsSync(path) ? run("find", [path, "-type", "f"]).out.trim().split("\n").filter(Boolean) : []);

await check(48, "alpha's app.db a link to beta's database or /etc/shadow: refused; no copy holds the target", async () => {
  await tryOne("beta", { op: "sqlite", path: "/var/lib/modest-deploy/beta/app.db", value: "e2e-beta-secret" });
  const betaDb = readFileSync("/var/lib/modest-deploy/beta/app.db");
  const shadow = readFileSync("/etc/shadow");
  for (const name of ["app.db", "shadow.db", "other.sqlite"]) await tryOne("alpha", { op: "remove", path: `/var/lib/modest-deploy/alpha/${name}` });
  const links = await tryAs("alpha", [
    { op: "symlink", target: "/var/lib/modest-deploy/beta/app.db", path: "/var/lib/modest-deploy/alpha/app.db" },
    { op: "symlink", target: "/etc/shadow", path: "/var/lib/modest-deploy/alpha/shadow.db" },
    { op: "symlink", target: "/var/lib/modest-deploy/beta/app.db", path: "/var/lib/modest-deploy/alpha/other.sqlite" },
  ]);
  assert.ok(
    links.every((l) => l.result === "allowed"),
    "alpha made its links",
  );
  rmSync(backups, { recursive: true, force: true });
  const out = md("backup");
  note(
    `backup: exit ${out.code}; ${JSON.stringify(
      out.out
        .split("\n")
        .filter((l) => l.includes("alpha"))
        .slice(0, 4),
    )}`,
  );
  for (const file of filesUnder(backups)) {
    const copy = readFileSync(file);
    assert.ok(!copy.equals(betaDb) && !copy.includes(Buffer.from("e2e-beta-secret")), `${file} holds beta's database`);
    assert.ok(!copy.includes(shadow.subarray(0, 40)), `${file} holds /etc/shadow`);
  }
  for (const name of ["app.db", "shadow.db", "other.sqlite"]) await tryOne("alpha", { op: "remove", path: `/var/lib/modest-deploy/alpha/${name}` });
});

const makeDb = (path: string) => tryOne("alpha", { op: "sqlite", path, value: 1 });

await check(49, "backup copies are root's, mode 600 or tighter, and alpha's user can't read them", async () => {
  await makeDb("/var/lib/modest-deploy/alpha/app.db");
  const out = md("backup");
  assert.equal(out.code, 0, out.out.slice(-500));
  const files = filesUnder(backups);
  assert.ok(files.length, "a copy was made");
  for (const file of files) {
    const stat = statSync(file);
    note(`${file}: ${(stat.mode & 0o777).toString(8)} uid ${stat.uid}`);
    assert.equal(stat.uid, 0);
    assert.equal(stat.mode & 0o177, 0);
    assert.notEqual(run("runuser", ["-u", "md-alpha", "--", "cat", file]).code, 0, "alpha's user reads it");
  }
});

await check(50, "a corrupt database: the nightly run fails, with no partial copy under the final name", async () => {
  await tryOne("alpha", {
    op: "exec",
    file: "sh",
    args: ["-c", "printf 'SQLite format 3\\000' > /var/lib/modest-deploy/alpha/bad.db; head -c 8192 /dev/urandom >> /var/lib/modest-deploy/alpha/bad.db"],
  });
  const out = md("backup");
  note(`backup: exit ${out.code}`);
  const copies = filesUnder(backups).filter((f) => f.endsWith("/bad.db"));
  await tryOne("alpha", { op: "remove", path: "/var/lib/modest-deploy/alpha/bad.db" });
  assert.notEqual(out.code, 0, "the run didn't fail");
  assert.deepEqual(copies, [], "a copy under the final name");
});

await check(51, "two backup runs at once: the second waits or refuses, and the copies are whole", async () => {
  const both = await Promise.all(
    [0, 1].map(
      () =>
        new Promise<{ code: number; out: string }>((resolve) => {
          const child = spawn("modest-deploy", ["backup"]);
          let out = "";
          child.stdout.on("data", (c) => {
            out += c;
          });
          child.stderr.on("data", (c) => {
            out += c;
          });
          child.on("close", (code) => resolve({ code: code ?? 1, out }));
        }),
    ),
  );
  note(both.map((b) => `exit ${b.code}: ${JSON.stringify(b.out.trim().split("\n").at(-1))}`).join("; "));
  assert.ok(
    both.some((b) => b.code === 0),
    "neither ran",
  );
  for (const file of filesUnder(backups)) {
    const db = new DatabaseSync(file, { readOnly: true });
    assert.equal((db.prepare("pragma integrity_check").get() as { integrity_check: string }).integrity_check, "ok", file);
    db.close();
  }
  note("too little disk: not tried (it needs a small filesystem of its own)");
});

await check(52, "after 8 nights, 7 copies remain (older nights planted, rather than the clock moved on)", async () => {
  const today = new Date();
  const copy = filesUnder(backups).find((f) => f.endsWith("/app.db"));
  assert.ok(copy, "a copy to plant");
  for (let i = 1; i <= 8; i++) {
    const night = new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10);
    mkdirSync(`${backups}/${night}`, { recursive: true, mode: 0o700 });
    writeFileSync(`${backups}/${night}/app.db`, readFileSync(copy), { mode: 0o600 });
  }
  const out = md("backup");
  assert.equal(out.code, 0, out.out.slice(-500));
  const nights = readdirSync(backups).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n));
  note(`nights kept: ${nights.sort().join(", ")}`);
  assert.equal(nights.length, 7);
  assert.ok(nights.includes(today.toISOString().slice(0, 10)), "tonight's is kept");
});

// ---- An unsafe server

const unsafe: Record<string, { make: () => void | Promise<void>; undo: () => void | Promise<void> }> = {};
{
  const conf = (name: string, text: string) => ({
    make: () => writeFileSync(`/etc/ssh/sshd_config.d/${name}`, text),
    undo: () => rmSync(`/etc/ssh/sshd_config.d/${name}`, { force: true }),
  });
  unsafe["PasswordAuthentication yes"] = conf("00-e2e.conf", "PasswordAuthentication yes\n");
  unsafe["PermitRootLogin yes"] = conf("00-e2e.conf", "PermitRootLogin yes\n");
  unsafe["root allowed in a Match Address block for an outside address"] = conf("99-e2e.conf", "Match Address 203.0.113.0/24\n  PermitRootLogin yes\n");
  const upgrades = "/etc/apt/apt.conf.d/20auto-upgrades";
  const kept = readFileSync(upgrades, "utf8");
  unsafe["unattended-upgrades off"] = {
    make: () => writeFileSync(upgrades, 'APT::Periodic::Update-Package-Lists "0";\nAPT::Periodic::Unattended-Upgrade "0";\n'),
    undo: () => writeFileSync(upgrades, kept),
  };
  const tcp = createServer();
  unsafe["an extra TCP listener"] = {
    make: () => new Promise<void>((resolve) => tcp.listen(8081, "0.0.0.0", () => resolve())),
    undo: () => new Promise<void>((resolve) => tcp.close(() => resolve())),
  };
  const udp = createSocket("udp4");
  unsafe["an extra UDP listener"] = {
    make: () => new Promise<void>((resolve) => udp.bind(5300, "0.0.0.0", () => resolve())),
    undo: () => new Promise<void>((resolve) => udp.close(() => resolve())),
  };
}

const anyway: string[] = [];
await check(45, "each unsafe setting: check fails with the fix, and install and add refuse", async () => {
  assert.equal(md("check").code, 0, "check passes to begin with");
  const failures: string[] = [];
  for (const [what, change] of Object.entries(unsafe)) {
    await change.make();
    try {
      const checked = md("check");
      const install = md("install");
      const add = md("add", "gamma", "--domain", "gamma.example.org", "--repo", "example/gamma");
      const added = existsSync("/etc/modest-deploy/products/gamma.json");
      const said = checked.out.split("\n").filter((l) => /fix|✗|fail|no\b|not\b|listen|password|root|update/i.test(l));
      note(`${what}: check ${checked.code}, install ${install.code}, add ${add.code}; ${JSON.stringify(said.slice(0, 2))}`);
      if (checked.code === 0) failures.push(`${what}: check passed`);
      if (install.code === 0) failures.push(`${what}: install went on`);
      if (add.code === 0 || added) failures.push(`${what}: add went on`);
      if (added) md("remove", "gamma");
      const installed = md("install", "--anyway");
      const addedAnyway = md("add", "gamma", "--domain", "gamma.example.org", "--repo", "example/gamma", "--anyway");
      const goOn = installed.code === 0 && addedAnyway.code === 0;
      const why = goOn
        ? ""
        : ` (install ${installed.code}: ${JSON.stringify(installed.out.trim().split("\n").slice(-3))}; add ${addedAnyway.code}: ${JSON.stringify(addedAnyway.out.trim().split("\n").slice(-3))})`;
      anyway.push(`${what}: ${goOn ? "went on" : "refused"}${why}`);
      if (existsSync("/etc/modest-deploy/products/gamma.json")) md("remove", "gamma");
    } finally {
      await change.undo();
    }
  }
  note("Node 22: not tried (it needs a second Node installed)");
  assert.equal(md("check").code, 0, "check passes again once undone");
  assert.deepEqual(failures, []);
});

await check(46, "the same unsafe settings with --anyway: install and add go on", () => {
  if (!anyway.length) skip("check 45 didn't run its cases");
  for (const line of anyway) note(line);
  assert.ok(
    anyway.every((l) => l.includes(": went on")),
    "refused with --anyway",
  );
});

await check(55, "check fails when modest-deploy isn't readable by the services' users", async () => {
  const mode = statSync("/opt/modest-deploy").mode & 0o777;
  chmodSync("/opt/modest-deploy", 0o700);
  try {
    const checked = md("check");
    note(`check, with /opt/modest-deploy mode 700: exit ${checked.code}`);
    assert.notEqual(checked.code, 0);
  } finally {
    chmodSync("/opt/modest-deploy", mode);
  }
  assert.equal(md("check").code, 0);
});

// ---- Install, again, and logs

await check(
  54,
  "install: the listener, Caddy's sites folder, and the backup timer present and enabled; install again rewrites every unit, nothing duplicated",
  async () => {
    for (const unit of ["modest-deploy-listener.service", "modest-deploy-deploy.path", "modest-deploy-backup.timer"]) {
      assert.equal(run("systemctl", ["is-enabled", unit]).out.trim(), "enabled", unit);
    }
    assert.ok(statSync("/etc/modest-deploy/caddy").isDirectory());
    const units = () => readdirSync("/etc/systemd/system").filter((u) => u.startsWith("modest-deploy"));
    const before = units().sort();
    const times = Object.fromEntries(before.map((u) => [u, lstatSync(`/etc/systemd/system/${u}`).mtimeMs]));
    const caddyfile = readFileSync("/etc/caddy/Caddyfile", "utf8");
    await sleep(1100);
    const out = md("install");
    assert.equal(out.code, 0, out.out.slice(-500));
    const after = units().sort();
    assert.deepEqual(after, before, "the units changed");
    const untouched = before.filter((u) => lstatSync(`/etc/systemd/system/${u}`).mtimeMs === times[u] && !lstatSync(`/etc/systemd/system/${u}`).isDirectory());
    note(`${before.length} units; unchanged on disk (the same content, perhaps not written again): ${JSON.stringify(untouched)}`);
    // What "rewrites" promises: a product's unit that's out of date is brought up to date.
    const unit = "/etc/systemd/system/modest-deploy-alpha.service";
    writeFileSync(unit, `${readFileSync(unit, "utf8")}# e2e: out of date\n`);
    assert.equal(md("install").code, 0);
    assert.doesNotMatch(readFileSync(unit, "utf8"), /e2e: out of date/, "a product's unit wasn't rewritten");
    assert.equal(readFileSync("/etc/caddy/Caddyfile", "utf8"), caddyfile, "the Caddyfile changed");
    assert.equal(await answer("alpha"), live.alpha?.label);
  },
);

await check(59, "a product's output is in its journal; no secret in the logs", async () => {
  const own = run("journalctl", ["-u", "modest-deploy-alpha.service", "-o", "cat", "--no-pager"]).out;
  assert.match(own, /probe alpha v\d+ starting/);
  const everything = run("journalctl", ["-o", "cat", "--no-pager"]).out;
  for (const name of ["alpha", "beta"]) {
    assert.ok(!everything.includes(secrets[name] ?? "-"), `${name}'s webhook secret is in the journal`);
    const key = readFileSync(`/etc/modest-deploy/keys/${name}`, "utf8").split("\n")[1] ?? "-";
    assert.ok(!everything.includes(key), `${name}'s deploy key is in the journal`);
  }
});

// ---- Check 11, which ran alongside

await check(11, "headers sent, then the body a byte at a time: closed within a bounded time; other requests answered meanwhile", async () => {
  const { took, meanwhile } = await slowBody;
  note(`closed after ${took < 0 ? "more than 330" : (took / 1000).toFixed(0)}s; another request meanwhile: ${meanwhile}`);
  assert.ok(meanwhile > 0, "another request wasn't answered");
  assert.ok(took > 0 && took < 120000, "not closed within two minutes");
});

markServer.close();
console.log("\n== Acceptance checks");
for (const o of outcomes.sort((a, b) => a.n - b.n))
  console.log(`${o.outcome.padEnd(7)} ${String(o.n).padStart(2)}. ${o.what}${o.note ? `\n          ${o.note}` : ""}`);
const failed = outcomes.filter((o) => o.outcome === "failed");
console.log(
  `\n${outcomes.filter((o) => o.outcome === "passed").length} passed, ${failed.length} failed, ${outcomes.filter((o) => o.outcome === "skipped").length} skipped.`,
);
process.exit(failed.length ? 1 : 0);
