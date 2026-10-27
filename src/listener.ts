// The deploy listener: a small HTTP server, behind Caddy, for GitHub's webhook
// messages, at POST /deploy/<app>. It checks each message, and for one that
// should deploy, leaves a request for the deploy service. It runs nothing itself,
// and nothing a message says reaches a command: only a known app's name, and a
// commit checked to be 40 hex characters.

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readApp } from "./apps.ts";
import { isName } from "./names.ts";
import type { Layout } from "./paths.ts";
import { enqueue } from "./queue.ts";
import { decide, signatureValid } from "./webhook.ts";

/** GitHub's workflow_run messages are tens of kilobytes; nothing it sends here comes near this. */
export const MOST_BODY_BYTES = 1024 * 1024;

const answer = (res: ServerResponse, status: number, text: string) => {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end(`${text}\n`);
};

/** The body, whole, or null if it's larger than allowed (and then nothing more is read). */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MOST_BODY_BYTES) {
        req.removeAllListeners("data");
        req.pause();
        return resolve(null);
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** How many deliveries' ids are remembered, so one sent again is noticed. */
const REMEMBERED = 1000;

async function handle(paths: Layout, seen: Set<string>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const name = /^\/deploy\/([^/?#]+)$/.exec(req.url ?? "")?.[1];
  if (!name || !isName(name)) return answer(res, 404, "Not found");
  if (req.method !== "POST") return answer(res, 405, "POST only");
  if (Number(req.headers["content-length"] ?? 0) > MOST_BODY_BYTES) return answer(res, 413, "Too large");
  const body = await readBody(req);
  if (!body) {
    // The rest isn't read: the connection ends with the answer.
    res.setHeader("connection", "close");
    return answer(res, 413, "Too large");
  }
  // An app that doesn't exist gets the same answer as a wrong signature, so the answer doesn't say which exist.
  const app = await readApp(paths, name).catch(() => null);
  const secret = app ? (await readFile(paths.secret(name), "utf8").catch(() => "")).trim() : "";
  const signature = req.headers["x-hub-signature-256"];
  if (!app || !signatureValid(body, typeof signature === "string" ? signature : undefined, secret)) {
    return answer(res, 401, "Not signed with this app's secret");
  }
  // Each delivery is acted on once when GitHub sends it again. (The id isn't signed, so this
  // isn't a defence: that's that only main's newest commit is ever deployed, and a failed one
  // isn't tried again.)
  const delivery = req.headers["x-github-delivery"];
  const id = typeof delivery === "string" && /^[A-Za-z0-9-]{1,64}$/.test(delivery) ? `${name}:${delivery}` : null;
  if (id && seen.has(id)) return answer(res, 202, "Ignored: already received");
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    return answer(res, 400, "Not JSON");
  }
  const remember = () => {
    if (!id) return;
    seen.add(id);
    if (seen.size > REMEMBERED) seen.delete(seen.values().next().value ?? "");
  };
  const event = req.headers["x-github-event"];
  const decision = decide(typeof event === "string" ? event : undefined, payload, app);
  if ("ignore" in decision) {
    remember();
    return answer(res, 202, `Ignored: ${decision.ignore}`);
  }
  // Remembered once saved: if saving fails, GitHub's own redelivery still gets through.
  await enqueue(paths, name, decision.deploy);
  remember();
  console.log(`modest-deploy: ${name}: asked to deploy ${decision.deploy}`);
  answer(res, 202, `Deploying ${decision.deploy.slice(0, 7)}`);
}

export function createListener(paths: Layout): Server {
  const seen = new Set<string>();
  const server = createServer((req, res) => {
    handle(paths, seen, req, res).catch((error) => {
      console.error(`modest-deploy: the listener failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) answer(res, 500, "Failed");
    });
  });
  // Slow senders get ten seconds, not Node's five minutes.
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 100;
  return server;
}
