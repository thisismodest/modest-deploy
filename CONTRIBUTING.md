# Contributing

Thank you for helping. modest-deploy stays safe by staying small, so the most useful
contributions often take something away, and every addition is held to the rules
below.

**Found a security problem?** Don't open an issue: see [SECURITY.md](SECURITY.md).

## Before you write code

Open an issue first for anything beyond a small fix, and say:

- **what it's for:** the problem, for a real app or server;
- **the smallest version** that solves it;
- **what it changes in [the threat model](docs/threat-model.md):** what new could go
  wrong, and what would stop it.

## The rules every change follows

1. **No runtime dependencies.** Only Node's built-in modules, and the programs already
   on the server (git, systemd, Caddy). CI fails otherwise.
2. **Nothing from outside becomes a command.** Programs run with `execFile` and fixed
   argument lists, never a shell, and anything from a message, a name, or a domain is
   checked against a strict pattern before it's used.
3. **No options that change how safe it is.** If there's a safest way, it's the only way.
4. **A test for every security property**, named for what it promises, and failing if
   the promise breaks. Show it failing without your fix.
5. **Nothing about any one server** in the repository: no domain, address, key, or token.
6. **Plain, typed TypeScript** that Node runs directly: erasable syntax only, strict
   settings, relative imports with `.ts`.
7. **Comments say why,** in plain English. Docs are written for someone in a hurry: short
   sentences, no jargon left unexplained, British spelling, and the serial comma.

## Working on it

Node 26 (24 or later works).

```sh
npm ci            # development tools only; install scripts are off (.npmrc)
npm test          # the tests
npm run typecheck
npm run build     # dist/, as it would be published
npm run rules     # no dependencies, only Node's modules, no hidden characters, nothing private
npx @biomejs/biome check .   # lint and format (biome.json), with nothing installed
npm run check     # all four, as CI runs them
sh test/e2e/run.sh   # end to end, on Ubuntu with systemd in Docker
```

Changes to how anything runs on the server should pass the end-to-end test too.

## Pull requests

- One change per pull request, with its tests.
- Describe what it does and what it changes in the threat model.
- `npm run check` passes.

By contributing, you agree your work is released under the [MIT License](LICENSE).
