// GitHub's webhook messages: whether one is really from GitHub (its signature), and
// whether it's one to act on (CI passed for a push to main, in this app's own
// repository). Nothing else about a message is used.

import { createHmac, timingSafeEqual } from "node:crypto";
import { isCommit, sameRepo } from "./names.ts";

/**
 * Whether `header` (X-Hub-Signature-256) is the HMAC-SHA256 of exactly these bytes
 * with this app's secret. Compared in constant time, so the answer's timing
 * says nothing about how close a guess was.
 */
export function signatureValid(body: Uint8Array, header: string | undefined, secret: string): boolean {
  if (!secret || typeof header !== "string" || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(header.slice(7), "hex"));
}

export type Watched = { repo: string; workflow: string; branch: string };
export type Decision = { deploy: string } | { ignore: string };

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * What to do with a message already known to be from GitHub: deploy a commit, or
 * ignore it (saying why). Only a finished, successful run of the app's CI
 * workflow, for a push to its branch, in its own repository, deploys.
 */
export function decide(event: string | undefined, payload: unknown, watched: Watched): Decision {
  if (event === "ping") return { ignore: "GitHub's test message: the webhook works" };
  if (event !== "workflow_run") return { ignore: `a ${String(event).slice(0, 40)} message: only workflow_run deploys` };
  const message = record(payload);
  const runOf = record(message.workflow_run);
  const repo = record(message.repository).full_name;
  const from = record(runOf.head_repository).full_name;
  if (message.action !== "completed") return { ignore: "the run hasn't finished" };
  if (typeof repo !== "string" || !sameRepo(repo, watched.repo)) return { ignore: "another repository" };
  if (typeof from !== "string" || !sameRepo(from, watched.repo)) return { ignore: "a run for a fork" };
  if (runOf.path !== watched.workflow) return { ignore: `not the ${watched.workflow} workflow` };
  if (runOf.event !== "push") return { ignore: "not a run for a push" };
  if (runOf.head_branch !== watched.branch) return { ignore: `not ${watched.branch}` };
  if (runOf.conclusion !== "success") return { ignore: "the run didn't pass" };
  if (!isCommit(runOf.head_sha)) return { ignore: "no commit" };
  return { deploy: runOf.head_sha };
}
