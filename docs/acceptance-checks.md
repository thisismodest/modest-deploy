# Acceptance checks: each protection, confirmed

Checks that each protection in docs/threat-model.md, and each promise in README.md's
"What it does" and "What a product does", holds. Written by an independent reviewer from
those two documents alone, without seeing the code, and tested end to end (`test/e2e/`).
**[PRIORITY]** marks the ones the reviewer thought most valuable. The setup, unless said:
installed, with product "alpha" (and "beta" where needed) added, from a local repository.

## Threat model: How

**A forged deploy message**
1. **[PRIORITY]** A valid `workflow_run` body signed with alpha's secret deploys. One byte changed, the signature kept: nothing deploys; the release is unchanged.
2. **[PRIORITY]** No signature, an empty one, a wrong-length one, a SHA-1 one: all refused, no deploy.
3. Alpha's message signed with beta's secret, sent to alpha's path: refused.
4. Malformed JSON with a wrong signature, and valid JSON with a wrong signature: the same answer, and no JSON error in the logs (refused before parsing).

**A message that isn't a passed CI run on `main`**
5. **[PRIORITY]** Correctly signed, one per case: a `push` event; `conclusion: failure`; `action: requested` or `in_progress`; head branch `dev`; another workflow; another repository's `full_name`; `event: pull_request`. None deploys.

**An old message sent again**
6. **[PRIORITY]** Commit A deployed, then B. A's signed message again (a new delivery id): B stays live.
7. A signed message for B while main's tip is C: B isn't deployed.

**A captured delivery sent again**
8. A delivery already acted on, sent again exactly: no second deploy or restart.
9. Commit D fails its health check; D's message again with a new delivery id: not tried again; `modest-deploy deploy alpha` by hand does try it.

**A huge or slow request to the listener**
10. **[PRIORITY]** A signed body of 1MB and a byte: refused, no deploy; just under 1MB is handled.
11. Headers sent, then the body a byte at a time: closed within a bounded time; other requests still answered meanwhile.

**Finding which products a server has**
12. **[PRIORITY]** POST to `/deploy/nosuch`, and to `/deploy/alpha` with a wrong signature: status, headers (but Date), and body byte-identical.

**A message that names something to run**
13. Signed messages with a `head_sha` of 39 or 41 characters, upper-case hex, `$(touch /tmp/x)`, or `--upload-pack=…`, and shell characters in repository or branch: none deploys; no stray file appears.

**The listener**
16. A request file naming an unknown product, and one with a bad commit: the deploy service starts and does nothing.

**A product reaching another, or the server**
17. **[PRIORITY]** Alpha's code can't read beta's environment file, data, or code, `/root`, SSH host keys, deploy keys, webhook secrets, or `/etc/shadow`.
18. **[PRIORITY]** Alpha's code can't write its own code, `/etc`, `/usr`, `/var/tmp`, or beta's data; it can write `DATA_DIR`; its `/tmp` isn't beta's or the host's.
19. From alpha: `ps` and `/proc` show none of beta's processes; `sudo` and `su` fail; its capability sets are empty.
20. Alpha allocating without limit is stopped at its memory limit; beta and the host stay up.
21. Alpha's code is owned by root and readable by alpha's user; not by beta's user or the build user.

**A package's install script**
22. **[PRIORITY]** A local dependency whose `preinstall`/`postinstall` writes a marker: the deploy succeeds; no marker.
23. A `package.json` out of step with its lockfile: the deploy fails; the previous version keeps running.

**A repository's own settings choosing what npm or git runs**
24. **[PRIORITY]** An `.npmrc` setting `git=…`, `script-shell`, `ignore-scripts=false`, and a custom registry, with a git dependency: no script runs; the registry setting is ignored.
25. A `.gitattributes` filter or driver, and a `.gitmodules` with an odd URL: nothing they name runs.

**A bad deploy**
26. **[PRIORITY]** A version that crashes at start, one that never answers `GET /`, one that answers 500: each time, the previous version serves again.

**A product taking another port** (Ubuntu 26.04)
28. **[PRIORITY]** Alpha's code binding beta's port (beta stopped), 8080 on 0.0.0.0, or UDP: each fails with EPERM; its own `PORT` works.

**A product reachable without Caddy**
29. **[PRIORITY]** A version listening on 0.0.0.0, and one on `::`: neither stays live.
30. Alpha opening a listener at runtime, outside a deploy: `check` and the nightly run report it.

**A build reaching another product's key or source**
31. As alpha's build user: beta's deploy key and repository copy can't be read; its own can.

**A build that ran code of its own lasting, or racing root**
32. A background process left running as the build user: none remains after the deploy step.
33. Files planted in the build user's home, a git hook, `core.fsmonitor` or `core.sshCommand` in its repository copy, an `~/.ssh/config`: on the next deploy none runs, and the home is empty.

**Something left in the deploy queue**
35. A FIFO, a link to `/etc/shadow`, a directory, and a 10MB file in the requests folder: each removed unread; a valid request after still deploys.

**A pushed commit filling the shared disk**
36. **[PRIORITY]** A release installing to over 1GB, and one with 200,001 files: both refused, with no partial copy left.
37. On a small filesystem (a tmpfs), a release that would leave under 1GB free: refused.

**A release tricking root into reading something else**
38. `package.json` as a link to `/etc/shadow`, as a FIFO, or as a 50MB file: each refused; root's output never holds the target.
39. The deploy unit has `MemoryMax=1G` and no devices.

**Redirect domains**
40. **[PRIORITY]** A redirect that's beta's domain, beta's redirect, the deploy domain, or not a domain (`a b`, `x/../y`, `*.x`): each refused.
41. A redirect domain requested with an odd Host, path, or query: always a redirect to alpha's own domain, the same path; alpha never sees it.
42. More redirects than the maximum: refused.

**A key or address committed to the repository**
44. The repository's rules run against fixtures: a public IPv4 and IPv6 address, a PEM private key, a GitHub token, and a 64-hex secret each fail; the example ranges pass.

**An unsafe server**
45. **[PRIORITY]** Each of `PasswordAuthentication yes`, `PermitRootLogin yes`, root allowed in a `Match Address` for an outside address, unattended-upgrades off, an extra TCP listener, an extra UDP listener, and Node 22: `check` fails with the fix, and `install` and `add` refuse.
46. The same with `--anyway`: they go on.

**A server pretending to be GitHub**
47. github.com's SSH answered with another host key: the fetch fails; `known_hosts` unchanged.

**Backups**
48. **[PRIORITY]** Alpha's `app.db` a link to beta's database or `/etc/shadow`: refused; no copy holds the target.
49. Backup files are root's, mode 600 or tighter; alpha's user can't read them.
50. A corrupt database: the nightly run fails; no partial copy under the final name.
51. Too little disk: no copy, the run fails. Two runs at once: the second waits or refuses.
52. (With the clock moved on) after 8 nights, 7 copies remain.

**A burst of deploy requests**
53. 50 valid requests for alpha in a second: the deploy service never hits its start limit; main's tip ends up live.

## README: What it does

54. Install: the listener, Caddy's sites folder, the backup timer, and their units are present and enabled; `install` again rewrites every unit, products' included, with nothing duplicated.
55. `check` reports Node and modest-deploy readable by the services' users; with the install path mode 700 root, it fails.
56. Add or launch's server half: a system user, a folder, an environment file (mode 600, the product's), a unit, and a Caddy site with the domain, which Caddy accepts.
57. A domain another product uses: refused.
58. A product that keeps crashing restarts with growing delays.
59. Products' output is in `journalctl -u modest-deploy-<name>`; no secret in the deploy logs.
60. `deploy` by hand: main's tip, with no CI message at all.

## README: What a product does

61. **[PRIORITY]** The app gets `PORT`, `HOST=127.0.0.1`, and `DATA_DIR`; nothing reaches its port but from this machine.
62. An app with no `server.js`, or one never answering `GET /`, isn't deployed.

Left out, as not needed: the listener's unit settings, read back from a running server
(`src/commands.test.ts` checks the unit it writes), a disk filling just after a switch
(#26's rollbacks cover a bad version), a hard link in a release (git can't commit one), and `launch` refusing a bad
answer from the server (covered by `src/commands.test.ts`, as it needs GitHub).

## Promises the reviewer found ambiguous

- GitHub's host keys "nothing else is accepted" conflicts with fetching from test repositories: the test needs a documented seam, or a fake github.com, so it doesn't weaken the check it tests.
- `SocketBindDeny` needs Ubuntu 26.04, cgroup v2, and BPF in the container, or check 28 proves nothing.
- No figures for "slow requests are cut off", "a few redirects", "a memory limit", "checks it answers" (timeout, which statuses), or "more slowly each time".
- Constant-time comparison isn't observable end to end: a unit test or review is the check.
- Delivery ids: the README says acted-on deliveries are ignored; the threat model calls it a convenience. Safety shouldn't rest on it.
- "The product's own repository and its CI workflow": by `full_name`, repository id, or workflow path? A renamed repository or workflow is untested.
- "One listening anywhere else isn't deployed" (README) and "switched back" (threat model) differ; neither says what happens with both 127.0.0.1 and 0.0.0.0, or `::1`.
- Whether "1GB" is 10^9 or 2^30 bytes, and counted before or after `npm ci`.
- "Secrets and keys out of reach" has no list of paths.
- "No workflow can read the webhook secret" is a fact about GitHub, outside the container.
- Real certificates can't be had in the container: issuance and renewal need a staging ACME server, or are skipped.
