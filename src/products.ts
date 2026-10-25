// Each product's settings, kept in one small JSON file on the server, and checked
// every time they're read: a file changed by hand can't put anything unchecked into
// a path, a unit, or a command.

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isDomain, isName, isPort, isRepo } from "./names.ts";
import type { Layout } from "./paths.ts";

export type Product = { name: string; domain: string; repo: string; port: number; branch: string; workflow: string };
export type Host = { domain: string };

export const BRANCH = "main";
export const WORKFLOW = ".github/workflows/ci.yml";
/** Products' ports are given out from here up. */
const FIRST_PORT = 4100;

function checked(value: unknown, name: string): Product {
  const p = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  if (p.name !== name || !isName(p.name)) throw new Error(`${name}: its settings name another product`);
  if (!isDomain(p.domain)) throw new Error(`${name}: its domain isn't a domain`);
  if (!isRepo(p.repo)) throw new Error(`${name}: its repository isn't owner/name`);
  if (!isPort(p.port)) throw new Error(`${name}: its port isn't one it can use`);
  return { name, domain: p.domain, repo: p.repo, port: p.port, branch: BRANCH, workflow: WORKFLOW };
}

/** A product's settings, or null if there's no such product. */
export async function readProduct(paths: Layout, name: string): Promise<Product | null> {
  if (!isName(name)) return null;
  const text = await readFile(paths.product(name), "utf8").catch(() => null);
  return text === null ? null : checked(JSON.parse(text), name);
}

/** Every product, by name. One with broken settings is reported, not hidden. */
export async function listProducts(paths: Layout): Promise<Product[]> {
  const files = await readdir(paths.products).catch(() => [] as string[]);
  const names = files
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .filter(isName)
    .sort();
  const found: Product[] = [];
  for (const name of names) {
    const product = await readProduct(paths, name);
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
  const { name, domain, repo, port } = product;
  await writeWhole(paths.product(name), `${JSON.stringify({ name, domain, repo, port }, null, 2)}\n`);
}

/** The first port no product has. */
export function freePort(products: Product[]): number {
  const taken = new Set(products.map((p) => p.port));
  let port = FIRST_PORT;
  while (taken.has(port)) port++;
  return port;
}

export async function readHost(paths: Layout): Promise<Host> {
  const text = await readFile(paths.host, "utf8").catch(() => null);
  if (text === null) throw new Error("modest-host isn't installed on this server: run modest-host install");
  const domain = (JSON.parse(text) as Record<string, unknown>).domain;
  if (!isDomain(domain)) throw new Error(`${paths.host}: its domain isn't a domain`);
  return { domain };
}
