// Shared by the tests: a temporary server layout, a product in it, and signed messages.

import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Layout, layout } from "../src/paths.ts";
import { type Product, saveProduct, writeWhole } from "../src/products.ts";

export const SECRET = "a".repeat(64);
export const COMMIT = "0123456789abcdef0123456789abcdef01234567";
export const PRODUCT: Product = {
  name: "shop",
  domain: "shop.example.org",
  redirects: [],
  repo: "example/shop",
  port: 4100,
  branch: "main",
  workflow: ".github/workflows/ci.yml",
};

/** A temporary server, removed when `run` ends. */
export async function onServer(run: (paths: Layout) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "modest-deploy-"));
  try {
    await run(layout(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function withProduct(paths: Layout, product = PRODUCT, secret = SECRET): Promise<void> {
  await saveProduct(paths, product);
  await writeWhole(paths.secret(product.name), secret, 0o640);
}

export const sign = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

/** A workflow_run message as GitHub sends it when CI passes on main, with any part changed. */
export function passed(changes: Record<string, unknown> = {}, run: Record<string, unknown> = {}) {
  return {
    action: "completed",
    repository: { full_name: "example/shop" },
    workflow_run: {
      path: ".github/workflows/ci.yml",
      event: "push",
      head_branch: "main",
      conclusion: "success",
      head_sha: COMMIT,
      head_repository: { full_name: "example/shop" },
      ...run,
    },
    ...changes,
  };
}
