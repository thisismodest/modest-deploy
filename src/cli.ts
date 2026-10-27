#!/usr/bin/env node
// modest-deploy's commands. On the server, as root: check, install, add, remove, deploy,
// restart, resize, logs, and backup; and list, as anyone. On your computer: launch, and
// list --server. And the ones systemd runs: listen (the listener), work (the deploy
// service), and backup-now and copy-database (the nightly backup).

import { realpathSync } from "node:fs";
import { listApps, readApp } from "./apps.ts";
import { checkServer, report, sockets } from "./check.ts";
import { answersWithin, deploy } from "./deploy.ts";
import { helpFor, OVERVIEW, wantsHelp } from "./help.ts";
import { dnsFor, launch, listServers } from "./launch.ts";
import { createListener } from "./listener.ts";
import { sizeText, thisMachine } from "./memory.ts";
import { isName } from "./names.ts";
import { appUnit, BACKUP_UNIT, DEPLOY_UNIT, LISTENER_PORT, layout } from "./paths.ts";
import { enqueue, takeOne } from "./queue.ts";
import { must, run } from "./run.ts";
import { add, backup, copyDatabase, install, list, remove, resize, type Server } from "./server.ts";

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
  /** A comma-separated list, such as --redirect's or --server's. */
  const several = (key: string) => (text(key) ?? "").split(",").filter(Boolean);
  return { words, flag: (key: string) => options.get(key) === true, text, several };
}

const log = (line: string) => console.log(line);

function server(): Server {
  return { run, paths: layout(), node: process.execPath, cli: realpathSync(process.argv[1] ?? ""), log, machine: thisMachine() };
}

function asRoot(): void {
  if (process.getuid?.() !== 0) throw new Error("run it with sudo");
}

const app = (name: string | undefined) => {
  if (!isName(name)) throw new Error("name an app: modest-deploy list shows them");
  return name;
};

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  // Asking for help, anywhere, only ever prints it: nothing runs.
  if (command === undefined || command === "-h" || command === "--help") return log(OVERVIEW);
  if (command === "help" || wantsHelp(rest)) {
    const about = command === "help" ? rest[0] : command;
    const page = about === undefined ? OVERVIEW : helpFor(about);
    if (page) return log(page);
    process.exitCode = 1;
    return log(`There's no command called ${about}.\n\n${OVERVIEW}`);
  }
  const { words, flag, text, several } = parse(rest);
  switch (command) {
    case "check": {
      const { paths, cli, machine } = server();
      if (!report(await checkServer(run, { cli, fleet: { apps: await listApps(paths), machine } }))) process.exitCode = 1;
      return;
    }
    case "install":
      asRoot();
      return install(server(), text("domain"), flag("anyway"));
    case "add": {
      asRoot();
      const added = await add(server(), {
        name: app(words[0]),
        domain: text("domain") ?? "",
        repo: text("repo") ?? "",
        redirects: several("redirect"),
        memory: text("memory"),
        anyway: flag("anyway"),
      });
      if (flag("json")) return log(JSON.stringify(added));
      log(`Added ${added.name}, with ${sizeText(added.memory)} of memory. In ${added.repo}'s settings on GitHub, add:`);
      log(`  a deploy key (read-only): ${added.deployKey}`);
      log(`  a webhook: ${added.webhook}, content type application/json, the "Workflow runs" event, with this secret:`);
      log(`  ${added.secret}`);
      log(`Then point ${dnsFor([added.domain, ...added.redirects])}. (modest-deploy launch does all of this from your computer.)`);
      return;
    }
    case "list": {
      // From your computer, each server's in turn; on a server, its own (nothing in it is secret).
      if (text("server") !== undefined) {
        if (await listServers(run, several("server"), log)) process.exitCode = 1;
        return;
      }
      for (const row of await list(server())) log(row);
      return;
    }
    case "deploy": {
      asRoot();
      const name = app(words[0]);
      if (!(await readApp(layout(), name))) throw new Error(`there's no app called ${name}`);
      await enqueue(layout(), name, "tip");
      return log(`Asked to deploy ${name}. Follow it with: journalctl -fu ${DEPLOY_UNIT}`);
    }
    case "restart":
      asRoot();
      await must(run, "systemctl", ["restart", appUnit(app(words[0]))]);
      return;
    case "resize":
      asRoot();
      return log(await resize(server(), app(words[0]), text("memory")));
    case "logs": {
      asRoot();
      const ran = await run("journalctl", ["-u", appUnit(app(words[0])), "-n", "100", "--no-pager"]);
      return log(ran.stdout.trimEnd());
    }
    case "remove": {
      asRoot();
      const kept = await remove(server(), app(words[0]));
      log("Removed. Kept, until you delete them yourself:");
      for (const path of kept) log(`  ${path}`);
      log("On GitHub, delete the repository's webhook and deploy key for this server (Settings, then Webhooks and Deploy keys).");
      return;
    }
    case "backup": {
      // Through systemd, so it never runs twice at once (the nightly one and this).
      asRoot();
      const ran = await run("systemctl", ["start", BACKUP_UNIT], { timeout: 6 * 60 * 60_000 });
      const said = await run("journalctl", ["-u", BACKUP_UNIT, "-n", "20", "--no-pager", "-o", "cat", "--since", "-6h"]);
      log(said.stdout.trimEnd().split("\n").slice(-10).join("\n"));
      if (ran.code !== 0) throw new Error(`some copies weren't made: see journalctl -u ${BACKUP_UNIT}`);
      return;
    }
    case "launch":
      return launch(
        run,
        {
          name: words[0] ?? "",
          domain: words[1] ?? "",
          redirects: several("redirect"),
          server: text("server") ?? "",
          repo: text("repo"),
          template: text("template"),
          visibility: flag("public") ? "public" : "private",
          memory: text("memory"),
        },
        log,
      );
    // Run by systemd.
    case "listen": {
      const listener = createListener(layout());
      listener.listen(LISTENER_PORT, "127.0.0.1", () => log(`modest-deploy: listening on 127.0.0.1:${LISTENER_PORT}`));
      return;
    }
    case "work": {
      // One request at a time: the rest wait in the queue, so none is lost if this stops.
      const paths = layout();
      for (let request = await takeOne(paths); request; request = await takeOne(paths)) {
        const found = await readApp(paths, request.name).catch(() => null);
        if (!found) {
          console.error(`modest-deploy: ${request.name}: no such app`);
          continue;
        }
        try {
          const outcome = await deploy({ run, paths, answers: (port) => answersWithin(port), log }, found, request.commit);
          if ("skipped" in outcome) log(`modest-deploy: ${request.name}: nothing to do: ${outcome.skipped}`);
        } catch (error) {
          console.error(`modest-deploy: ${request.name}: not deployed: ${error instanceof Error ? error.message : String(error)}`);
          process.exitCode = 1;
        }
      }
      return;
    }
    case "backup-now": {
      // Nightly, too: anything listening to the outside that shouldn't be (an app broken into, say) is said.
      // Only root can listen below 1024, so an app can't: what's there is the server's own (SSH, Caddy).
      const open = sockets((await run("ss", ["-Hltn"])).stdout)
        .filter((socket) => !socket.loopback && !(socket.port < 1024))
        .map((socket) => socket.local);
      if (open.length) console.warn(`modest-deploy: listening to the outside, and shouldn't be: ${open.join(", ")}. Run modest-deploy check.`);
      const { copied, failed } = await backup(server());
      log(`modest-deploy: copied ${copied} databases${failed ? `; ${failed} couldn't be copied (above)` : ""}.`);
      if (failed) process.exitCode = 1;
      return;
    }
    case "copy-database":
      return copyDatabase(words[0] ?? "", words[1] ?? "");
    default:
      process.exitCode = 1;
      log(`There's no command called ${command}.\n\n${OVERVIEW}`);
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`modest-deploy: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
