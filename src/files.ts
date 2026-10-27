// Reading and writing files safely, as root: whole or not at all, and never through a
// link or into a device that something else put in place.

import { constants } from "node:fs";
import { lstat, mkdir, open, rename, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

/** Writes a file whole or not at all: a crash never leaves half of one. */
export async function writeWhole(path: string, text: string, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  await writeFile(partial, text, { mode });
  await rename(partial, path);
}

/**
 * A small file, read by root only if it's a plain file (never a link, which could point
 * anywhere, or a device or pipe that never ends), or null if it isn't there. Anything
 * else, or more than `most` bytes, throws.
 */
export async function readPlain(path: string, most = 1024 * 1024): Promise<string | null> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw new Error(`${basename(path)} isn't a plain file`);
  });
  if (!file) return null;
  try {
    const found = await file.stat();
    if (!found.isFile()) throw new Error(`${basename(path)} isn't a plain file`);
    if (found.size > most) throw new Error(`${basename(path)} is larger than ${most} bytes`);
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

/** Whether there's anything at `path`: a link counts, and isn't followed. */
export const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );
