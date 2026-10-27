# modest-deploy: agent guide

Deploy small Node apps to your own server: launch each with a command, deploy on every
push that passes CI. No dependencies. Read README.md for what it promises, and
docs/threat-model.md for how.

## Rules

1. **No runtime dependencies, ever.** Only Node's built-ins, and the programs already
   on the server (git, systemd, Caddy). Ask before adding even a development dependency.
2. **Nothing from outside becomes a command.** `execFile` with fixed argument lists,
   never a shell; check every outside value against a strict pattern first.
3. **Never weaken a default, and never add an option that could.** If a change makes
   anything in docs/threat-model.md less true, stop and ask.
4. **Every security property has a test.** Add one with each; show it fails without the change.
5. **Nothing about any one server in the repository:** no domain, address, key, or
   token. Use example.org and the documentation address ranges.
6. **No secrets in logs, errors, or test output.**
7. **Git:** commit each finished piece of work on its own; never push or publish unless
   asked. Never add a co-author line or any other attribution.
8. **Words:** British English, the serial (Oxford) comma, plain sentences, no em dashes.
   Comments explain why.

## Layout

| What | Where |
| --- | --- |
| The commands | `src/cli.ts` |
| What it says about itself: getting started, and a page for each command | `src/help.ts` |
| Checking GitHub's signed webhook messages | `src/webhook.ts` |
| The deploy listener: an HTTP server for those messages | `src/listener.ts` |
| Deploy requests, from the listener to the deploy service | `src/queue.ts` |
| Deploying: fetch, build, switch, check, go back | `src/deploy.ts` |
| install, add, remove, list, resize, and backup | `src/server.ts` |
| Each app's memory, and the server's own share | `src/memory.ts` |
| The server's checks | `src/check.ts` |
| launch, and list --server, from your computer | `src/launch.ts` |
| The systemd units and Caddy sites it writes | `src/units.ts` |
| Each app's settings | `src/apps.ts` |
| Where everything lives, and the users | `src/paths.ts` |
| Running programs (execFile, never a shell) | `src/run.ts` |
| Names, domains, repositories, and commits: the patterns they must match | `src/names.ts` |
| Tests, beside what they test; shared helpers | `src/*.test.ts`, `test/helpers.ts` |
| The end-to-end test, on Ubuntu with systemd in Docker | `test/e2e/` (`sh test/e2e/run.sh`) |
| The website (plain HTML on modest-ui), published by `pages.yml` | `site/` |
| What it protects, and how | `docs/threat-model.md` |
| What's being built, in order | `ROADMAP.md` |
| CI: checks, the no-dependency, import, and nothing-private rules; CodeQL, Scorecard | `.github/workflows/` |
| Repository settings and releasing | `docs/maintaining.md` |

## Commands

```sh
npm test            # node --test, TypeScript run directly
npm run typecheck   # tsc --noEmit (strict)
npm run build       # dist/ for publishing
npm run rules       # no dependencies, only node: imports, no hidden characters, nothing private
npx @biomejs/biome check .  # lint and format: keep it clean
npm run check       # all four
sh test/e2e/run.sh  # end to end, on Ubuntu with systemd (needs Docker)
```

## Style

As modest-auth: TypeScript that Node runs directly, erasable syntax only, `.ts` in
relative imports, `import type` for types, strict compiler settings. Small functions,
named for what they do; data in plain objects. Tests use `node:test` and
`node:assert/strict`, named as sentences that state the promise.

## Status

Early: 0.1.0 is the first release. Published to npm by the release workflow from a
version tag (see docs/maintaining.md); servers can also run it from a clone.
