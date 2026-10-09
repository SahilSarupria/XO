# Technology Stack

Every choice below, with the reasoning behind it. Where this module's
actual sandbox constraints (no package-registry access) forced a
different *verification* path than the *intended* production path, both
are stated explicitly — see "Sandbox note" callouts.

## Language & runtime: TypeScript on Node.js

- The XO format itself (manifest.json, metadata.json, knowledge graphs,
  decision trees) is JSON-shaped end to end. TypeScript's structural
  typing is a strong fit for validating and transforming JSON-shaped data
  without a schema-compiler step.
- One language across compiler, runtime, registry, SDK, and CLI means one
  set of interfaces (`packages/*-core`) can be shared by import, not
  reimplemented per service in a different language.
- Node's built-in test runner (`node:test`, stable since Node 18) and
  built-in `node:crypto`, `node:fs`, `node:path` cover everything this
  module needs without adding dependencies — see "Dependency minimalism"
  below.

Alternative considered: Go for the runtime (for lower memory footprint
under many concurrent mounted packages) with TypeScript for SDK/CLI only.
Rejected for *this* module because it would mean designing the
runtime-core interfaces twice (once per language) before any
implementation exists; revisit once `runtime-core` gets its first real
implementation and profiling shows Node is the bottleneck.

## Monorepo tooling: npm workspaces + TypeScript project references

- npm workspaces are built into npm ≥7 — zero additional tooling to
  install, which matters because this module was built and verified in
  a network-restricted sandbox (see Sandbox note below).
- TypeScript's `composite`/`references` project mode gives incremental,
  dependency-ordered builds (`tsc -b`) without a separate build
  orchestrator.

**Recommended upgrade path, not yet taken:** pnpm (stricter
`node_modules`, faster installs) + Turborepo (remote build caching) once
the package count and CI time justify it. Both are additive — neither
requires restructuring `packages/*`.

> **Sandbox note:** this module was built and self-verified in an
> environment with no npm registry access. Every package's actual source
> code depends only on Node built-ins so it could be typechecked
> (`tsc -b`, using a globally pre-installed TypeScript) and tested
> (`node:test`, via a globally pre-installed `tsx` loader —
> `scripts/sandbox-verify-tests.sh`) without `npm install`. Every
> package's `package.json` still declares the dependencies a real
> deployment should use (see below); `npm install` in a normal
> environment resolves them normally and `npm test`/`npm run build`
> (the scripts actually shipped) are the real entry points.

## Dependency minimalism (this module specifically)

Because of the sandbox constraint above, Module 1's actual runtime code
avoids third-party dependencies wherever a small amount of hand-written
code covers the need, and documents the production alternative inline:

| Concern | This module ships | Production alternative (swap behind the same interface) |
|---|---|---|
| Structured logging | `ConsoleLogger` (JSON to stdout) | `pino` — same `Logger` interface, add a transport |
| DI container | Hand-rolled `Container` (token + factory, no decorators) | Stays hand-rolled by design — see ADR 0003 |
| Config validation | Hand-rolled schema DSL | `zod`, if richer validation (unions, refinements) is needed |
| Tracing/metrics | `ConsoleTracer`/`ConsoleMeter` | OpenTelemetry SDK, same `Tracer`/`Meter` interface |
| CLI argument parsing | Hand-rolled `parseArgs` | `commander`/`clipanion`, once real subcommands with nested flags exist |
| Testing | `node:test` | Unchanged — this is a real, not provisional, choice; see below |

## Testing: Node's built-in test runner

`node:test` + `node:assert/strict` is stable, ships with Node, and needs
no configuration. Vitest/Jest offer richer matcher libraries and
watch-mode ergonomics; revisit if a package's test suite outgrows what
`node:test` comfortably expresses. This is a genuine choice, not just a
sandbox workaround — many production Node projects have moved to
`node:test` specifically to shed a dependency.

## Storage: Postgres, Redis, (optional) Neo4j

- **Postgres**: the registry's system of record (published packages,
  benchmark runs, license/royalty records) — relational data with real
  foreign-key relationships (a license references a package; a benchmark
  run references a package), which a document store handles awkwardly.
- **Redis**: caching + short-lived job coordination for the (future)
  registry API and runtime's retrieval layer.
- **Neo4j** (optional, `--profile graph` in `docker-compose.yml`): for
  XOs whose knowledge graph outgrows what `InMemoryGraphStore` should
  hold in a single process. Not required for Module 1 or for small/medium
  XOs — `packages/graph-engine`'s interface is backend-agnostic
  specifically so this stays optional.

No vector database is provisioned yet — nothing in this module does
semantic retrieval. Add one (pgvector as a first option, given Postgres
is already present) when `runtime-core`'s `Retriever` gets a real
implementation.

## Cryptography: Node's built-in `node:crypto`

SHA-256 hashing and Ed25519 signing/verification, both built in — see
`packages/crypto`. This is real, working cryptography, not a placeholder.
It is explicitly **not** a production key-custody solution: production
signing keys (a creator's or reviewer's private key, per
`PACKAGE_README.md` §4's `xo pack --sign-with`) must come from a KMS/HSM.
That integration is out of scope for this module.

## Containerization: Docker + Docker Compose

Standard, well-understood, and what most target deployment environments
(Kubernetes, ECS, Fly.io, etc.) consume directly. `docker-compose.yml`
provisions local Postgres/Redis (and optionally Neo4j) so every future
module has the same backing services from day one.

> **Sandbox note:** Docker itself was not exercised in the environment
> this module was built in (no Docker daemon / no network to pull
> images). The Dockerfile and compose file are written the same as they
> would be in a networked environment; a networked run of
> `docker compose up` / `docker build` is the actual verification step
> still owed before this file is trusted blindly in CI.

## CI: GitHub Actions

Matches where the repo's code review and PR workflow already lives
(`.github/`). `ci.yml` runs typecheck/lint/test/build on a two-version
Node matrix; `release.yml` uses Changesets to open/merge version-bump PRs
and publish.

## Versioning: Changesets

Per-package semantic versioning with an explicit, human-written changelog
entry per change (`npm run changeset`), which matches
`SPECIFICATION.md` §11's append-only versioning requirement at the
package level, not just the XO-package level. See `docs/VERSIONING.md`.
