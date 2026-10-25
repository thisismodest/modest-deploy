// What modest-host relies on, checked on the server itself, each with what to do if
// it isn't so. modest-host doesn't set the server up: it checks the setup is safe.

import { readFile } from "node:fs/promises";
import type { Run } from "./run.ts";

export type Finding = { ok: boolean; what: string; fix: string };

/** The ports that may listen to the outside: SSH, HTTP, and HTTPS. */
const OPEN = new Set([22, 80, 443]);

/** The address and port of each listening TCP socket that isn't this machine's own (from `ss -Hltn`). */
export function outsidePorts(ss: string): string[] {
  const found: string[] = [];
  for (const line of ss.split("\n")) {
    const local = line.trim().split(/\s+/)[3];
    if (!local) continue;
    const at = local.lastIndexOf(":");
    const address = local
      .slice(0, at)
      .replace(/^\[|\]$/g, "")
      .replace(/%\S+$/, "");
    const port = Number(local.slice(at + 1));
    const loopback = /^127\./.test(address) || address === "::1" || address === "::ffff:127.0.0.1" || /%lo\b/.test(local);
    if (!loopback && !OPEN.has(port)) found.push(local);
  }
  return found;
}

/** sshd's settings as it will use them (`sshd -T`), by lower-case name. */
const sshdSettings = (text: string) => new Map(text.split("\n").map((line) => [line.split(" ")[0] ?? "", line.slice(line.indexOf(" ") + 1).trim()]));

export async function checkServer(run: Run, read = (path: string) => readFile(path, "utf8")): Promise<Finding[]> {
  const findings: Finding[] = [];
  const add = (ok: boolean, what: string, fix: string) => findings.push({ ok, what, fix });
  const works = async (program: string, args: string[]) => (await run(program, args)).code === 0;

  const major = Number(process.versions.node.split(".")[0]);
  add(major >= 24, `Node 24 or later (this is ${process.versions.node})`, "install Node 24 or later, from NodeSource or nodejs.org");
  add(process.getuid?.() === 0, "running as root", "run it with sudo: it makes users, services, and Caddy sites");
  add(await works("systemctl", ["--version"]), "systemd", "modest-host needs a server that runs systemd, such as Ubuntu");
  add(await works("caddy", ["version"]), "Caddy installed", "install Caddy from its own package repository: see caddyserver.com/docs/install");
  add(await works("systemctl", ["is-active", "--quiet", "caddy"]), "Caddy running", "start it: systemctl enable --now caddy");
  for (const [program, args] of [
    ["git", ["--version"]],
    ["tar", ["--version"]],
    ["runuser", ["--version"]],
    ["ssh-keygen", ["-l", "-f", "/dev/null"]],
  ] as const) {
    const ran = await run(program, [...args]);
    add(
      ran.code === 0 || (program === "ssh-keygen" && !/not found|ENOENT/.test(ran.stderr)),
      `${program} installed`,
      `install it: apt install ${program === "ssh-keygen" ? "openssh-client" : program === "runuser" ? "util-linux" : program}`,
    );
  }

  const sshd = await run("sshd", ["-T"]);
  if (sshd.code !== 0) {
    add(false, "SSH's settings readable", "run it with sudo, on a server with OpenSSH's server (sshd -T has to work)");
  } else {
    const settings = sshdSettings(sshd.stdout);
    add(
      settings.get("passwordauthentication") === "no",
      "SSH: no sign-in by password",
      "set PasswordAuthentication no in /etc/ssh/sshd_config.d/, then systemctl reload ssh",
    );
    add(
      settings.get("kbdinteractiveauthentication") !== "yes",
      "SSH: no sign-in by typed answers",
      "set KbdInteractiveAuthentication no in /etc/ssh/sshd_config.d/, then systemctl reload ssh",
    );
    add(
      settings.get("permitrootlogin") === "no",
      "SSH: no sign-in as root",
      "sign in as your own user with sudo, then set PermitRootLogin no in /etc/ssh/sshd_config.d/ and systemctl reload ssh",
    );
  }

  const auto = await read("/etc/apt/apt.conf.d/20auto-upgrades").catch(() => "");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: dpkg-query's own format, not a template.
  const installed = (await run("dpkg-query", ["-W", "-f=${Status}", "unattended-upgrades"])).stdout.includes("install ok installed");
  add(
    installed && /APT::Periodic::Unattended-Upgrade\s+"1"/.test(auto),
    "automatic security updates",
    "apt install unattended-upgrades, then dpkg-reconfigure -plow unattended-upgrades and answer yes",
  );

  const ss = await run("ss", ["-Hltn"]);
  const extra = ss.code === 0 ? outsidePorts(ss.stdout) : null;
  add(
    extra !== null && extra.length === 0,
    "nothing listening to the outside but SSH, HTTP, and HTTPS",
    extra === null ? "ss (iproute2) is needed to see what's listening" : `stop, or listen only on 127.0.0.1: ${extra.join(", ")}`,
  );
  return findings;
}

/** Prints findings, and whether they all passed. */
export function report(findings: Finding[]): boolean {
  for (const f of findings) console.log(f.ok ? `  ok    ${f.what}` : `  FIX   ${f.what}: ${f.fix}`);
  return findings.every((f) => f.ok);
}
