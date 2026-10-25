# modest-host: agent guide

Host small Node products on one server: launch each with a command, deploy on every
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
| Checking GitHub's signed webhook messages | `src/webhook.ts` |
| The deploy listener: an HTTP server for those messages | `src/listener.ts` |
| Names, domains, repositories, and commits: the patterns they must match | `src/names.ts` |
| Tests, beside what they test | `src/*.test.ts` |
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
```

## Style

As modest-auth: TypeScript that Node runs directly, erasable syntax only, `.ts` in
relative imports, `import type` for types, strict compiler settings. Small functions,
named for what they do; data in plain objects. Tests use `node:test` and
`node:assert/strict`, named as sentences that state the promise.

## Status

In development, and `"private": true` in package.json until it's ready to publish.
