# Contributing

Thank you for your interest in Prisma Memory.

**We do not accept code from third-party developers.** Pull requests that change the code are not reviewed and will
be closed. Prisma Memory is developed and fixed only by our team.

## How you can help

- **Report a bug** — open an issue: describe what happened, what you expected and how to reproduce it.
- **Suggest an improvement** — open an issue or start a discussion.
- **Ask a question** about installation and use — start a discussion.

We fix reported bugs ourselves and release the fixes in later versions.

## What this repository holds

The repository holds the source of the product and what installing it needs. The test suites, the test data and the
maintainers' tools are not part of it. `pnpm install` and `pnpm -r typecheck` work in a clone. Scripts of the
`package.json` files that run tests or maintainer tools need files that are not here and fail: `pnpm test` and the
`test` script of each package, `db:test`, `db:introspect:check`, `wire:gen`, `edge:build`, `edge:check` and the
`introspect` scripts of `packages/db`.

## Security vulnerabilities

Do not report them in public issues. See `SECURITY.md`.

## Connectors and integrations

You may build your own connectors and integrations that work with Prisma Memory through its published interfaces
(API, MCP). If such a program does not include Prisma Memory code, it is not a Derivative and may be distributed on
any terms (clause 1.10 of the licence).

## Name

Do not use "Prisma Memory" in the names of your projects. You may say "for Prisma Memory" or "works with Prisma Memory".
