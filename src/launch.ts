// Launching a product, from your laptop: make its GitHub repository (from a template,
// if named), add it on the server over SSH, then give GitHub the server's read-only
// deploy key and the signed webhook. Uses gh and ssh, as you already do; the webhook's
// secret goes to GitHub on standard input, never in a command line.

import { isDomain, isName, isRepo } from "./names.ts";
import { must, type Run } from "./run.ts";
import type { Added } from "./server.ts";

export type Launch = {
  name: string;
  domain: string;
  server: string;
  repo?: string | undefined;
  template?: string | undefined;
  visibility: "private" | "public";
};

/** An SSH destination: a host from your SSH config, or user@host. Nothing a shell would read as more. */
export const isServer = (value: unknown): value is string =>
  typeof value === "string" && /^(?:[a-z_][a-z0-9_-]{0,31}@)?[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(value);

export async function launch(run: Run, options: Launch, log: (line: string) => void): Promise<void> {
  const { name, domain, server } = options;
  if (!isName(name)) throw new Error("the name must be 2 to 29 lowercase letters, digits, and single hyphens, starting with a letter");
  if (!isDomain(domain)) throw new Error("the domain must be a domain, such as shop.example.org");
  if (!isServer(server)) throw new Error("the server must be a host from your SSH config, or user@host");
  if (options.template !== undefined && !isRepo(options.template)) throw new Error("the template must be a repository, as owner/name");
  const env = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "",
    ...(process.env.GH_TOKEN ? { GH_TOKEN: process.env.GH_TOKEN } : {}),
  };
  const gh = (args: string[], input?: string) => must(run, "gh", args, { env, ...(input === undefined ? {} : { input }) });

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
    ["-o", "BatchMode=yes", "--", server, "sudo", "modest-host", "add", name, "--domain", domain, "--repo", repo, "--json"],
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
    hook.username !== ""
  ) {
    throw new Error("the server's answer wasn't what modest-host add gives");
  }
  const webhook = hook.href;
  log(`Added ${name} on ${server}.`);

  // Run again, launch updates what's there rather than adding a second webhook or key.
  const keys = JSON.parse(await gh(["api", `repos/${repo}/keys?per_page=100`])) as { key?: string }[];
  if (!keys.some((k) => k.key?.split(" ").slice(0, 2).join(" ") === key)) {
    await gh(["api", "--method", "POST", `repos/${repo}/keys`, "--input", "-"], JSON.stringify({ title: `modest-host (${server})`, key, read_only: true }));
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
  log(`  1. Point ${domain}'s DNS at the server (an A record, and AAAA if it has IPv6).`);
  log(`  2. Push to main, with a CI workflow at .github/workflows/ci.yml. Once it passes, it's live at https://${domain}.`);
}
