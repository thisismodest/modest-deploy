import assert from "node:assert/strict";
import { test } from "node:test";
import { PRODUCT } from "../test/helpers.ts";
import { checkServer, outsidePorts } from "./check.ts";
import { isServer, launch } from "./launch.ts";
import { layout } from "./paths.ts";
import type { Ran, Run, RunOptions } from "./run.ts";
import { hostSite, listenerService, productService, productSite } from "./units.ts";

const ok = (stdout = ""): Ran => ({ code: 0, stdout, stderr: "" });

test("only SSH, HTTP, and HTTPS may listen to the outside; anything on this machine's own address may", () => {
  const ss = [
    "LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*",
    "LISTEN 0 4096 [::]:443 [::]:*",
    "LISTEN 0 4096 *:80 *:*",
    "LISTEN 0 511 127.0.0.1:9327 0.0.0.0:*",
    "LISTEN 0 511 127.0.0.53%lo:53 0.0.0.0:*",
    "LISTEN 0 511 [::1]:4100 [::]:*",
    "LISTEN 0 511 0.0.0.0:4101 0.0.0.0:*",
    "LISTEN 0 80 [::]:5432 [::]:*",
  ].join("\n");
  assert.deepEqual(outsidePorts(ss), ["0.0.0.0:4101", "[::]:5432"]);
});

function server(answers: Record<string, Ran>): Run {
  return async (program, args) => answers[`${program} ${args.join(" ")}`] ?? answers[program] ?? ok();
}

test("a safe server passes every check but root (the tests aren't root)", async () => {
  const run = server({
    sshd: ok("passwordauthentication no\nkbdinteractiveauthentication no\npermitrootlogin no\n"),
    "dpkg-query -W -f=${Status} unattended-upgrades": ok("install ok installed"),
    "ss -Hltn": ok("LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*"),
  });
  const findings = await checkServer(run, async () => 'APT::Periodic::Unattended-Upgrade "1";');
  assert.deepEqual(
    findings.filter((f) => !f.ok).map((f) => f.what),
    process.getuid?.() === 0 ? [] : ["running as root"],
  );
});

test("password sign-in, root sign-in, no automatic updates, and an open port are each found, with what to do", async () => {
  const run = server({
    sshd: ok("passwordauthentication yes\nkbdinteractiveauthentication no\npermitrootlogin prohibit-password\n"),
    "dpkg-query -W -f=${Status} unattended-upgrades": ok("unknown ok not-installed"),
    "ss -Hltn": ok("LISTEN 0 4096 0.0.0.0:3000 0.0.0.0:*"),
    caddy: { code: 1, stdout: "", stderr: "not found" },
  });
  const failed = (await checkServer(run, async () => "")).filter((f) => !f.ok);
  for (const what of ["SSH: no sign-in by password", "SSH: no sign-in as root", "automatic security updates", "Caddy installed"]) {
    assert.ok(
      failed.some((f) => f.what === what && f.fix.length > 10),
      what,
    );
  }
  assert.match(failed.find((f) => f.what.startsWith("nothing listening"))?.fix ?? "", /0\.0\.0\.0:3000/);
});

test("each product runs as its own user, sandboxed, able to bind only its own port, with the server's secrets out of reach", () => {
  const unit = productService(layout(), PRODUCT, "/usr/bin/node");
  for (const line of [
    "User=mh-shop",
    "NoNewPrivileges=yes",
    "ProtectSystem=strict",
    "ProtectHome=yes",
    "PrivateTmp=yes",
    "CapabilityBoundingSet=",
    "SocketBindAllow=tcp:4100",
    "SocketBindDeny=any",
    "StateDirectory=modest-host/shop",
    "MemoryMax=512M",
  ]) {
    assert.ok(unit.split("\n").includes(line), line);
  }
  assert.match(unit, /InaccessiblePaths=.*\/etc\/modest-host\/secrets.*\/etc\/modest-host\/keys.*\/etc\/modest-host\/env/);
  const listener = listenerService(layout(), "/usr/bin/node", "/usr/lib/node_modules/modest-host/dist/cli.js");
  for (const line of ["User=modest-host", "ReadWritePaths=/var/spool/modest-host", "IPAddressDeny=any", "SocketBindAllow=tcp:9327"])
    assert.ok(listener.split("\n").includes(line), line);
});

test("nothing unchecked can reach a unit or a Caddy site, so no value can add a line of its own", () => {
  assert.throws(() => productService(layout(), { ...PRODUCT, name: "shop\nExecStartPre=/bin/sh" }, "/usr/bin/node"));
  assert.throws(() => productSite({ ...PRODUCT, domain: "shop.example.org {\n}\nevil.example.org" }));
  assert.throws(() => productSite({ ...PRODUCT, port: 22 }));
  assert.throws(() => hostSite("x.org\n\troot * /"));
  assert.equal(productSite(PRODUCT), "# Written by modest-host: changes here are replaced.\nshop.example.org {\n\treverse_proxy 127.0.0.1:4100\n}\n");
});

test("an SSH destination is a host or user@host, never anything a shell or ssh would read as more", () => {
  for (const good of ["myserver", "deploy@203.0.113.7", "ubuntu@host.example.org"]) assert.ok(isServer(good), good);
  for (const bad of ["", "-oProxyCommand=x", "a b", "user@host;id", "host$(id)", "@host", "user@-host", "a\nb"]) assert.ok(!isServer(bad), bad);
});

test("launch makes the repository, adds the product over SSH, and gives GitHub the key and webhook, with the secret only on standard input", async () => {
  const calls: { program: string; args: string[]; options: RunOptions }[] = [];
  const secret = "c".repeat(64);
  const run: Run = async (program, args, options = {}) => {
    calls.push({ program, args, options });
    if (program === "gh" && args[0] === "api" && args[1] === "user") return ok("example\n");
    if (program === "gh" && args[0] === "repo" && args[1] === "view") return { code: 1, stdout: "", stderr: "not found" };
    if (program === "ssh")
      return ok(
        JSON.stringify({
          name: "shop",
          domain: "shop.example.org",
          repo: "example/shop",
          webhook: "https://deploy.example.org/deploy/shop",
          secret,
          deployKey: "ssh-ed25519 AAAA modest-host shop",
        }),
      );
    if (program === "gh" && args[0] === "api" && args.length === 2) return ok("[]");
    return ok("{}");
  };
  const lines: string[] = [];
  await launch(run, { name: "shop", domain: "shop.example.org", server: "deploy@203.0.113.7", template: "example/template", visibility: "private" }, (l) =>
    lines.push(l),
  );
  assert.deepEqual(calls.find((c) => c.args[1] === "create")?.args, ["repo", "create", "example/shop", "--private", "--template", "example/template"]);
  assert.deepEqual(calls.find((c) => c.program === "ssh")?.args.slice(4), [
    "sudo",
    "modest-host",
    "add",
    "shop",
    "--domain",
    "shop.example.org",
    "--repo",
    "example/shop",
    "--json",
  ]);
  const hook = calls.find((c) => c.args.includes("repos/example/shop/hooks"));
  assert.ok(hook && JSON.parse(hook.options.input ?? "").config.secret === secret);
  assert.equal(JSON.parse(hook?.options.input ?? "").events[0], "workflow_run");
  assert.ok(JSON.parse(calls.find((c) => c.args.includes("repos/example/shop/keys"))?.options.input ?? "").read_only);
  assert.ok(!calls.some((c) => c.args.join(" ").includes(secret)), "the secret is never an argument");
  assert.ok(lines.some((l) => /DNS/.test(l)));
});

test("launch refuses anything unsafe before running anything", async () => {
  const calls: string[] = [];
  const run: Run = async (program) => {
    calls.push(program);
    return ok();
  };
  for (const bad of [
    { name: "../x", domain: "a.example.org", server: "s" },
    { name: "shop", domain: "a.example.org; id", server: "s" },
    { name: "shop", domain: "a.example.org", server: "-oProxyCommand=id" },
    { name: "shop", domain: "a.example.org", server: "s", template: "x;y" },
  ]) {
    await assert.rejects(launch(run, { ...bad, visibility: "private" }, () => {}));
  }
  assert.deepEqual(calls, []);
});

test("launch refuses a server's answer that would send the webhook elsewhere, or add a key that isn't one plain key", async () => {
  const good = { name: "shop", webhook: "https://deploy.example.org/deploy/shop", secret: "c".repeat(64), deployKey: "ssh-ed25519 AAAA modest-host shop" };
  for (const bad of [
    { ...good, name: "other" },
    { ...good, secret: "x" },
    { ...good, deployKey: "nope" },
    { ...good, deployKey: "ssh-ed25519 AAAA ok\nssh-ed25519 BBBB attacker" },
    { ...good, webhook: "http://deploy.example.org/deploy/shop" },
    { ...good, webhook: "https://deploy.example.org/deploy/other" },
    { ...good, webhook: "https://deploy.example.org:8443/deploy/shop" },
    { ...good, webhook: "https://user@deploy.example.org/deploy/shop" },
    { ...good, webhook: "https://deploy.example.org/deploy/shop?x=1" },
    { ...good, webhook: "https://203.0.113.9/deploy/shop" },
  ]) {
    const posted: string[] = [];
    const run: Run = async (program, args) => {
      if (program === "gh" && args[1] === "view") return ok();
      if (program === "ssh") return ok(JSON.stringify(bad));
      if (program === "gh" && args[0] === "api") posted.push(args.join(" "));
      return ok("[]");
    };
    await assert.rejects(
      launch(run, { name: "shop", domain: "shop.example.org", server: "s", repo: "example/shop", visibility: "private" }, () => {}),
      /wasn't what/,
      JSON.stringify(bad),
    );
    assert.deepEqual(posted, [], "nothing reached GitHub");
  }
});

test("launch run again updates the webhook already there, and doesn't add the same key twice", async () => {
  const calls: { args: string[]; input?: string | undefined }[] = [];
  const run: Run = async (program, args, options = {}) => {
    calls.push({ args, input: options.input });
    if (program === "gh" && args[1] === "view") return ok();
    if (program === "ssh")
      return ok(
        JSON.stringify({
          name: "shop",
          webhook: "https://deploy.example.org/deploy/shop",
          secret: "d".repeat(64),
          deployKey: "ssh-ed25519 AAAA modest-host shop",
        }),
      );
    if (args[1] === "repos/example/shop/keys?per_page=100") return ok(JSON.stringify([{ id: 1, key: "ssh-ed25519 AAAA" }]));
    if (args[1] === "repos/example/shop/hooks?per_page=100") return ok(JSON.stringify([{ id: 42, config: { url: "https://deploy.example.org/deploy/shop" } }]));
    return ok("{}");
  };
  await launch(run, { name: "shop", domain: "shop.example.org", server: "s", repo: "example/shop", visibility: "private" }, () => {});
  assert.ok(!calls.some((c) => c.args.includes("repos/example/shop/keys") && c.args.includes("POST")), "no second key");
  const patch = calls.find((c) => c.args.includes("PATCH"));
  assert.ok(patch?.args.includes("repos/example/shop/hooks/42"));
  assert.equal(JSON.parse(patch?.input ?? "").config.secret, "d".repeat(64), "the webhook signs with the new secret");
});

test("a backup copy is taken only if it's a plain file of the product's own: a link put in its place is refused, and what it points to untouched", async () => {
  const { mkdtemp, writeFile, symlink, link, readFile, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { takeCopy } = await import("./server.ts");
  const dir = await mkdtemp(join(tmpdir(), "modest-host-copy-"));
  const me = process.getuid?.() ?? 0;
  const precious = join(dir, "precious");
  await writeFile(precious, "not the product's", { mode: 0o644 });
  await symlink(precious, join(dir, "linked.db"));
  await assert.rejects(takeCopy(join(dir, "linked.db"), join(dir, "out1"), me));
  await link(precious, join(dir, "hard.db"));
  await assert.rejects(takeCopy(join(dir, "hard.db"), join(dir, "out2"), me), /plain file/);
  await writeFile(join(dir, "copy.db"), "a database");
  await assert.rejects(takeCopy(join(dir, "copy.db"), join(dir, "out3"), me + 1), /plain file/);
  await takeCopy(join(dir, "copy.db"), join(dir, "out4"), me);
  assert.equal(await readFile(join(dir, "out4"), "utf8"), "a database");
  assert.equal((await stat(join(dir, "out4"))).mode & 0o777, 0o600);
  assert.equal((await stat(precious)).mode & 0o777, 0o644);
});

test("SSH on its own port isn't counted as open, but anything else listening over UDP is", async () => {
  const run = server({
    sshd: ok("port 2222\npasswordauthentication no\nkbdinteractiveauthentication no\npermitrootlogin no\n"),
    "ss -Hltn": ok("LISTEN 0 4096 0.0.0.0:2222 0.0.0.0:*"),
    "ss -Hlun": ok("UNCONN 0 0 0.0.0.0:68 0.0.0.0:*\nUNCONN 0 0 [::]:443 [::]:*\nUNCONN 0 0 0.0.0.0:5353 0.0.0.0:*\nUNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:*"),
  });
  const listening = (await checkServer(run, async () => "")).find((f) => f.what.startsWith("nothing listening"));
  assert.equal(listening?.ok, false);
  assert.equal(listening?.fix, "stop, or listen only on 127.0.0.1: 0.0.0.0:5353 (UDP)");
});
