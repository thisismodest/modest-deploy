// Deploy requests: the only thing the listener can do is leave one here, a file named
// for a product, holding the commit to deploy (or "tip", for whatever is on main).
// systemd starts the deploy service whenever the folder isn't empty, and it takes
// them. A newer request for a product replaces an older one still waiting.

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
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

/** A request's text, read only if it's a small plain file: a pipe or a link left in the queue can't stall or misdirect it. */
async function readSmall(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!file) return "";
  try {
    const found = await file.stat();
    if (!found.isFile() || found.size > 64) return "";
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

/**
 * Takes one waiting request, or null if none is waiting. It's moved aside before
 * it's read, so a newer request for the same product, arriving meanwhile, is kept
 * for next time rather than lost. Anything that isn't a request is thrown away.
 */
export async function takeOne(paths: Layout): Promise<Request | null> {
  for (const file of (await readdir(paths.requests).catch(() => [] as string[])).sort()) {
    const taken = join(paths.writing, `taken-${randomBytes(6).toString("hex")}`);
    if (
      !(await rename(join(paths.requests, file), taken).then(
        () => true,
        () => false,
      ))
    )
      continue;
    const commit = (await readSmall(taken)).trim();
    await rm(taken, { recursive: true, force: true }).catch(() => {});
    if (isName(file) && isWanted(commit)) return { name: file, commit };
    console.warn(`modest-deploy: removed ${JSON.stringify(file.slice(0, 40))} from the deploy requests: it isn't one`);
  }
  return null;
}

/** Takes every waiting request (for tests, and for clearing the queue). */
export async function takeAll(paths: Layout): Promise<Request[]> {
  const taken: Request[] = [];
  for (let request = await takeOne(paths); request; request = await takeOne(paths)) taken.push(request);
  return taken;
}
