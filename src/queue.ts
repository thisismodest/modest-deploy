// Deploy requests: the only thing the listener can do is leave one here, a file named
// for a product, holding the commit to deploy (or "tip", for whatever is on main).
// systemd starts the deploy service whenever the folder isn't empty, and it takes
// them. A newer request for a product replaces an older one still waiting.

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isCommit, isName } from "./names.ts";
import type { Layout } from "./paths.ts";

export type Request = { name: string; commit: string | "tip" };

const isWanted = (value: string) => value === "tip" || isCommit(value);

export async function enqueue(paths: Layout, name: string, commit: string | "tip"): Promise<void> {
  if (!isName(name) || !isWanted(commit)) throw new Error("not a request to deploy");
  await mkdir(paths.writing, { recursive: true });
  await mkdir(paths.requests, { recursive: true });
  // Written aside, then moved in whole: the deploy service never reads half a request.
  const partial = join(paths.writing, `${name}.${randomBytes(6).toString("hex")}`);
  await writeFile(partial, commit, { mode: 0o600 });
  await rename(partial, join(paths.requests, name));
}

/** Takes every waiting request, removing each; anything that isn't one is removed too. */
export async function takeAll(paths: Layout): Promise<Request[]> {
  const taken: Request[] = [];
  for (const file of await readdir(paths.requests).catch(() => [] as string[])) {
    const path = join(paths.requests, file);
    const commit = (await readFile(path, "utf8").catch(() => "")).trim();
    await unlink(path).catch(() => {});
    if (isName(file) && isWanted(commit)) taken.push({ name: file, commit });
    else console.warn(`modest-host: removed ${JSON.stringify(file.slice(0, 40))} from the deploy requests: it isn't one`);
  }
  return taken;
}
