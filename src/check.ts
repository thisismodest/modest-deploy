// What modest-host relies on, checked on the server itself, each with what to do if
// it isn't so. modest-host doesn't set the server up: it checks the setup is safe.

import { readFile } from "node:fs/promises";
import type { Run } from "./run.ts";

export type Finding = { ok: boolean; what: string; fix: string };

/** The ports that may listen to the outside: SSH, HTTP, and HTTPS. */
const OPEN = new Set([22, 80, 443]);
/** And over UDP: HTTP/3, and the DHCP clients a server's network may use. */
const OPEN_UDP = new Set([443, 68, 546]);

/** The address and port of each listening socket that isn't this machine's own (from `ss -Hltn` or `ss -Hlun`). */
export function outsidePorts(ss: string, open: Set<number> = OPEN): string[] {
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
    if (!loopback && !open.has(port)) found.push(local);
  }
  return found;
}

/** sshd's settings as it will use them (`sshd -T`), by lower-case name. */
const sshdSettings = (text: string) => new Map(text.split("\n").map((line) => [line.split(" ")[0] ?? "", line.slice(line.indexOf(" ") + 1).trim()]));

export async function checkServer(run: Run, read = (path: string) => readFile(path, "utf8"), cli?: string): Promise<Finding[]> {
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

  // As sshd treats a connection from a public and a private address, for root and for
  // everyone who can sign in, so a Match block that allows more for some is found.
  const people = (await run("getent", ["passwd"])).stdout
    .split("\n")
    .map((line) => line.split(":"))
    .filter((f) => Number(f[2]) >= 1000 && !/nologin|false$/.test(f[6] ?? "") && /^[a-z_][a-z0-9_-]*$/.test(f[0] ?? ""))
    .map((f) => f[0] ?? "")
    .slice(0, 50);
  const as = (user: string, addr: string) => run("sshd", ["-T", "-C", `user=${user},host=outside.example,addr=${addr}`]);
  const views: { user: string; text: string }[] = [];
  let readable = true;
  for (const user of ["root", "nobody", ...people]) {
    for (const addr of ["192.0.2.1", "10.0.0.1"]) {
      const seen = await as(user, addr);
      if (seen.code !== 0) readable = false;
      views.push({ user, text: seen.stdout });
    }
  }
  let sshPorts = [22];
  if (!readable) {
    add(false, "SSH's settings readable", "run it with sudo, on a server with OpenSSH's server (sshd -T has to work)");
  } else {
    sshPorts = [...(views[0]?.text ?? "").matchAll(/^port (\d+)$/gm)].map((m) => Number(m[1]));
    const allow = (key: string, bad: (value: string | undefined) => boolean, users = views) =>
      users.filter((v) => bad(sshdSettings(v.text).get(key))).map((v) => v.user);
    const passwords = [...new Set(allow("passwordauthentication", (v) => v !== "no"))];
    add(
      passwords.length === 0,
      "SSH: no sign-in by password",
      `set PasswordAuthentication no in /etc/ssh/sshd_config.d/ (and in any Match block; it's allowed for ${passwords.join(", ")}), then systemctl reload ssh`,
    );
    const typed = [...new Set(allow("kbdinteractiveauthentication", (v) => v === "yes"))];
    add(
      typed.length === 0,
      "SSH: no sign-in by typed answers",
      "set KbdInteractiveAuthentication no in /etc/ssh/sshd_config.d/ (and in any Match block), then systemctl reload ssh",
    );
    const root = allow(
      "permitrootlogin",
      (v) => v !== "no",
      views.filter((v) => v.user === "root"),
    );
    add(
      root.length === 0,
      "SSH: no sign-in as root",
      "sign in as your own user with sudo, then set PermitRootLogin no in /etc/ssh/sshd_config.d/ and systemctl reload ssh",
    );
  }

  // apt-config reads every file in /etc/apt/apt.conf.d, whichever one turns them on.
  const periodic =
    (await run("apt-config", ["dump", "APT::Periodic::Unattended-Upgrade"])).stdout || (await read("/etc/apt/apt.conf.d/20auto-upgrades").catch(() => ""));
  // biome-ignore lint/suspicious/noTemplateCurlyInString: dpkg-query's own format, not a template.
  const installed = (await run("dpkg-query", ["-W", "-f=${Status}", "unattended-upgrades"])).stdout.includes("install ok installed");
  add(
    installed && /APT::Periodic::Unattended-Upgrade\s+"1"/.test(periodic),
    "automatic security updates",
    "apt install unattended-upgrades, then dpkg-reconfigure -plow unattended-upgrades and answer yes",
  );

  const tcp = await run("ss", ["-Hltn"]);
  const udp = await run("ss", ["-Hlun"]);
  const extra =
    tcp.code === 0 && udp.code === 0
      ? [...outsidePorts(tcp.stdout, new Set([...OPEN, ...sshPorts])), ...outsidePorts(udp.stdout, OPEN_UDP).map((l) => `${l} (UDP)`)]
      : null;
  add(
    extra !== null && extra.length === 0,
    "nothing listening to the outside but SSH, HTTP, and HTTPS",
    extra === null ? "ss (iproute2) is needed to see what's listening" : `stop, or listen only on 127.0.0.1: ${extra.join(", ")}`,
  );

  // The services run as users of their own, so Node and modest-host must be readable by others (not under /root, nor installed with a strict umask).
  if (cli) {
    const readable = await run(process.execPath, [cli, "help"], { as: "nobody" });
    add(
      readable.code === 0,
      "Node and modest-host readable by its services",
      `install Node system-wide (not with nvm in a home folder), and modest-host with npm install -g under umask 022: ${process.execPath}, ${cli}`,
    );
  }
  return findings;
}

/** Prints findings, and whether they all passed. */
export function report(findings: Finding[]): boolean {
  for (const f of findings) console.log(f.ok ? `  ok    ${f.what}` : `  FIX   ${f.what}: ${f.fix}`);
  return findings.every((f) => f.ok);
}
