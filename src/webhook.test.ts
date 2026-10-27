import assert from "node:assert/strict";
import { test } from "node:test";
import { APP, COMMIT, passed, SECRET, sign } from "../test/helpers.ts";
import { isCommit, isDomain, isName, isPort, isRepo } from "./names.ts";
import { decide, signatureValid } from "./webhook.ts";

const body = JSON.stringify(passed());

test("a message signed with the app's secret is accepted", () => {
  assert.equal(signatureValid(Buffer.from(body), sign(body), SECRET), true);
});

test("a message signed with another secret, or changed after signing, is refused", () => {
  assert.equal(signatureValid(Buffer.from(body), sign(body, "b".repeat(64)), SECRET), false);
  assert.equal(signatureValid(Buffer.from(`${body} `), sign(body), SECRET), false);
});

test("a missing, short, long, upper-case, or other-algorithm signature is refused, never thrown on", () => {
  const good = sign(body);
  for (const header of [
    undefined,
    "",
    "sha256=",
    good.slice(0, -2),
    `${good}00`,
    good.toUpperCase(),
    `sha1=${good.slice(7, 47)}`,
    good.replace("sha256=", ""),
  ]) {
    assert.equal(signatureValid(Buffer.from(body), header, SECRET), false, String(header));
  }
});

test("with no secret, nothing is accepted, not even a message signed with an empty one", () => {
  assert.equal(signatureValid(Buffer.from(body), sign(body, ""), ""), false);
});

test("a successful CI run for a push to main in the app's repository deploys its commit", () => {
  assert.deepEqual(decide("workflow_run", passed(), APP), { deploy: COMMIT });
});

test("the repository is matched without case, as GitHub's are", () => {
  const upper = passed({ repository: { full_name: "Example/Shop" } }, { head_repository: { full_name: "EXAMPLE/shop" } });
  assert.deepEqual(decide("workflow_run", upper, APP), { deploy: COMMIT });
});

test("anything else is ignored: other events, unfinished or failed runs, other branches, workflows, repositories, forks, and pull requests", () => {
  const cases: [string, unknown][] = [
    ["ping", passed()],
    ["push", passed()],
    ["workflow_run", passed({ action: "requested" })],
    ["workflow_run", passed({}, { conclusion: "failure" })],
    ["workflow_run", passed({}, { conclusion: null })],
    ["workflow_run", passed({}, { head_branch: "main-x" })],
    ["workflow_run", passed({}, { head_branch: "feature" })],
    ["workflow_run", passed({}, { path: ".github/workflows/release.yml" })],
    ["workflow_run", passed({}, { path: ".github/workflows/ci.yml@refs/heads/feature" })],
    ["workflow_run", passed({ repository: { full_name: "someone/else" } })],
    ["workflow_run", passed({}, { head_repository: { full_name: "fork/shop" } })],
    ["workflow_run", passed({}, { event: "pull_request" })],
    ["workflow_run", passed({}, { event: "workflow_dispatch" })],
  ];
  for (const [event, payload] of cases) assert.ok("ignore" in decide(event, payload, APP), JSON.stringify([event, payload]).slice(0, 200));
});

test("a commit that isn't 40 hex characters is never passed on, however the message is shaped", () => {
  for (const head_sha of [`${COMMIT}; rm -rf /`, "HEAD", "main", COMMIT.toUpperCase(), COMMIT.slice(1), `${COMMIT}0`, `-${COMMIT.slice(1)}`, 12, null, ["x"]]) {
    assert.ok("ignore" in decide("workflow_run", passed({}, { head_sha }), APP), String(head_sha));
  }
});

test("messages of any shape are ignored without throwing", () => {
  for (const payload of [null, undefined, 1, "x", [], [passed()], { workflow_run: "x" }, { workflow_run: [] }, { repository: null }]) {
    assert.ok("ignore" in decide("workflow_run", payload, APP));
  }
});

test("names, domains, repositories, commits, and ports only match what's safe in a path, a unit, or an argument", () => {
  for (const good of ["ab", "shop", "ware-business-club", "a1"]) assert.ok(isName(good), good);
  for (const bad of ["", "a", "-a", "a-", "A", "a--b", "a_b", "a.b", "../x", "a/b", "a b", "x".repeat(30), "1shop"]) assert.ok(!isName(bad), bad);
  for (const good of ["example.org", "shop.example.org", "xn--bcher-kva.example", "a-b.co.uk"]) assert.ok(isDomain(good), good);
  for (const bad of [
    "",
    "org",
    "Example.org",
    "example.org.",
    ".example.org",
    "exa mple.org",
    "example.org/x",
    "*.example.org",
    "-a.example.org",
    "a-.example.org",
    "example.123",
    "{x}.org",
  ])
    assert.ok(!isDomain(bad), bad);
  for (const good of ["example/shop", "a/b.c", "Example-1/my_repo"]) assert.ok(isRepo(good), good);
  for (const bad of ["example", "example/", "/shop", "a/..", "a/.", "a/b/c", "a b/c", "-a/b", "a/b.git", "a/b;c"]) assert.ok(!isRepo(bad), bad);
  assert.ok(isCommit(COMMIT) && !isCommit(COMMIT.toUpperCase()));
  for (const port of [1024, 4100, 65535]) assert.ok(isPort(port));
  for (const port of [0, 80, 1023, 65536, 4100.5, "4100", Number.NaN]) assert.ok(!isPort(port), String(port));
});
