// Each app's settings, kept in one small JSON file on the server, and checked
// every time they're read: a file changed by hand can't put anything unchecked into
// a path, a unit, or a command.

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_MEMORY, isMemory } from "./memory.ts";
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

/** A domain of this app's already used here (another app's, or the deploy domain), or null. */
export function takenDomain(app: Pick<App, "name" | "domain" | "redirects">, others: App[], host: Host): string | null {
  const used = new Set([host.domain, ...others.filter((p) => p.name !== app.name).flatMap((p) => [p.domain, ...p.redirects])]);
  return [app.domain, ...app.redirects].find((d) => used.has(d)) ?? null;
}

function checked(value: unknown, name: string): App {
  const p = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  if (p.name !== name || !isName(p.name)) throw new Error(`${name}: its settings name another app`);
  if (!isDomain(p.domain)) throw new Error(`${name}: its domain isn't a domain`);
  // Settings from before redirects have none.
  const redirects = p.redirects ?? [];
  if (!areRedirects(redirects, p.domain)) throw new Error(`${name}: its redirects aren't a few domains, other than its own`);
  if (!isRepo(p.repo)) throw new Error(`${name}: its repository isn't owner/name`);
  if (!isPort(p.port)) throw new Error(`${name}: its port isn't one it can use`);
  // Settings from before memory was given out have what every app had then.
  const memory = p.memory === undefined ? DEFAULT_MEMORY : p.memory;
  if (!isMemory(memory)) throw new Error(`${name}: its memory isn't whole megabytes, from 128 to 1048576`);
  return { name, domain: p.domain, redirects, repo: p.repo, port: p.port, memory, branch: BRANCH, workflow: WORKFLOW };
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
  return checked(value, name);
}

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

/** Writes a file whole or not at all: a crash never leaves half of one. */
export async function writeWhole(path: string, text: string, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  await writeFile(partial, text, { mode });
  await rename(partial, path);
}

export async function saveApp(paths: Layout, app: App): Promise<void> {
  checked(app, app.name);
  const { name, domain, redirects, repo, port, memory } = app;
  await writeWhole(paths.app(name), `${JSON.stringify({ name, domain, redirects, repo, port, memory }, null, 2)}\n`);
}

/** The first port no app has, and nothing else is listening on. */
export function freePort(apps: App[], listening: Set<number> = new Set()): number {
  const taken = new Set([...apps.map((p) => p.port), ...listening]);
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
