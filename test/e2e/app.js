// An app for the end-to-end test. It answers with its version, keeps accounts with
// modest-auth (from npm, so a dependency is installed), and at /probe, tries what a
// app that's been broken into would try, reporting what it was allowed to do.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as http } from "node:http";
import { createServer as tcp } from "node:net";
import { basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAuth } from "modest-auth";

const VERSION = "__VERSION__";
const self = basename(process.env.DATA_DIR);
createAuth(new DatabaseSync(`${process.env.DATA_DIR}/app.db`));
writeFileSync(`${process.env.DATA_DIR}/note.txt`, "kept");

const tried = (act) => {
  try {
    act();
    return "allowed";
  } catch (error) {
    return error.code ?? "refused";
  }
};

async function probe(other) {
  const bound = await new Promise((resolve) => {
    const server = tcp();
    server.once("error", (error) => resolve(error.code ?? "refused"));
    server.listen(4199, "127.0.0.1", () => server.close(() => resolve("allowed")));
  });
  return {
    "read its own webhook secret": tried(() => readFileSync(`/etc/modest-deploy/secrets/${self}`)),
    "read its own environment file": tried(() => readFileSync(`/etc/modest-deploy/env/${self}.env`)),
    "read its own deploy key": tried(() => readFileSync(`/etc/modest-deploy/keys/${self}`)),
    "read /etc/shadow": tried(() => readFileSync("/etc/shadow")),
    "change its own code": tried(() => writeFileSync(`/srv/modest-deploy/${self}/current/server.js`, "x")),
    "write to /etc": tried(() => writeFileSync("/etc/evil", "x")),
    "read another app's data": tried(() => readFileSync(`/var/lib/modest-deploy/${other}/app.db`)),
    "read another app's code": tried(() => readFileSync(`/srv/modest-deploy/${other}/current/server.js`)),
    "read the backups": tried(() => readdirSync("/var/backups/modest-deploy")),
    "listen on another port": bound,
    "see other users' processes": readdirSync("/proc").filter((p) => /^\d+$/.test(p)).length > 3 ? "allowed" : "refused",
    "write its own data": tried(() => writeFileSync(`${process.env.DATA_DIR}/x`, "x")),
  };
}

http(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/probe") return res.end(JSON.stringify(await probe(url.searchParams.get("other"))));
  res.end(VERSION);
}).listen(Number(process.env.PORT), process.env.HOST);
