// Each product's settings, kept in one small JSON file on the server, and checked
// every time they're read: a file changed by hand can't put anything unchecked into
// a path, a unit, or a command.

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isDomain, isName, isPort, isRepo } from "./names.ts";
import type { Layout } from "./paths.ts";

/** A product's domain, and the domains that only redirect to it (such as www.), never reaching the product. */
export type Product = { name: string; domain: string; redirects: string[]; repo: string; port: number; branch: string; workflow: string };
export type Host = { domain: string };

export const BRANCH = "main";
export const WORKFLOW = ".github/workflows/ci.yml";
/** Products' ports are given out from here up. */
const FIRST_PORT = 4100;
/** Enough for www. and a few old names: each is a certificate Caddy gets and renews. */
export const MOST_REDIRECTS = 10;

/** Redirects are domains, each once, none the product's own, and only a few. */
export const areRedirects = (value: unknown, domain: string): value is string[] =>
  Array.isArray(value) && value.length <= MOST_REDIRECTS && value.every((r) => isDomain(r) && r !== domain) && new Set(value).size === value.length;

/** A domain of this product's already used here (another product's, or the deploy domain), or null. */
export function takenDomain(product: Pick<Product, "name" | "domain" | "redirects">, others: Product[], host: Host): string | null {
  const used = new Set([host.domain, ...others.filter((p) => p.name !== product.name).flatMap((p) => [p.domain, ...p.redirects])]);
  return [product.domain, ...product.redirects].find((d) => used.has(d)) ?? null;
}

function checked(value: unknown, name: string): Product {
  const p = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  if (p.name !== name || !isName(p.name)) throw new Error(`${name}: its settings name another product`);
  if (!isDomain(p.domain)) throw new Error(`${name}: its domain isn't a domain`);
  // Settings from before redirects have none.
  const redirects = p.redirects ?? [];
  if (!areRedirects(redirects, p.domain)) throw new Error(`${name}: its redirects aren't a few domains, other than its own`);
  if (!isRepo(p.repo)) throw new Error(`${name}: its repository isn't owner/name`);
  if (!isPort(p.port)) throw new Error(`${name}: its port isn't one it can use`);
  return { name, domain: p.domain, redirects, repo: p.repo, port: p.port, branch: BRANCH, workflow: WORKFLOW };
}

/** A product's settings, or null if there's no such product. */
export async function readProduct(paths: Layout, name: string): Promise<Product | null> {
  if (!isName(name)) return null;
  const text = await readFile(paths.product(name), "utf8").catch(() => null);
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${paths.product(name)} isn't valid JSON: fix it, or remove the product`);
  }
  return checked(value, name);
}

/** Every product, by name. One with broken settings is said in the log, and skipped. */
export async function listProducts(paths: Layout): Promise<Product[]> {
  const files = await readdir(paths.products).catch(() => [] as string[]);
  const names = files
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .filter(isName)
    .sort();
  const found: Product[] = [];
  for (const name of names) {
    // One product's broken settings are said, and skipped: they never stop the others.
    const product = await readProduct(paths, name).catch((error: Error) => {
      console.warn(`modest-deploy: skipped ${name}: ${error.message}`);
      return null;
    });
    if (product) found.push(product);
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

export async function saveProduct(paths: Layout, product: Product): Promise<void> {
  checked(product, product.name);
  const { name, domain, redirects, repo, port } = product;
  await writeWhole(paths.product(name), `${JSON.stringify({ name, domain, redirects, repo, port }, null, 2)}\n`);
}

/** The first port no product has, and nothing else is listening on. */
export function freePort(products: Product[], listening: Set<number> = new Set()): number {
  const taken = new Set([...products.map((p) => p.port), ...listening]);
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
