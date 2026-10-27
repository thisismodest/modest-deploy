// Each app's memory, set aside for it alone and its ceiling too, so however busy
// apps get, together they can never take more than the server has for them, and
// the server always keeps its own share: for the system, SSH, Caddy, the listener, and
// deploys. An app is added, or given more, only if it fits beside the others.
// Sizes are in megabytes throughout.

import { availableParallelism, totalmem } from "node:os";

/** The server's size: its memory (in bytes, as Node gives it) and its cores. */
export type Machine = { total: number; cores: number };

/** What an app is given if nothing's said: enough for a small Node server and its sign-ins. */
export const DEFAULT_MEMORY = 512;
/** The least an app can be given: Node itself, and a little to run. */
export const LEAST_MEMORY = 128;
/** The most a size can say (1TB): anything more is a typing mistake. */
const MOST_MEMORY = 1024 * 1024;

export const thisMachine = (): Machine => ({ total: totalmem(), cores: availableParallelism() });

/**
 * The server's memory, shared out: what it keeps for itself (a quarter, and never under
 * 384MB), of which a deploy may use half (from 192MB to 1GB) while it builds; and the
 * rest for apps.
 */
export function shares({ total }: Machine): { reserve: number; deploy: number; apps: number } {
  const all = Math.floor(total / 1024 ** 2);
  const reserve = Math.min(all, Math.max(384, Math.ceil(all / 4)));
  const deploy = Math.min(1024, Math.max(192, Math.floor(reserve / 2)));
  return { reserve, deploy, apps: all - reserve };
}

/** A size as it's written: 512M, 1G, or 1.5G. */
export const sizeText = (mb: number) => (mb >= 1024 && mb % 512 === 0 ? `${mb / 1024}G` : `${mb}M`);

/** A size as given: whole megabytes or gigabytes (512M, 1G), at least 128M; or "max", for all that's left. */
export function parseMemory(text: unknown): number | "max" | null {
  if (text === "max") return "max";
  const found = typeof text === "string" ? /^([1-9]\d{0,6})([MG])$/i.exec(text) : null;
  if (!found) return null;
  const mb = Number(found[1]) * (found[2]?.toUpperCase() === "G" ? 1024 : 1);
  return isMemory(mb) ? mb : null;
}

/** An app's memory in its settings: whole megabytes, from 128M to 1TB. */
export const isMemory = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= LEAST_MEMORY && value <= MOST_MEMORY;

/** The memory given to these apps, together. */
export const memoryGiven = (apps: { memory: number }[]) => apps.reduce((sum, app) => sum + app.memory, 0);

/** The least a server should leave for apps, so it can run one small one: under this, check says it's too small. */
export const LEAST_FOR_APPS = 256;

/** Said when a server hasn't room for even the smallest app. */
export const tooSmall = (machine: Machine) => {
  const { reserve, apps } = shares(machine);
  return `this server is too small: it has ${sizeText(Math.floor(machine.total / 1024 ** 2))}, keeps ${sizeText(reserve)} for itself (the system, SSH, Caddy, and deploys), and that leaves ${sizeText(Math.max(apps, 0))} for apps. Use one with 1GB or more`;
};

/**
 * The memory an app is given: what's asked for, if it fits beside the others' on this
 * machine; for "max", all that's left; for "default" (none asked for), 512M, or all
 * that's left if that's less. `others` excludes the app itself.
 */
export function allot(asked: number | "max" | "default", others: { memory: number }[], machine: Machine): number {
  const room = shares(machine).apps - memoryGiven(others);
  if (room < LEAST_MEMORY) {
    throw new Error(
      others.length
        ? `there's no room for another app: apps here have ${sizeText(shares(machine).apps)} between them, all given out. Give one less (modest-deploy resize), remove one, or use a bigger server`
        : tooSmall(machine),
    );
  }
  const memory = asked === "max" ? room : asked === "default" ? Math.min(DEFAULT_MEMORY, room) : asked;
  if (memory > room) throw new Error(`there's room for at most ${sizeText(room)} here: use --memory ${sizeText(room)} or less, or a bigger server`);
  return memory;
}

/**
 * Node's thread pool for each app: its cores, for modest-auth to hash on (it uses
 * no more than the cores), and two more, so file reads always keep a thread. At most 18.
 */
export const threadPoolFor = ({ cores }: Machine) => Math.min(Math.max(1, Math.floor(cores) || 1) + 2, 18);
