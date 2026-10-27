// Acceptance check 44 (docs/acceptance-checks.md), run on this machine by run.sh: the
// repository's rules, run against fixtures in a repository of their own, fail on a public
// address, a private key, a token, and a secret, and pass the ranges kept for examples.
// The fixtures are put together here as the check runs, so this file holds none of them.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const fixtures: Record<string, { text: string; passes: boolean }> = {
  "a public IPv4 address": { text: `server ${[8, 8, 4, 4].join(".")}`, passes: false },
  "a public IPv6 address": { text: `server ${["2606", "4700", "", "1111"].join(":")}`, passes: false },
  "a PEM private key": { text: `${"-----BEGIN "}${"OPENSSH PRIVATE"} KEY-----\nabc\n`, passes: false },
  "a GitHub token": { text: `token ${"ghp"}_${"a1B2".repeat(9)}`, passes: false },
  "a 64-hex secret": { text: `secret ${"0f".repeat(32)}`, passes: false },
  "the ranges kept for examples": { text: "servers 192.0.2.10, 198.51.100.7, 203.0.113.5, and 2001:db8::1, at example.org", passes: true },
};

const outcomes: string[] = [];
for (const [what, { text, passes }] of Object.entries(fixtures)) {
  const dir = mkdtempSync(join(tmpdir(), "modest-deploy-rules-"));
  try {
    mkdirSync(join(dir, "scripts"));
    copyFileSync(join(root, "scripts", "check-rules.ts"), join(dir, "scripts", "check-rules.ts"));
    copyFileSync(join(root, "package.json"), join(dir, "package.json"));
    writeFileSync(join(dir, "notes.md"), `${text}\n`);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    let passed = true;
    try {
      execFileSync("node", ["scripts/check-rules.ts"], { cwd: dir, stdio: "pipe" });
    } catch {
      passed = false;
    }
    outcomes.push(`${what}: ${passed ? "passes" : "fails"}`);
    assert.equal(passed, passes, `${what} ${passed ? "passed" : "failed"} the rules`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(`44. the repository's rules, against fixtures: ${outcomes.join("; ")}: passed`);
