// The promises a machine can check, run by CI and by `npm run check`:
//
// - no runtime dependencies in package.json;
// - nothing imported but Node's own modules and the project's own files, in any
//   form (import, export from, import(), require, createRequire), in any code file;
// - no invisible or direction-changing characters in any code file ("Trojan
//   Source", CVE-2021-42574: code that reads one way and runs another); write
//   them as escapes ("‮") instead;
// - nothing private in any committed file: no IP address outside the ranges kept
//   for examples and this machine, no private key, and no token. modest-host is
//   public, and holds nothing about any one server: those live on the server.
//
// It also counts the source's lines. There's no limit: the rule is to write only
// what's needed, which a reviewer judges and a number can't.
//
//   node scripts/check-rules.ts

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isIPv6 } from "node:net";
import { extname, join, relative } from "node:path";

const root = join(import.meta.dirname, "..");
const CODE = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".tsx", ".jsx"]);
const problems: string[] = [];

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
for (const kind of ["dependencies", "peerDependencies", "optionalDependencies", "bundleDependencies", "bundledDependencies"]) {
  for (const name of Object.keys(pkg[kind] ?? {})) problems.push(`package.json: ${kind} has ${name}: modest-host has no runtime dependencies`);
}

// Every file git would commit: tracked, and new but not ignored.
const committed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((file) => file && file !== "package-lock.json");

/** IPv4 addresses that are fine to name: documentation (RFC 5737), this machine, any, and private ones (which say nothing of a server). */
const fineAddress = (address: string) =>
  /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/.test(address) ||
  /^(?:127\.\d+\.\d+\.\d+|0\.0\.0\.0)$/.test(address) ||
  /^(?:10\.\d+|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d+\.\d+$/.test(address);

const PRIVATE = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/, "a GitHub token"],
  [/\bnpm_[A-Za-z0-9]{30,}/, "an npm token"],
  [/\bdop_v1_[a-f0-9]{30,}/, "a DigitalOcean token"],
  [/\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{8,}/, "a Resend key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS key"],
  [/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/, "something shaped like a webhook secret (64 hex characters)"],
] as const;

/** IPv6 addresses outside the range kept for documentation (2001:db8::/32), and this machine's own. */
const IPV6 = /(?<![\w:.])[23][0-9a-f]{3}(?::[0-9a-f]{0,4}){2,8}(?![\w])/gi;
const fineV6 = (address: string) => /^2001:db8:/i.test(address);

let lines = 0;
// This file names the patterns it looks for, so it isn't searched itself.
const self = relative(root, import.meta.filename);
for (const file of committed.filter((f) => f !== self)) {
  const text = await readFile(join(root, file), "utf8").catch(() => "");
  for (const [pattern, what] of PRIVATE) if (pattern.test(text)) problems.push(`${file}: ${what}: keep it on the server, never in the repository`);
  for (const [found = ""] of text.matchAll(IPV6)) {
    const address = found.replace(/:$/, "");
    if (isIPv6(address) && !fineV6(address)) problems.push(`${file}: the address ${address}: use one kept for examples (2001:db8::)`);
  }
  for (const [address = ""] of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    if (!fineAddress(address)) problems.push(`${file}: the address ${address}: use one kept for examples (192.0.2.x, 198.51.100.x, 203.0.113.x)`);
  }
  // The end-to-end test's stand-in product imports modest-auth, as a real product would: it's not modest-host's code.
  if (!CODE.has(extname(file)) || file === "test/e2e/product.js") continue;
  if (file.startsWith("src/") && !/\.test\.[a-z]+$/.test(file)) lines += text.split("\n").length;
  for (const [found] of text.matchAll(/[\p{Cf}\p{Default_Ignorable_Code_Point}⠀]/gu)) {
    problems.push(`${file}: an invisible character (U+${(found.codePointAt(0) ?? 0).toString(16).toUpperCase()}): write it as an escape`);
  }
  // Every module named: `from "x"` (across lines), `import "x"`, `import("x")`, `import(`x`)`, `require("x")`.
  for (const [, , spec = ""] of text.matchAll(/(?:\bfrom|\bimport|\bimport\s*\(|\brequire\s*\()\s*(["'`])([^"'`\s]{1,200})\1/g)) {
    const allowed = spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../");
    if (!allowed || spec.includes("${")) problems.push(`${file}: imports "${spec}": only node: modules and the project's own files`);
  }
  // Anything that loads code another way, or from a name worked out at run time.
  for (const [found] of text.matchAll(/\bcreateRequire\b|\brequire\s*\(|\bimport\s*\(\s*(?!["'`])|process\.binding|\bmodule\.constructor/g)) {
    problems.push(`${file}: "${found}": load modules with a plain import of a fixed name`);
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`Rules kept: no dependencies; only node: and own imports; nothing private; source ${lines} lines.`);
