// Each app's settings, kept in one small JSON file on the server, and checked
// every time they're read: a file changed by hand can't put anything unchecked into
// a path, a unit, or a command.

import { readdir, readFile } from "node:fs/promises";
import { writeWhole } from "./files.ts";
import { DEFAULT_MEMORY, isMemory, parseMemory } from "./memory.ts";
import { isDomain, isName, isPort, isRepo } from "./names.ts";
import type { Layout } from "./paths.ts";

/**
 * An app's domain, and the domains that only redirect to it (such as www.), never
 * reaching the app; and its memory, in megabytes, set aside for it (memory.ts).
 */
export type App = { name: string; domain: string; redirects: string[]; repo: string; port: number; memory: number; branch: string; workflow: string };
export type Host = { domain: string };

export const BRANCH = "main";
export const WORKFLOW = ".github/workflows/ci.yml";
/** Apps' ports are given out from here up. */
const FIRST_PORT = 4100;
/** Enough for www. and a few old names: each is a certificate Caddy gets and renews. */
export const MOST_REDIRECTS = 10;

/** Redirects are domains, each once, none the app's own, and only a few. */
export const areRedirects = (value: unknown, domain: string): value is string[] =>
  Array.isArray(value) && value.length <= MOST_REDIRECTS && value.every((r) => isDomain(r) && r !== domain) && new Set(value).size === value.length;

/** What's said when an app's details aren't right: the same from add, on the server, and launch, on your computer. */
export const WRONG = {
  name: "the name must be 2 to 29 lowercase letters, digits, and single hyphens, starting with a letter (and not listener, deploy, or backup)",
  domain: "the domain must be a domain, such as blog.example.org",
  redirects: `the redirects must be up to ${MOST_REDIRECTS} domains, each once, other than the app's own, such as www.blog.example.org`,
  repo: "the repository must be owner/name, as on GitHub",
  memory: "the memory must be a size, such as 512M or 1G (at least 128M), or max",
};

/**
 * Checks what an app is added with, before anything is done: its name, domain, redirects,
 * repository (if known yet), and memory. Gives the memory asked for, or undefined if none.
 */
export function checkAppInput(input: {
  name: unknown;
  domain: unknown;
  redirects: unknown;
  repo?: unknown;
  memory?: string | undefined;
}): number | "max" | undefined {
  if (!isName(input.name)) throw new Error(WRONG.name);
  if (!isDomain(input.domain)) throw new Error(WRONG.domain);
  if (!areRedirects(input.redirects, input.domain)) throw new Error(WRONG.redirects);
  if (input.repo !== undefined && !isRepo(input.repo)) throw new Error(WRONG.repo);
  if (input.memory === undefined) return undefined;
  const memory = parseMemory(input.memory);
  if (memory === null) throw new Error(WRONG.memory);
  return memory;
}

/** A domain of this app's already used here (another app's, or the deploy domain), or null. */
export function takenDomain(app: Pick<App, "name" | "domain" | "redirects">, others: App[], host: Host): string | null {
  const used = new Set([host.domain, ...others.filter((other) => other.name !== app.name).flatMap((other) => [other.domain, ...other.redirects])]);
  return [app.domain, ...app.redirects].find((d) => used.has(d)) ?? null;
}

function validApp(value: unknown, name: string): App {
  const given = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  if (given.name !== name || !isName(given.name)) throw new Error(`${name}: its settings name another app`);
  if (!isDomain(given.domain)) throw new Error(`${name}: its domain isn't a domain`);
  // Settings from before redirects have none.
  const redirects = given.redirects ?? [];
  if (!areRedirects(redirects, given.domain)) throw new Error(`${name}: its redirects aren't a few domains, other than its own`);
  if (!isRepo(given.repo)) throw new Error(`${name}: its repository isn't owner/name`);
  if (!isPort(given.port)) throw new Error(`${name}: its port isn't one it can use`);
  // Settings from before memory was given out have what every app had then.
  const memory = given.memory === undefined ? DEFAULT_MEMORY : given.memory;
  if (!isMemory(memory)) throw new Error(`${name}: its memory isn't whole megabytes, from 128 to 1048576`);
  return { name, domain: given.domain, redirects, repo: given.repo, port: given.port, memory, branch: BRANCH, workflow: WORKFLOW };
}

/** An app's settings, or null if there's no such app. */
export async function readApp(paths: Layout, name: string): Promise<App | null> {
  if (!isName(name)) return null;
  const text = await readFile(paths.app(name), "utf8").catch(() => null);
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${paths.app(name)} isn't valid JSON: fix it, or remove the app`);
  }
  return validApp(value, name);
}

/** Every app but `name`: the ones it must fit beside. */
export const otherApps = async (paths: Layout, name: string) => (await listApps(paths)).filter((app) => app.name !== name);

/** Every app, by name. One with broken settings is said in the log, and skipped. */
export async function listApps(paths: Layout): Promise<App[]> {
  const files = await readdir(paths.apps).catch(() => [] as string[]);
  const names = files
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .filter(isName)
    .sort();
  const found: App[] = [];
  for (const name of names) {
    // One app's broken settings are said, and skipped: they never stop the others.
    const app = await readApp(paths, name).catch((error: Error) => {
      console.warn(`modest-deploy: skipped ${name}: ${error.message}`);
      return null;
    });
    if (app) found.push(app);
  }
  return found;
}

export async function saveApp(paths: Layout, app: App): Promise<void> {
  validApp(app, app.name);
  const { name, domain, redirects, repo, port, memory } = app;
  await writeWhole(paths.app(name), `${JSON.stringify({ name, domain, redirects, repo, port, memory }, null, 2)}\n`);
}

/** The first port no app has, and nothing else is listening on. */
export function freePort(apps: App[], listening: Set<number> = new Set()): number {
  const taken = new Set([...apps.map((app) => app.port), ...listening]);
  let port = FIRST_PORT;
  while (taken.has(port)) port++;
  return port;
}

export async function readHost(paths: Layout): Promise<Host> {
  const text = await readFile(paths.host, "utf8").catch(() => null);
  if (text === null) throw new Error("modest-deploy isn't installed on this server: run modest-deploy install");
  const domain = (JSON.parse(text) as Record<string, unknown>).domain;
  if (!isDomain(domain)) throw new Error(`${paths.host}: its domain isn't a domain`);
  return { domain };
}
