// The files modest-deploy writes for systemd and Caddy, as text. Every value in them has
// already been checked (names.ts), so none can add a line or a directive of its own.

import { type App, areRedirects } from "./apps.ts";
import { isMemory, type Machine, shares, threadPoolFor } from "./memory.ts";
import { isDomain, isName, isPort } from "./names.ts";
import { appUser, DEPLOY_UNIT, type Layout, LISTENER_PORT, LISTENER_USER } from "./paths.ts";

/** What systemd takes away from every service modest-deploy runs: whatever a Node server doesn't need. */
const SANDBOX = `NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
ProcSubset=pid
RestrictSUIDSGID=yes
RestrictRealtime=yes
RestrictNamespaces=yes
LockPersonality=yes
RemoveIPC=yes
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
UMask=0077`;

const safe = (app: App) => {
  if (!isName(app.name) || !isDomain(app.domain) || !areRedirects(app.redirects, app.domain) || !isPort(app.port) || !isMemory(app.memory))
    throw new Error("not an app");
  return app;
};

/**
 * An app: its own user, its own data folder, only its own port, and nothing of the
 * server's. Its memory is set aside for it (MemoryLow: the system leaves it be) and is
 * its ceiling (MemoryMax); its thread pool fits the machine's cores (memory.ts).
 */
export function appService(paths: Layout, app: App, node: string, machine: Machine): string {
  const { name, domain, port, memory } = safe(app);
  const user = appUser(name);
  return `# Written by modest-deploy: changes here are replaced.
[Unit]
Description=modest-deploy: ${name} (${domain})
After=network-online.target
Wants=network-online.target
# An app that keeps failing is restarted more and more slowly, but never given up on.
StartLimitIntervalSec=0

[Service]
Type=simple
User=${user}
Group=${user}
WorkingDirectory=${paths.current(name)}
ExecStart=${node} server.js
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=${port}
Environment=DATA_DIR=${paths.data(name)}
Environment=UV_THREADPOOL_SIZE=${threadPoolFor(machine)}
EnvironmentFile=-${paths.env(name)}
StateDirectory=modest-deploy/${name}
StateDirectoryMode=0700
Restart=always
RestartSec=2
RestartSteps=10
RestartMaxDelaySec=60
${SANDBOX}
SocketBindAllow=tcp:${port}
SocketBindDeny=any
InaccessiblePaths=-${paths.apps} -${paths.secrets} -${paths.keys} -${paths.envs} -${paths.allBackups} -${paths.spool}
MemoryMax=${memory}M
MemoryLow=${memory}M
TasksMax=256
LimitNOFILE=4096

[Install]
WantedBy=multi-user.target
`;
}

/** The listener: reads apps' settings and secrets, writes deploy requests, and nothing else. */
export function listenerService(paths: Layout, node: string, cli: string): string {
  return `# Written by modest-deploy: changes here are replaced.
[Unit]
Description=modest-deploy: the deploy listener
After=network-online.target

[Service]
Type=simple
User=${LISTENER_USER}
Group=${LISTENER_USER}
ExecStart=${node} ${cli} listen
Restart=always
RestartSec=2
${SANDBOX}
ReadWritePaths=${paths.spool}
InaccessiblePaths=-${paths.keys} -${paths.envs} -${paths.allBackups} -${paths.allData} -${paths.allCode}
SocketBindAllow=tcp:${LISTENER_PORT}
SocketBindDeny=any
IPAddressAllow=localhost
IPAddressDeny=any
MemoryMax=128M
TasksMax=64

[Install]
WantedBy=multi-user.target
`;
}

/** The deploy service: started by systemd whenever a request is waiting, as root (it has to own and restart apps). */
export function deployService(node: string, cli: string, machine: Machine): string {
  return `# Written by modest-deploy: changes here are replaced.
[Unit]
Description=modest-deploy: deploy what's been asked for
# Started each time a request arrives: however many arrive at once, it's never refused.
StartLimitIntervalSec=0

[Service]
Type=oneshot
ExecStart=${node} ${cli} work
# Each step has its own time limit (git and npm 10 minutes, the check a minute), so the whole has none:
# a deploy is never cut off between switching and checking.
TimeoutStartSec=infinity
# Its share of what the server keeps for itself (memory.ts): a build never takes an app's.
MemoryMax=${shares(machine).deploy}M
PrivateDevices=yes
ProtectSystem=full
PrivateTmp=yes
ProtectHome=yes
ProtectKernelModules=yes
ProtectKernelTunables=yes
ProtectClock=yes
LockPersonality=yes
`;
}

export function deployPath(paths: Layout): string {
  return `# Written by modest-deploy: changes here are replaced.
[Unit]
Description=modest-deploy: deploy when asked

[Path]
DirectoryNotEmpty=${paths.requests}
Unit=${DEPLOY_UNIT}

[Install]
WantedBy=paths.target
`;
}

export function backupService(node: string, cli: string): string {
  return `# Written by modest-deploy: changes here are replaced.
[Unit]
Description=modest-deploy: copy every app's databases

[Service]
Type=oneshot
ExecStart=${node} ${cli} backup-now
PrivateDevices=yes
ProtectSystem=full
PrivateTmp=yes
ProtectHome=yes
`;
}

export const BACKUP_TIMER = `# Written by modest-deploy: changes here are replaced.
[Unit]
Description=modest-deploy: copy every app's databases, nightly

[Timer]
OnCalendar=*-*-* 03:15
RandomizedDelaySec=30min
Persistent=true

[Install]
WantedBy=timers.target
`;

/**
 * An app's site: HTTPS for its domain (Caddy gets the certificate), passed to its port.
 * Each redirect goes to the same path on that domain, which it names itself, so a request
 * can't choose where it's sent; and never reaches the app.
 */
export function appSite(app: App): string {
  const { domain, redirects, port } = safe(app);
  const redirect = (from: string) => `\n${from} {\n\tredir https://${domain}{uri} permanent\n}\n`;
  return `# Written by modest-deploy: changes here are replaced.
${domain} {
\treverse_proxy 127.0.0.1:${port}
}
${redirects.map(redirect).join("")}`;
}

/** The deploy domain: only /deploy/<app> reaches the listener, and only small bodies. */
export function hostSite(domain: string): string {
  if (!isDomain(domain)) throw new Error("not a domain");
  return `# Written by modest-deploy: changes here are replaced.
${domain} {
\trequest_body {
\t\tmax_size 1MB
\t}
\thandle /deploy/* {
\t\treverse_proxy 127.0.0.1:${LISTENER_PORT}
\t}
\trespond 404
}
`;
}

/** The line added to Caddy's own Caddyfile, so it reads modest-deploy's sites. */
export const caddyImport = (paths: Layout) => `import ${paths.caddy}/*.caddy`;
