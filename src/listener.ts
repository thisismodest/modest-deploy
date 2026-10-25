// The deploy listener: a small HTTP server, behind Caddy, for GitHub's webhook
// messages, at POST /deploy/<product>. It checks each message, and for one that
// should deploy, leaves a request for the deploy service. It runs nothing itself,
// and nothing a message says reaches a command: only a known product's name, and a
// commit checked to be 40 hex characters.

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isName } from "./names.ts";
import type { Layout } from "./paths.ts";
import { readProduct } from "./products.ts";
import { enqueue } from "./queue.ts";
import { decide, signatureValid } from "./webhook.ts";

/** GitHub's workflow_run messages are tens of kilobytes; nothing it sends here comes near this. */
export const MOST_BYTES = 1024 * 1024;

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
      if (size > MOST_BYTES) {
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

async function handle(paths: Layout, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const name = /^\/deploy\/([^/?#]+)$/.exec(req.url ?? "")?.[1];
  if (!name || !isName(name)) return answer(res, 404, "Not found");
  if (req.method !== "POST") return answer(res, 405, "POST only");
  const product = await readProduct(paths, name);
  const secret = product ? (await readFile(paths.secret(name), "utf8").catch(() => "")).trim() : "";
  if (!product || !secret) return answer(res, 404, "Not found");
  if (Number(req.headers["content-length"] ?? 0) > MOST_BYTES) return answer(res, 413, "Too large");
  const body = await readBody(req);
  if (!body) {
    // The rest isn't read: the connection ends with the answer.
    res.setHeader("connection", "close");
    return answer(res, 413, "Too large");
  }
  const signature = req.headers["x-hub-signature-256"];
  if (!signatureValid(body, typeof signature === "string" ? signature : undefined, secret)) {
    console.warn(`modest-host: refused a message for ${name} without a valid signature`);
    return answer(res, 401, "Not signed with this product's secret");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    return answer(res, 400, "Not JSON");
  }
  const event = req.headers["x-github-event"];
  const decision = decide(typeof event === "string" ? event : undefined, payload, product);
  if ("ignore" in decision) return answer(res, 202, `Ignored: ${decision.ignore}`);
  await enqueue(paths, name, decision.deploy);
  console.log(`modest-host: ${name}: asked to deploy ${decision.deploy}`);
  answer(res, 202, `Deploying ${decision.deploy.slice(0, 7)}`);
}

export function createListener(paths: Layout): Server {
  const server = createServer((req, res) => {
    handle(paths, req, res).catch((error) => {
      console.error(`modest-host: the listener failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) answer(res, 500, "Failed");
    });
  });
  // Slow senders get ten seconds, not Node's five minutes.
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 100;
  return server;
}
