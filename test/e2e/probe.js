// An app for the acceptance checks (checks.ts): it tries, when asked, what an app
// that's been broken into would try, and answers with what it was allowed to do. Its
// MODE makes it a bad version on purpose: one that crashes, never answers, answers 500,
// or listens beyond 127.0.0.1. Only Node's own modules, so it installs without a network.

import { execFileSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer as http } from "node:http";
import { createServer as tcp } from "node:net";
import { DatabaseSync } from "node:sqlite";

const VERSION = "__VERSION__";
const MODE = "__MODE__";
const { PORT, HOST, DATA_DIR } = process.env;

if (MODE === "crash") throw new Error("this version crashes at start");
console.log(`probe ${VERSION} starting, mode ${MODE}`);

const failed = (error) => error.code ?? error.message ?? "refused";
const attempt = (act) => {
  try {
    return { result: "allowed", value: act() };
  } catch (error) {
    return { result: failed(error) };
  }
};

/** Binds a port, then lets it go, answering with what happened. */
const bind = ({ port, host, udp }) =>
  new Promise((resolve) => {
    if (udp) {
      const socket = createSocket(host.includes(":") ? "udp6" : "udp4");
      socket.once("error", (error) => resolve({ result: failed(error) }));
      socket.bind(port, host, () => socket.close(() => resolve({ result: "allowed" })));
      return;
    }
    const server = tcp();
    server.once("error", (error) => resolve({ result: failed(error) }));
    server.listen({ port, host, ipv6Only: host.includes(":") }, () => server.close(() => resolve({ result: "allowed" })));
  });

const kept = [];
const ops = {
  read: ({ path }) => attempt(() => readFileSync(path, "utf8").slice(0, 200)),
  list: ({ path }) => attempt(() => readdirSync(path)),
  write: ({ path }) => attempt(() => writeFileSync(path, "written by the probe")),
  mkdir: ({ path }) => attempt(() => mkdirSync(path, { recursive: true })),
  remove: ({ path }) => attempt(() => unlinkSync(path)),
  symlink: ({ target, path }) => attempt(() => symlinkSync(target, path)),
  exec: ({ file, args }) => attempt(() => execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 })),
  sqlite: ({ path, value }) =>
    attempt(() => {
      const db = new DatabaseSync(path);
      db.exec("create table if not exists t(x)");
      db.prepare("insert into t values (?)").run(value);
      db.close();
    }),
  status: () => attempt(() => readFileSync("/proc/self/status", "utf8")),
  bind,
  // A listener left open, as an app broken into might, until "close".
  hold: ({ port, host }) =>
    new Promise((resolve) => {
      const server = tcp();
      server.once("error", (error) => resolve({ result: failed(error) }));
      server.listen({ port, host, ipv6Only: host.includes(":") }, () => {
        kept.push(server);
        resolve({ result: "allowed" });
      });
    }),
  close: () => {
    for (const server of kept.splice(0)) server.close();
    return { result: "allowed" };
  },
};

const handle = async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/try" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const results = [];
    for (const action of JSON.parse(body)) results.push(await ops[action.op](action));
    return res.end(JSON.stringify(results));
  }
  if (url.pathname === "/env") return res.end(JSON.stringify({ PORT, HOST, DATA_DIR }));
  // What the app is given: its thread pool, and the memory Node sees it may use
  if (url.pathname === "/given") return res.end(JSON.stringify({ pool: process.env.UV_THREADPOOL_SIZE, memory: process.constrainedMemory() }));
  if (url.pathname === "/alloc") {
    // Holds on to memory, touching every page, until the memory limit stops it.
    const held = [];
    for (;;) held.push(Buffer.alloc(64 * 1024 * 1024, 1));
  }
  // Every other request is noted, so a check can tell whether anything reached the app.
  appendFileSync(`${DATA_DIR}/seen.log`, `${req.headers.host} ${req.url}\n`);
  if (MODE === "silent") return;
  if (MODE === "error") {
    res.statusCode = 500;
    return res.end("broken");
  }
  res.end(VERSION);
};

const listen = (host) => http(handle).listen({ port: Number(PORT), host, ipv6Only: host.includes(":") });
if (MODE === "any") listen("0.0.0.0");
else if (MODE === "any6") listen("::");
else if (MODE === "both") {
  listen(HOST);
  listen("::");
} else listen(HOST);
