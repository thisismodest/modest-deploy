import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { onServer, PRODUCT } from "../test/helpers.ts";
import { checkServer, outsidePorts } from "./check.ts";
import { isServer, launch, listServers } from "./launch.ts";
import type { Machine } from "./memory.ts";
import { layout } from "./paths.ts";
import { readProduct, takenDomain, writeWhole } from "./products.ts";
import type { Ran, Run, RunOptions } from "./run.ts";
import { deployService, hostSite, listenerService, productService, productSite } from "./units.ts";

const ok = (stdout = ""): Ran => ({ code: 0, stdout, stderr: "" });
const MB = 1024 ** 2;
const SMALL: Machine = { total: 960 * MB, cores: 1 };

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
  const unit = productService(layout(), PRODUCT, "/usr/bin/node", SMALL);
  for (const line of [
    "User=md-shop",
    "NoNewPrivileges=yes",
    "ProtectSystem=strict",
    "ProtectHome=yes",
    "PrivateTmp=yes",
    "CapabilityBoundingSet=",
    "SocketBindAllow=tcp:4100",
    "SocketBindDeny=any",
    "StateDirectory=modest-deploy/shop",
    "MemoryMax=512M",
    "MemoryLow=512M",
    "Environment=UV_THREADPOOL_SIZE=3",
  ]) {
    assert.ok(unit.split("\n").includes(line), line);
  }
  assert.match(unit, /InaccessiblePaths=.*\/etc\/modest-deploy\/secrets.*\/etc\/modest-deploy\/keys.*\/etc\/modest-deploy\/env/);
  const listener = listenerService(layout(), "/usr/bin/node", "/usr/lib/node_modules/modest-deploy/dist/cli.js");
  for (const line of ["User=modest-deploy", "ReadWritePaths=/var/spool/modest-deploy", "IPAddressDeny=any", "SocketBindAllow=tcp:9327"])
    assert.ok(listener.split("\n").includes(line), line);
});

test("nothing unchecked can reach a unit or a Caddy site, so no value can add a line of its own", () => {
  assert.throws(() => productService(layout(), { ...PRODUCT, name: "shop\nExecStartPre=/bin/sh" }, "/usr/bin/node", SMALL));
  assert.throws(() => productSite({ ...PRODUCT, domain: "shop.example.org {\n}\nevil.example.org" }));
  assert.throws(() => productSite({ ...PRODUCT, port: 22 }));
  assert.throws(() => hostSite("x.org\n\troot * /"));
  assert.equal(productSite(PRODUCT), "# Written by modest-deploy: changes here are replaced.\nshop.example.org {\n\treverse_proxy 127.0.0.1:4100\n}\n");
});

test("a redirect sends visitors to the product's own domain, at the same path, and never reaches the product", () => {
  assert.equal(
    productSite({ ...PRODUCT, redirects: ["www.shop.example.org"] }),
    "# Written by modest-deploy: changes here are replaced.\nshop.example.org {\n\treverse_proxy 127.0.0.1:4100\n}\n\nwww.shop.example.org {\n\tredir https://shop.example.org{uri} permanent\n}\n",
  );
});

test("no redirect can add a line to a Caddy site, name the product's own domain, or be one of too many", () => {
  for (const redirects of [
    ["www.shop.example.org {\n}\nevil.example.org"],
    ["www.shop.example.org\n\treverse_proxy 127.0.0.1:22"],
    ["*.example.org"],
    ["shop.example.org"],
    ["www.shop.example.org", "www.shop.example.org"],
    Array.from({ length: 11 }, (_, i) => `r${i}.example.org`),
  ]) {
    assert.throws(() => productSite({ ...PRODUCT, redirects }), JSON.stringify(redirects));
  }
});

test("a product can't take another's domain or redirect, or the deploy domain, by its own domain or a redirect", () => {
  const host = { domain: "deploy.example.org" };
  const other = { ...PRODUCT, name: "blog", domain: "blog.example.org", redirects: ["www.blog.example.org"], port: 4101 };
  for (const domain of ["blog.example.org", "www.blog.example.org", "deploy.example.org"]) {
    assert.equal(takenDomain({ ...PRODUCT, redirects: [domain] }, [other], host), domain);
    assert.equal(takenDomain({ ...PRODUCT, domain, redirects: [] }, [other], host), domain);
  }
  // Its own, added again, isn't taken.
  const shop = { ...PRODUCT, redirects: ["www.shop.example.org"] };
  assert.equal(takenDomain(shop, [other, shop], host), null);
});

test("a settings file's redirects are checked when read: one changed by hand can't reach Caddy, and one from before redirects has none", async () => {
  await onServer(async (paths) => {
    const { name, domain, repo, port } = PRODUCT;
    await writeWhole(paths.product(name), JSON.stringify({ name, domain, repo, port }));
    assert.deepEqual((await readProduct(paths, name))?.redirects, []);
    for (const redirects of ["www.shop.example.org", ["evil.example.org {\n}"], [domain], [1]]) {
      await writeWhole(paths.product(name), JSON.stringify({ name, domain, redirects, repo, port }));
      await assert.rejects(readProduct(paths, name), JSON.stringify(redirects));
    }
  });
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
          deployKey: "ssh-ed25519 AAAA modest-deploy shop",
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
    "modest-deploy",
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

test("launch gives the server the redirects as one checked word, and asks for each one's DNS", async () => {
  const calls: { program: string; args: string[] }[] = [];
  const run: Run = async (program, args) => {
    calls.push({ program, args });
    if (program === "ssh")
      return ok(
        JSON.stringify({
          name: "shop",
          webhook: "https://deploy.example.org/deploy/shop",
          secret: "c".repeat(64),
          deployKey: "ssh-ed25519 AAAA modest-deploy shop",
        }),
      );
    if (program === "gh" && args[0] === "api" && args.length === 2) return ok("[]");
    return ok("{}");
  };
  const lines: string[] = [];
  const redirects = ["www.shop.example.org", "shop.example.com"];
  await launch(run, { name: "shop", domain: "shop.example.org", redirects, server: "s", repo: "example/shop", visibility: "private" }, (l) => lines.push(l));
  assert.deepEqual(calls.find((c) => c.program === "ssh")?.args.slice(-3), ["--redirect", "www.shop.example.org,shop.example.com", "--json"]);
  assert.ok(lines.some((l) => l.includes("shop.example.org, www.shop.example.org, shop.example.com")));
});

test("without gh, or signed out of it, launch changes nothing, and says how to get it, or do it by hand with this product's own command", async () => {
  for (const [state, ran, says] of [
    ["not installed", { code: 1, stdout: "", stderr: "spawn gh ENOENT" }, /install it[\s\S]*cli\.github\.com/i],
    ["signed out", { code: 1, stdout: "", stderr: "You are not logged into any GitHub hosts. To log in, run: gh auth login" }, /gh auth login/],
  ] as const) {
    const calls: string[][] = [];
    const run: Run = async (program, args) => {
      calls.push([program, ...args]);
      return program === "gh" ? ran : ok();
    };
    const said = await launch(
      run,
      {
        name: "shop",
        domain: "shop.example.org",
        redirects: ["www.shop.example.org"],
        server: "myserver",
        repo: "example/shop",
        template: undefined,
        visibility: "private",
        memory: "1G",
      },
      () => {},
    ).then(
      () => "",
      (error: Error) => error.message,
    );
    assert.match(said, says, state);
    assert.match(
      said,
      /ssh -t myserver sudo modest-deploy add shop --domain shop\.example\.org --repo example\/shop --redirect www\.shop\.example\.org --memory 1G/,
      `${state}: the command by hand`,
    );
    assert.match(said, /deploy key[\s\S]*webhook[\s\S]*Workflow runs/, `${state}: what to add on GitHub`);
    assert.deepEqual(
      calls.filter((c) => c[0] !== "gh" || !["--version", "auth"].includes(c[1] ?? "")),
      [],
      `${state}: nothing ran but the look at gh`,
    );
  }
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
    { name: "shop", domain: "a.example.org", server: "s", redirects: ["www.a.example.org;id"] },
    { name: "shop", domain: "a.example.org", server: "s", redirects: ["a.example.org"] },
  ]) {
    await assert.rejects(launch(run, { ...bad, visibility: "private" }, () => {}));
  }
  assert.deepEqual(calls, []);
});

test("launch refuses a server's answer that would send the webhook elsewhere, or add a key that isn't one plain key", async () => {
  const good = { name: "shop", webhook: "https://deploy.example.org/deploy/shop", secret: "c".repeat(64), deployKey: "ssh-ed25519 AAAA modest-deploy shop" };
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
          deployKey: "ssh-ed25519 AAAA modest-deploy shop",
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
  const dir = await mkdtemp(join(tmpdir(), "modest-deploy-copy-"));
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

test("a Match block that allows passwords for one user, or from a private address, is found", async () => {
  const safe = "passwordauthentication no\nkbdinteractiveauthentication no\npermitrootlogin no\n";
  const run: Run = async (program, args) => {
    if (program === "getent") return ok("root:x:0:0::/root:/bin/bash\nann:x:1000:1000::/home/ann:/bin/bash\nsvc:x:1001:1001::/:/usr/sbin/nologin\n");
    if (program === "sshd")
      return ok(
        args.join(" ").includes("user=ann,host=outside.example,addr=10.0.0.1") ? safe.replace("passwordauthentication no", "passwordauthentication yes") : safe,
      );
    return ok();
  };
  const finding = (await checkServer(run, async () => "")).find((f) => f.what === "SSH: no sign-in by password");
  assert.equal(finding?.ok, false);
  assert.match(finding?.fix ?? "", /allowed for ann/);
});

test("a Match block that allows root for one outside address is found, in a file sshd includes, though no sample connection hits it", async () => {
  const files: Record<string, string> = {
    "/etc/ssh/sshd_config": "Include sshd_config.d/99-site.conf\nPermitRootLogin no\n",
    "/etc/ssh/sshd_config.d/99-site.conf": "Match User ann\n  PasswordAuthentication no\nMatch Address 203.0.113.0/24\n  PermitRootLogin=prohibit-password\n",
  };
  const run = server({ sshd: ok("passwordauthentication no\nkbdinteractiveauthentication no\npermitrootlogin no\n") });
  const read = async (path: string) => files[path] ?? Promise.reject(new Error("ENOENT"));
  const finding = (await checkServer(run, read)).find((f) => f.what.startsWith("SSH: no Match block"));
  assert.equal(finding?.ok, false);
  assert.match(finding?.fix ?? "", /PermitRootLogin=prohibit-password \(\/etc\/ssh\/sshd_config\.d\/99-site\.conf\)/);
  assert.doesNotMatch(finding?.fix ?? "", /PasswordAuthentication/);

  files["/etc/ssh/sshd_config.d/99-site.conf"] = "Match Address 203.0.113.0/24\n  PermitRootLogin no\n";
  assert.equal((await checkServer(run, read)).find((f) => f.what.startsWith("SSH: no Match block"))?.ok, true);
});

test("a product's memory is set aside for it and is its ceiling, and its thread pool fits the cores", () => {
  const unit = productService(layout(), { ...PRODUCT, memory: 1536 }, "/usr/bin/node", { total: 8 * 1024 * MB, cores: 6 });
  for (const line of ["MemoryMax=1536M", "MemoryLow=1536M", "Environment=UV_THREADPOOL_SIZE=8"]) assert.ok(unit.split("\n").includes(line), line);
  const big = productService(layout(), PRODUCT, "/usr/bin/node", { total: 256 * 1024 * MB, cores: 64 });
  assert.ok(big.split("\n").includes("Environment=UV_THREADPOOL_SIZE=18"), "never more than 18");
  assert.throws(() => productService(layout(), { ...PRODUCT, memory: 64 }, "/usr/bin/node", SMALL), "too little to run");
});

test("the deploy service builds within the server's own share of memory", () => {
  assert.ok(deployService("/usr/bin/node", "/opt/modest-deploy/src/cli.ts", SMALL).split("\n").includes("MemoryMax=192M"));
  assert.ok(
    deployService("/usr/bin/node", "/opt/modest-deploy/src/cli.ts", { total: 16 * 1024 * MB, cores: 8 })
      .split("\n")
      .includes("MemoryMax=1024M"),
  );
});

test("products given more memory than the server has for them are found, with what to do", async () => {
  const run = server({});
  const finding = async (memories: number[]) =>
    (
      await checkServer(run, async () => "", undefined, { products: memories.map((memory, i) => ({ ...PRODUCT, name: `p${i}`, memory })), machine: SMALL })
    ).find((f) => f.what.startsWith("products' memory"));
  assert.equal((await finding([512]))?.ok, true);
  assert.equal((await finding([256, 256]))?.ok, true);
  const over = await finding([512, 512]);
  assert.equal(over?.ok, false);
  assert.match(over?.fix ?? "", /1G given to products, which have 576M here/);
  assert.match(over?.fix ?? "", /modest-deploy resize/);
});

test("launch gives the server a checked memory size, and refuses an odd one before running anything", async () => {
  const calls: string[][] = [];
  const run: Run = async (program, args) => {
    calls.push([program, ...args]);
    if (program === "gh" && args[0] === "api" && args[1] === "user") return ok("example\n");
    if (program === "ssh")
      return ok(
        JSON.stringify({
          name: "shop",
          domain: "shop.example.org",
          repo: "example/shop",
          webhook: "https://deploy.example.org/deploy/shop",
          secret: "c".repeat(64),
          deployKey: "ssh-ed25519 AAAA modest-deploy shop",
        }),
      );
    if (program === "gh" && args[0] === "api" && args.length === 2) return ok("[]");
    return ok();
  };
  await launch(
    run,
    {
      name: "shop",
      domain: "shop.example.org",
      redirects: [],
      server: "myserver",
      repo: "example/shop",
      template: undefined,
      visibility: "private",
      memory: "768M",
    },
    () => {},
  );
  const ssh = calls.find((c) => c[0] === "ssh") ?? [];
  assert.deepEqual(ssh.slice(ssh.indexOf("--memory"), ssh.indexOf("--memory") + 2), ["--memory", "768M"]);
  for (const memory of ["768M; reboot", "lots", "1.5G", "-1G"]) {
    calls.length = 0;
    await assert.rejects(
      launch(
        run,
        {
          name: "shop",
          domain: "shop.example.org",
          redirects: [],
          server: "myserver",
          repo: "example/shop",
          template: undefined,
          visibility: "private",
          memory,
        },
        () => {},
      ),
      /memory/,
    );
    assert.deepEqual(calls, [], `${memory}: nothing ran`);
  }
});

test("list --server lists each server's products in turn, over SSH, refusing an odd server before running anything", async () => {
  const calls: string[][] = [];
  const said: string[] = [];
  const run: Run = async (program, args) => {
    calls.push([program, ...args]);
    const host = args[args.indexOf("--") + 1];
    if (host === "down") return { code: 255, stdout: "", stderr: "ssh: connect to host down port 22: Connection refused" };
    return ok(`${host === "one" ? "shop" : "blog"}  https://x.example.org  example/x  port 4100  512M  active  0123456\n`);
  };
  const failed = await listServers(run, ["one", "two", "down"], (line) => said.push(line));
  assert.equal(failed, 1, "one server didn't answer");
  for (const call of calls) {
    assert.equal(call[0], "ssh");
    assert.ok(call.includes("BatchMode=yes"));
    assert.deepEqual(call.slice(call.indexOf("--") + 2), ["modest-deploy", "list"]);
  }
  assert.match(said.join("\n"), /== one\nshop[\s\S]*== two\nblog[\s\S]*== down\n.*Connection refused/);
  calls.length = 0;
  await assert.rejects(
    listServers(run, ["one", "-oProxyCommand=x"], () => {}),
    /server/,
  );
  assert.deepEqual(calls, [], "nothing ran");
});

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const cli = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 20_000 });
const COMMANDS = ["check", "install", "launch", "add", "list", "deploy", "restart", "resize", "logs", "remove", "backup"];

test("with no command, -h, --help, or help, it says how to get started, and exits cleanly", () => {
  for (const args of [[], ["-h"], ["--help"], ["help"]]) {
    const ran = cli(...args);
    assert.equal(ran.status, 0, JSON.stringify(args));
    assert.match(ran.stdout, /Getting started/, JSON.stringify(args));
    for (const command of COMMANDS) assert.ok(ran.stdout.includes(command), `${JSON.stringify(args)} names ${command}`);
  }
});

test("asking for a command's help only prints it: the command never runs", () => {
  for (const command of COMMANDS) {
    for (const args of [
      [command, "--help"],
      [command, "-h"],
      ["help", command],
      [command, "shop", "--domain", "shop.example.org", "--repo", "example/shop", "--help"],
    ]) {
      const ran = cli(...args);
      assert.equal(ran.status, 0, JSON.stringify(args));
      assert.ok(ran.stdout.startsWith(`modest-deploy ${command}`), JSON.stringify(args));
      // Run for real, a command for the server stops at once, as the tests aren't root.
      assert.doesNotMatch(ran.stdout + ran.stderr, /run it with sudo|isn't installed|the name must be|there's no product/, JSON.stringify(args));
    }
  }
});

test("an unknown command says so, and fails", () => {
  for (const args of [["nonsense"], ["help", "nonsense"], ["help", "constructor"], ["toString", "--help"]]) {
    const ran = cli(...args);
    assert.equal(ran.status, 1, JSON.stringify(args));
    assert.match(ran.stdout, /There's no command called/, JSON.stringify(args));
  }
});
