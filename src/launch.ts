// Launching a product, from your computer: make its GitHub repository (from a template,
// if named), add it on the server over SSH, then give GitHub the server's read-only
// deploy key and the signed webhook. Uses gh and ssh, as you already do; the webhook's
// secret goes to GitHub on standard input, never in a command line.

import { parseMemory } from "./memory.ts";
import { isDomain, isName, isRepo } from "./names.ts";
import { areRedirects, MOST_REDIRECTS } from "./products.ts";
import { must, type Run } from "./run.ts";
import type { Added } from "./server.ts";

export type Launch = {
  name: string;
  domain: string;
  redirects?: string[] | undefined;
  server: string;
  repo?: string | undefined;
  template?: string | undefined;
  visibility: "private" | "public";
  /** The product's memory, such as 512M, 1G, or max (memory.ts); the server's default if not given. */
  memory?: string | undefined;
};

/** An SSH destination: a host from your SSH config, or user@host. Nothing a shell would read as more. */
export const isServer = (value: unknown): value is string =>
  typeof value === "string" && /^(?:[a-z_][a-z0-9_-]{0,31}@)?[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(value);

export async function launch(run: Run, options: Launch, log: (line: string) => void): Promise<void> {
  const { name, domain, server, redirects = [] } = options;
  if (!isName(name)) throw new Error("the name must be 2 to 29 lowercase letters, digits, and single hyphens, starting with a letter");
  if (!isDomain(domain)) throw new Error("the domain must be a domain, such as shop.example.org");
  if (!areRedirects(redirects, domain))
    throw new Error(`the redirects must be up to ${MOST_REDIRECTS} domains, each once, other than the product's own, such as www.shop.example.org`);
  if (!isServer(server)) throw new Error("the server must be a host from your SSH config, or user@host");
  if (options.template !== undefined && !isRepo(options.template)) throw new Error("the template must be a repository, as owner/name");
  if (options.memory !== undefined && parseMemory(options.memory) === null)
    throw new Error("the memory must be a size, such as 512M or 1G (at least 128M), or max");
  const env = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "",
    ...(process.env.GH_TOKEN ? { GH_TOKEN: process.env.GH_TOKEN } : {}),
  };
  const gh = (args: string[], input?: string) => must(run, "gh", args, { env, ...(input === undefined ? {} : { input }) });

  // gh does the GitHub half. Without it, or signed out, nothing is done: say how to get it, or do it all by hand.
  const status = await run("gh", ["auth", "status"], { env });
  if (status.code !== 0) {
    const missing = /ENOENT|not found/i.test(status.stderr);
    throw new Error(
      [
        missing
          ? "launch uses gh, GitHub's command line tool, to make the repository and connect it, and it isn't installed. Install it (https://cli.github.com, or brew install gh), sign in with gh auth login, then run launch again."
          : "launch uses gh, GitHub's command line tool, and it isn't signed in: run gh auth login, then launch again.",
        "",
        "Or do it by hand (nothing has been changed yet):",
        ...byHand(options),
      ].join("\n"),
    );
  }

  const repo = options.repo ?? `${(await gh(["api", "user", "--jq", ".login"])).trim()}/${name}`;
  if (!isRepo(repo)) throw new Error("the repository must be owner/name, as on GitHub");
  if ((await run("gh", ["repo", "view", repo, "--json", "name"], { env })).code === 0) {
    log(`Using the repository ${repo}, which already exists.`);
  } else {
    await gh(["repo", "create", repo, `--${options.visibility}`, ...(options.template ? ["--template", options.template] : [])]);
    log(`Made the repository ${repo}.`);
  }

  // Every value here has been checked above, so the server's shell sees only plain words.
  const answer = await must(
    run,
    "ssh",
    [
      ...["-o", "BatchMode=yes", "--", server, "sudo", "modest-deploy", "add", name, "--domain", domain, "--repo", repo],
      ...(redirects.length ? ["--redirect", redirects.join(",")] : []),
      ...(options.memory === undefined ? [] : ["--memory", options.memory]),
      "--json",
    ],
    { env, timeout: 120_000 },
  );
  // The JSON is the last line: check's report comes before it. Each part is checked
  // strictly: whatever the server says, only this product's webhook and one plain key
  // can reach GitHub.
  const added = JSON.parse(answer.trim().split("\n").at(-1) ?? "{}") as Partial<Added>;
  const hook = typeof added.webhook === "string" && URL.canParse(added.webhook) ? new URL(added.webhook) : null;
  const key = typeof added.deployKey === "string" ? /^(ssh-ed25519 [A-Za-z0-9+/]+={0,3})(?: [^\n]*)?$/.exec(added.deployKey)?.[1] : undefined;
  if (
    added.name !== name ||
    typeof added.secret !== "string" ||
    !/^[0-9a-f]{64}$/.test(added.secret) ||
    !key ||
    !hook ||
    hook.protocol !== "https:" ||
    !isDomain(hook.hostname) ||
    hook.port !== "" ||
    hook.pathname !== `/deploy/${name}` ||
    hook.search !== "" ||
    hook.username !== "" ||
    hook.password !== "" ||
    hook.hash !== ""
  ) {
    throw new Error("the server's answer wasn't what modest-deploy add gives");
  }
  const webhook = hook.href;
  log(`Added ${name} on ${server}.`);

  // Run again, launch updates what's there rather than adding a second webhook or key.
  const keys = JSON.parse(await gh(["api", `repos/${repo}/keys?per_page=100`])) as { key?: string }[];
  if (!keys.some((k) => k.key?.split(" ").slice(0, 2).join(" ") === key)) {
    await gh(["api", "--method", "POST", `repos/${repo}/keys`, "--input", "-"], JSON.stringify({ title: `modest-deploy (${server})`, key, read_only: true }));
  }
  const hooks = JSON.parse(await gh(["api", `repos/${repo}/hooks?per_page=100`])) as { id?: number; config?: { url?: string } }[];
  const existing = hooks.find((h) => h.config?.url === webhook && Number.isInteger(h.id));
  await gh(
    ["api", "--method", existing ? "PATCH" : "POST", existing ? `repos/${repo}/hooks/${existing.id}` : `repos/${repo}/hooks`, "--input", "-"],
    JSON.stringify({
      active: true,
      events: ["workflow_run"],
      config: { url: webhook, content_type: "json", secret: added.secret, insecure_ssl: "0" },
      ...(existing ? {} : { name: "web" }),
    }),
  );
  log(`Gave GitHub the server's read-only deploy key, and the webhook to ${webhook}.`);
  log("");
  log("Left to do:");
  log(`  1. Point the DNS of ${[domain, ...redirects].join(", ")} at the server (an A record each, and AAAA if it has IPv6).`);
  log(`  2. Push to main, with a CI workflow at .github/workflows/ci.yml. Once it passes, it's live at https://${domain}.`);
}

/**
 * Every product on each of `servers`, from your computer: each server's own list, over
 * SSH, in turn. One that doesn't answer is said, and the rest still listed. Gives how
 * many didn't answer.
 */
export async function listServers(run: Run, servers: string[], log: (line: string) => void): Promise<number> {
  const odd = servers.find((server) => !isServer(server));
  if (odd !== undefined || !servers.length) throw new Error("each server must be a host from your SSH config, or user@host, separated by commas");
  let failed = 0;
  for (const server of servers) {
    log(`== ${server}`);
    const ran = await run("ssh", ["-o", "BatchMode=yes", "--", server, "modest-deploy", "list"], { timeout: 60_000 });
    if (ran.code === 0) log(ran.stdout.trimEnd() || "(no products)");
    else {
      failed++;
      log(`didn't answer: ${ran.stderr.trim().split("\n").at(-1) ?? `ssh exited ${ran.code}`}`);
    }
  }
  return failed;
}

/** What launch does, as steps to do by hand, with this product's own details. Every value has been checked. */
function byHand({ name, domain, server, redirects = [], repo, memory }: Launch): string[] {
  const where = repo ?? `your-username/${name}`;
  const add = [
    `ssh -t ${server} sudo modest-deploy add ${name} --domain ${domain} --repo ${where}`,
    ...(redirects.length ? [`--redirect ${redirects.join(",")}`] : []),
    ...(memory === undefined ? [] : [`--memory ${memory}`]),
  ].join(" ");
  return [
    `  1. On GitHub, make the repository ${where}, if it isn't there.`,
    "  2. Add the product on the server, which prints a deploy key, and a webhook with its secret:",
    `       ${add}`,
    `  3. In ${where}'s settings on GitHub: add the deploy key (Deploy keys, read-only), and the webhook`,
    `     (Webhooks: its address, content type application/json, the secret, and only the "Workflow runs" event).`,
    `  4. Point the DNS of ${[domain, ...redirects].join(", ")} at the server, and push to main.`,
  ];
}
