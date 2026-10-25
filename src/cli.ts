#!/usr/bin/env node
// modest-host's commands. On the server, as root: check, install, add, remove, list,
// deploy, restart, logs, and backup. On your laptop: launch. And the ones systemd
// runs: listen (the listener), work (the deploy service), and copy-database (backup).

import { realpathSync } from "node:fs";
import { checkServer, report } from "./check.ts";
import { answersWithin, deploy } from "./deploy.ts";
import { launch } from "./launch.ts";
import { createListener } from "./listener.ts";
import { isName } from "./names.ts";
import { LISTENER_PORT, layout, productUnit } from "./paths.ts";
import { readProduct } from "./products.ts";
import { enqueue, takeOne } from "./queue.ts";
import { must, run } from "./run.ts";
import { add, backup, copyDatabase, install, list, remove, type Server } from "./server.ts";

const USAGE = `modest-host: host small Node products on one server.

On the server (with sudo):
  check                                         check the server is set up safely
  install --domain <deploy-domain>              install modest-host's own parts; again after updating it
  add <name> --domain <domain> --repo <owner/repo> [--json]
                                                add a product (launch does this for you)
  list                                          the products, and what each is running
  deploy <name>                                 deploy main's newest commit now (whether or not CI passed)
  restart <name>                                restart a product (after changing its keys)
  logs <name>                                   a product's latest log lines
  remove <name>                                 take a product off (its data stays)
  backup                                        copy every product's databases now

On your laptop:
  launch <name> <domain> --server <ssh-host> [--repo <owner/repo>] [--template <owner/repo>] [--public]
                                                make the repository, add the product, and connect them

Add --anyway to install or add to go on when check finds something to fix.`;

/** The words after the command, and its --options. */
function parse(args: string[]) {
  const words: string[] = [];
  const options = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("--")) words.push(arg);
    else if (["--json", "--anyway", "--public"].includes(arg)) options.set(arg.slice(2), true);
    else options.set(arg.slice(2), args[++i] ?? "");
  }
  const text = (key: string) => {
    const value = options.get(key);
    return typeof value === "string" ? value : undefined;
  };
  return { words, flag: (key: string) => options.get(key) === true, text };
}

const log = (line: string) => console.log(line);

function server(): Server {
  return { run, paths: layout(), node: process.execPath, cli: realpathSync(process.argv[1] ?? ""), log };
}

function asRoot(): void {
  if (process.getuid?.() !== 0) throw new Error("run it with sudo");
}

const product = (name: string | undefined) => {
  if (!isName(name)) throw new Error("name a product: modest-host list shows them");
  return name;
};

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { words, flag, text } = parse(rest);
  switch (command) {
    case "check": {
      if (!report(await checkServer(run, undefined, realpathSync(process.argv[1] ?? "")))) process.exitCode = 1;
      return;
    }
    case "install":
      asRoot();
      return install(server(), text("domain"), flag("anyway"));
    case "add": {
      asRoot();
      const added = await add(server(), product(words[0]), text("domain") ?? "", text("repo") ?? "", flag("anyway"));
      if (flag("json")) return log(JSON.stringify(added));
      log(`Added ${added.name}. In ${added.repo}'s settings on GitHub, add:`);
      log(`  a deploy key (read-only): ${added.deployKey}`);
      log(`  a webhook: ${added.webhook}, content type application/json, the "Workflow runs" event, with this secret:`);
      log(`  ${added.secret}`);
      log(`Then point ${added.domain}'s DNS at this server. (modest-host launch does all of this from your laptop.)`);
      return;
    }
    case "list":
      asRoot();
      for (const row of await list(server())) log(row);
      return;
    case "deploy": {
      asRoot();
      const name = product(words[0]);
      if (!(await readProduct(layout(), name))) throw new Error(`there's no product called ${name}`);
      await enqueue(layout(), name, "tip");
      return log(`Asked to deploy ${name}. Follow it with: journalctl -fu modest-host-deploy.service`);
    }
    case "restart":
      asRoot();
      await must(run, "systemctl", ["restart", productUnit(product(words[0]))]);
      return;
    case "logs": {
      asRoot();
      const ran = await run("journalctl", ["-u", productUnit(product(words[0])), "-n", "100", "--no-pager"]);
      return log(ran.stdout.trimEnd());
    }
    case "remove": {
      asRoot();
      const kept = await remove(server(), product(words[0]));
      log("Removed. Kept, until you delete them yourself:");
      for (const path of kept) log(`  ${path}`);
      log("On GitHub, delete the repository's webhook and deploy key for this server (Settings, then Webhooks and Deploy keys).");
      return;
    }
    case "backup": {
      // Through systemd, so it never runs twice at once (the nightly one and this).
      asRoot();
      const ran = await run("systemctl", ["start", "modest-host-backup.service"], { timeout: 6 * 60 * 60_000 });
      const said = await run("journalctl", ["-u", "modest-host-backup.service", "-n", "20", "--no-pager", "-o", "cat", "--since", "-6h"]);
      log(said.stdout.trimEnd().split("\n").slice(-10).join("\n"));
      if (ran.code !== 0) throw new Error("some copies weren't made: see journalctl -u modest-host-backup.service");
      return;
    }
    case "launch":
      return launch(
        run,
        {
          name: words[0] ?? "",
          domain: words[1] ?? "",
          server: text("server") ?? "",
          repo: text("repo"),
          template: text("template"),
          visibility: flag("public") ? "public" : "private",
        },
        log,
      );
    // Run by systemd.
    case "listen": {
      const listener = createListener(layout());
      listener.listen(LISTENER_PORT, "127.0.0.1", () => log(`modest-host: listening on 127.0.0.1:${LISTENER_PORT}`));
      return;
    }
    case "work": {
      // One request at a time: the rest wait in the queue, so none is lost if this stops.
      const paths = layout();
      for (let request = await takeOne(paths); request; request = await takeOne(paths)) {
        const found = await readProduct(paths, request.name).catch(() => null);
        if (!found) {
          console.error(`modest-host: ${request.name}: no such product`);
          continue;
        }
        try {
          const outcome = await deploy({ run, paths, answers: (port) => answersWithin(port), log }, found, request.commit);
          if ("skipped" in outcome) log(`modest-host: ${request.name}: nothing to do: ${outcome.skipped}`);
        } catch (error) {
          console.error(`modest-host: ${request.name}: not deployed: ${error instanceof Error ? error.message : String(error)}`);
          process.exitCode = 1;
        }
      }
      return;
    }
    case "backup-now": {
      const { copied, failed } = await backup(server());
      log(`modest-host: copied ${copied} databases${failed ? `; ${failed} couldn't be copied (above)` : ""}.`);
      if (failed) process.exitCode = 1;
      return;
    }
    case "copy-database":
      return copyDatabase(words[0] ?? "", words[1] ?? "");
    default:
      log(USAGE);
      if (command && command !== "help" && command !== "--help") process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`modest-host: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
