# Module 1 — Delivery Report

Foundation-only build for the XO Platform monorepo, per the frozen specs
(`SPECIFICATION.md`, `XO_PROTOCOL.md`, `EXPERIENCE_COMPILER.md`,
`RUNTIME_ARCHITECTURE.md`). No compiler, runtime, or registry business
logic is implemented — see `docs/ARCHITECTURE.md` for how this maps to
the intended end-to-end flow.

## Verification status

- **Build**: `tsc -b tsconfig.json` — clean, zero errors, across all 15
  packages + the CLI.
- **Tests**: 70/70 passing across every package (`node:test`), including
  the CLI binary itself, which was also smoke-tested end-to-end
  (`xo --help`, `version`, `doctor`, `config show`, and an unknown-command
  exit code).
- **Not verified**: `docker compose up` / `docker build` — the sandbox
  this was built in had no Docker daemon and no network. See
  `docs/TECH_STACK.md`'s "Sandbox note" under Containerization for what's
  owed before trusting the Docker setup blindly.
- **Known limitation baked into the build itself**: this sandbox had no
  npm registry access, so nothing here was verified via `npm install`.
  Every package's actual code depends only on Node built-ins so it could
  be typechecked and tested anyway; each `package.json` still declares
  the real production dependencies a networked environment would install.
  This is explained in full in `docs/TECH_STACK.md`.

## Every file, and why it exists

### Root tooling

| File | Why |
|---|---|
| `package.json` | npm workspaces root; scripts (`build`, `test`, `lint`, `typecheck`, changesets) that fan out to every package |
| `tsconfig.base.json` | Shared strict compiler options every package's `tsconfig.json` extends |
| `tsconfig.json` | Root composite project — lists every package as a `references` entry so `tsc -b` builds them in dependency order |
| `.gitignore` | Excludes `node_modules`, `dist`, build artifacts, `.env` |
| `.editorconfig` | Consistent whitespace/line-ending rules across editors |
| `.nvmrc` | Pins the Node version contributors/CI should use |
| `.npmrc` | `engine-strict=true` so npm refuses to install on the wrong Node version |
| `.prettierrc.json` / `.prettierignore` | Formatting rules and exclusions |
| `eslint.config.mjs` | Flat ESLint 9 config: TypeScript rules, `consistent-type-imports`, `eqeqeq` |
| `.dockerignore` | Keeps `node_modules`/`dist`/`.git` out of Docker build context |
| `Dockerfile` | Multi-stage (deps/build/test) image; every future module's own image builds `FROM` this |
| `docker-compose.yml` | Local Postgres + Redis (+ optional Neo4j via `--profile graph`) — see ADR 0006 |
| `LICENSE` | Apache 2.0 |
| `README.md` | Repo orientation: what Module 1 is, layout, how to work in it |
| `CONTRIBUTING.md` | PR checklist, how to add a package, coding-standards pointer |
| `CODEOWNERS` | Default review ownership |
| `.devcontainer/devcontainer.json` | VS Code Dev Containers config, builds off the `deps` Docker stage |
| `.github/workflows/ci.yml` | Lint/typecheck/test/build on a 2-version Node matrix, every push/PR |
| `.github/workflows/release.yml` | Changesets-driven version-PR + publish |
| `.github/pull_request_template.md` | PR checklist (typecheck/test/lint/changeset) |
| `.husky/pre-commit` | Runs `lint-staged` before every commit |
| `.changeset/config.json`, `.changeset/README.md` | Changesets configuration and contributor instructions |
| `scripts/gen-pkg.sh` | Internal scaffolding helper used while building this module (generates a package's `package.json`/`tsconfig.json` boilerplate) — kept for scaffolding the *next* package, not invoked by any shipped script |
| `scripts/sandbox-verify-tests.sh` | Sandbox-only test runner (see Verification status above) — explicitly documented as not part of the real dev workflow |

### Documentation (`docs/`)

| File | Why |
|---|---|
| `ARCHITECTURE.md` | Maps this repo's packages to the frozen design docs' concepts and the intended end-to-end pipeline |
| `TECH_STACK.md` | Every technology decision (language, monorepo tooling, testing, storage, crypto, containerization, CI, versioning) with rejected alternatives and sandbox caveats |
| `CODING_STANDARDS.md` | `Result` vs. `throw`, naming, DDD boundaries, testing conventions, import/dependency rules |
| `VERSIONING.md` | How this repo's packages version (Changesets) vs. how an XO's own `manifest.json` version is governed (`SPECIFICATION.md` §11, out of scope here) |
| `adr/0001-monorepo-and-package-manager.md` | Why npm workspaces + TS project references, not pnpm/Turborepo yet |
| `adr/0002-language-and-runtime.md` | Why TypeScript/Node over Go/Python for this module |
| `adr/0003-dependency-injection.md` | Why a hand-rolled DI container over tsyringe/InversifyJS |
| `adr/0004-observability.md` | Why vendor-neutral Logger/Tracer/Meter interfaces with console implementations for now |
| `adr/0005-testing-strategy.md` | Why `node:test` + contract tests for the interface-only packages |
| `adr/0006-storage-and-databases.md` | Why Postgres/Redis/(optional Neo4j) plus local-fs/in-memory reference implementations |

### `packages/types` — shared types, no dependencies

| File | Why |
|---|---|
| `src/result.ts` | `Result<T,E>` — the platform-wide non-throwing error-handling type |
| `src/brand.ts` | Nominal/branded typing helper so IDs aren't structurally interchangeable |
| `src/ids.ts` | Branded `PackageId`, `CreatorDid`, `BenchmarkRunId`, `LicenseId`, `ContentHash` (with runtime format validation) |
| `src/compatibility.ts` | `CompatibilityLevel`/`ModelFamily`/`ComponentKind` types matching `SPECIFICATION.md` §2.2 |
| `src/xo-manifest.ts` | Typed shape of an XO's `manifest.json` |
| `src/xo-metadata.ts` | Typed shape of an XO's `metadata.json` |
| `src/index.ts` | Public barrel export |
| `test/result.test.ts` | Covers `ok`/`err`/`isOk`/`isErr`/`unwrap`/`mapResult`/`fromPromise` |

### `packages/errors` — error hierarchy

| File | Why |
|---|---|
| `src/error-codes.ts` | Stable, append-only `ErrorCode` strings — part of the platform's public contract |
| `src/base-error.ts` | `XoError` base class: carries a code, structured context, JSON serialization |
| `src/domain-errors.ts` | Concrete subclasses (`NotFoundError`, `InvalidArgumentError`, `ConfigError`, `CryptoError`, `StorageError`, `DiError`, `SerializationError`, `UnimplementedError`) |
| `src/assert.ts` | `assert()`/`assertUnreachable()` for programmer-error invariants (distinct from `Result`) |
| `src/index.ts` | Barrel export |
| `test/errors.test.ts` | Codes, JSON shape, cause-chaining, assert behavior |

### `packages/logger` — structured logging

| File | Why |
|---|---|
| `src/logger.interface.ts` | `Logger` port: leveled, structured, `child()`-capable |
| `src/console-logger.ts` | Zero-dependency JSON-to-stdout implementation (the default everywhere) |
| `src/noop-logger.ts` | Discards everything — library/test default |
| `src/index.ts` | Barrel export |
| `test/console-logger.test.ts` | Level filtering, `child()` field merging/overriding, noop safety |

### `packages/config` — environment configuration

| File | Why |
|---|---|
| `src/schema.ts` | Minimal, dependency-free schema DSL (`string`/`number`/`boolean`/`enum` fields) |
| `src/env.ts` | camelCase-key -> `XO_SNAKE_CASE` env-var-name convention |
| `src/config-loader.ts` | `loadConfig()` (validates + coerces + applies defaults, throws on bad boot config) and `describeConfig()` (secret-masking renderer for `xo config show`) |
| `src/index.ts` | Barrel export |
| `test/config-loader.test.ts` | Defaults, coercion, range/enum validation, required-key errors, secret masking |

### `packages/observability` — tracing/metrics

| File | Why |
|---|---|
| `src/tracer.interface.ts` | `Tracer`/`Span` modeled on OpenTelemetry's shape |
| `src/meter.interface.ts` | `Meter`/`Counter`/`Histogram` |
| `src/console-exporter.ts` | `ConsoleTracer`/`ConsoleMeter` — logs spans/metrics through the injected `Logger` |
| `src/noop.ts` | No-op tracer/meter for tests |
| `src/index.ts` | Barrel export |
| `test/observability.test.ts` | Span success/error status recording, counter/histogram logging, noop safety |

### `packages/di` — dependency injection

| File | Why |
|---|---|
| `src/tokens.ts` | `Token<T>`/`createToken()` — type-carrying symbols for registration |
| `src/container.ts` | `Container`: singleton/transient scopes, circular-dependency detection, `createChild()` scoping |
| `src/index.ts` | Barrel export |
| `test/container.test.ts` | Singleton identity, transient re-creation, missing-token error, cycle detection, child-container fallback/shadowing |

### `packages/serialization` — versioned codecs

| File | Why |
|---|---|
| `src/codec.interface.ts` | `Codec<T>` — the single trusted-data <-> bytes boundary |
| `src/json-codec.ts` | `jsonCodec()` — JSON encode/decode with an optional runtime shape validator |
| `src/versioned-envelope.ts` | `wrapEnvelope`/`unwrapEnvelope` — schema-versioned persistence wrapper |
| `src/index.ts` | Barrel export |
| `test/json-codec.test.ts` | Round-trip, malformed JSON, failed validation, envelope version mismatch |

### `packages/testing` — shared test doubles

| File | Why |
|---|---|
| `src/mock-logger.ts` | `MockLogger` — captures log calls for assertions (vs. `noopLogger`'s pure discard) |
| `src/mock-clock.ts` | `Clock`/`SystemClock`/`MockClock` — deterministic time control for tests |
| `src/fixtures.ts` | `loadJsonFixture()` — loads a JSON fixture relative to the calling test file |
| `src/index.ts` | Barrel export |
| `test/testing.test.ts` | Verifies the test doubles themselves behave correctly |

### `packages/crypto` — hashing and signing

| File | Why |
|---|---|
| `src/hasher.interface.ts` | `Hasher` port |
| `src/sha256-hasher.ts` | `Sha256Hasher` (Node `crypto`) + `buildMerkleRoot()` matching `PACKAGE_README.md` §4's `xo pack` hashing step |
| `src/signer.interface.ts` | `Signer`/`Verifier`/`KeyPair` ports |
| `src/ed25519-signer.ts` | Real Ed25519 sign/verify via Node `crypto` — explicitly documented as *not* a production key-custody solution |
| `src/index.ts` | Barrel export |
| `test/crypto.test.ts` | Hash stability/sensitivity, Merkle-root determinism and order-sensitivity, signature verify/tamper/wrong-key cases |

### `packages/storage` — blob storage

| File | Why |
|---|---|
| `src/blob-store.interface.ts` | `BlobStore` port for XO package components |
| `src/local-fs-blob-store.ts` | Real filesystem-backed implementation, with path-traversal protection |
| `src/index.ts` | Barrel export |
| `test/local-fs-blob-store.test.ts` | Put/get round-trip, nested-directory creation, missing-key error, delete, prefix listing, traversal rejection |

### `packages/graph-engine` — knowledge graph

| File | Why |
|---|---|
| `src/node.ts` / `src/edge.ts` | `GraphNode`/`GraphEdge` shapes |
| `src/graph-store.interface.ts` | `GraphStore` port |
| `src/in-memory-graph-store.ts` | Real in-memory implementation with an adjacency index |
| `src/index.ts` | Barrel export |
| `test/in-memory-graph-store.test.ts` | Node/edge CRUD, missing-endpoint rejection, neighbor traversal (filtered/unfiltered), type queries, counts |

### `packages/compiler-core`, `runtime-core`, `registry-core` — interfaces only

| File | Why |
|---|---|
| `compiler-core/src/ir.types.ts`, `compiler.interface.ts` | Experience IR shape + `Compiler` contract — no implementation |
| `runtime-core/src/runtime.interface.ts` | Mount/retrieve/merge/budget/safety-check/assemble pipeline contracts — no implementation |
| `registry-core/src/package-repository.interface.ts`, `benchmark-repository.interface.ts`, `license-repository.interface.ts`, `ledger.interface.ts` | Registry persistence contracts (packages, benchmark runs, licenses/royalties, the trust ledger) — no implementation |
| Each package's `test/*.test.ts` | Contract tests: a minimal fake implementation proves the interface is actually satisfiable and usable, without adding business logic (see ADR 0005) |

### `apps/cli` — the `xo` command-line tool

| File | Why |
|---|---|
| `src/arg-parser.ts` | Dependency-free `--flag`/`--flag value` argument parser |
| `src/commands/version.ts` | Reads the CLI's own `package.json` version |
| `src/commands/doctor.ts` | Real environment checks (Node version, platform, config-dir env var) |
| `src/commands/config-show.ts` | Resolves and prints CLI config via `@xo/config`, secrets masked |
| `src/index.ts` | `run()` dispatcher + usage text; notes that `pack`/`verify`/`publish` are intentionally not implemented yet |
| `bin/xo.js` | Executable shim (`package.json`'s `bin` entry) |
| `test/cli.test.ts` | Arg parsing, usage/help output, unknown-command exit code, doctor exit code |

## What's explicitly deferred to future modules

- Any implementation of `Compiler`, `Runtime`, or the registry
  repositories.
- Real object storage (S3/GCS/R2) and graph database (Neo4j) backends —
  interfaces are ready; only the reference (local-fs, in-memory)
  implementations exist.
- Production-grade observability (pino, an OpenTelemetry SDK exporter)
  and DI (only if hand-rolling stops scaling — see ADR 0003).
- KMS/HSM-backed signing key custody.
- `xo pack` / `xo verify` / `xo publish` CLI commands.
- A verified (networked) `docker compose up` / `docker build` run.
