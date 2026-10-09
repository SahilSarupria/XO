# Coding Standards

## Error handling: `Result` vs. `throw`

- **Expected, recoverable failures** ("package not found", "signature
  invalid", "config value out of range" at a call site that can retry or
  branch) return `Result<T, E>` from `@xo/types`. Never throw for these.
- **Programmer errors / invariant violations** (an internal precondition
  that should be structurally impossible to violate) use `assert()` from
  `@xo/errors`, which throws. This is a bug signal, not a control-flow
  outcome.
- **Unrecoverable startup failures** (a required config key is missing at
  boot) throw directly (`ConfigError`) rather than returning a `Result`,
  because there is no caller in a position to branch on it — the process
  should not start. This is the one deliberate exception to the first
  rule; it is called out explicitly in `@xo/config`'s `loadConfig` doc
  comment so it doesn't read as an inconsistency.

## Naming

- Packages: `@xo/<kebab-case-name>`, one clear concern per package.
- Files: one primary export per file, `kebab-case.ts`, and an
  `X.interface.ts` suffix for a file whose only export is a port
  (`logger.interface.ts`, `blob-store.interface.ts`).
- Branded ID types (`PackageId`, `ContentHash`, ...) live in
  `@xo/types/src/ids.ts` — never pass a bare `string` across a package
  boundary where a branded type exists for it.

## Architecture / DDD boundaries

- `packages/*-core` (`compiler-core`, `runtime-core`, `registry-core`)
  export **interfaces and types only**. A package outside `*-core` may
  implement one of these interfaces (tests do, as contract tests) but
  `*-core` itself must never gain an implementation until that's the
  explicit goal of a future module.
- Every side effect (filesystem, network, clock, randomness) is reached
  through an injected interface (`BlobStore`, `Clock`, `Logger`), never
  called as a bare global, so it can be swapped/mocked without touching
  business logic. `packages/di`'s `Container` is the composition point;
  wiring happens at the edge (CLI entrypoint, future server entrypoint),
  never inside a package's own constructor via a global singleton.
- Dependency direction is one-way: `types` -> `errors` -> everything else.
  Nothing in `packages/types` or `packages/errors` may import from any
  other package in this repo. See `docs/ARCHITECTURE.md`'s dependency
  graph.

## Testing

- Every package has a `test/` directory using `node:test` +
  `node:assert/strict`. No package ships without at least one test that
  exercises real behavior (not just "it imports without throwing").
  Interface-only packages (`compiler-core`, `runtime-core`,
  `registry-core`) get **contract tests**: a minimal fake implementation
  constructed and exercised through the interface, proving the interface
  is actually implementable and usable — never proving business logic,
  since none exists there.
- Use `@xo/testing`'s `MockLogger`/`MockClock` instead of hand-rolling
  fakes per test file.
- Tests must be deterministic: no wall-clock reads (`MockClock`), no
  reliance on file-system global state beyond a test-owned temp directory
  (see `packages/storage/test`'s `mkdtemp` pattern).

## Documentation requirements

- Every exported interface gets a doc comment explaining *why* it exists
  and, where relevant, which section of the frozen design docs it
  implements (grep for "SPECIFICATION.md" / "RUNTIME_ARCHITECTURE.md" /
  "EXPERIENCE_COMPILER.md" / "PACKAGE_README.md" references throughout
  `packages/*/src`).
- A non-obvious technology or design decision gets an ADR in
  `docs/adr/`, not just a code comment — comments explain the code as
  written; ADRs explain the alternatives that were rejected and why.

## Dependency rules

- A package's `dependencies` in `package.json` must match its
  `tsconfig.json` `references` — if you import `@xo/errors`, both files
  need to know about it. (This is not yet enforced by tooling; see
  "Still to do" in the top-level build report.)
- No package may depend on `@xo/cli` (the CLI is a leaf, not a library).
- Prefer a Node built-in over a third-party dependency when one covers
  the need — see `docs/TECH_STACK.md`'s dependency-minimalism table for
  the reasoning and the intended production swap-in, if any.

## Import rules

- Use `type`-only imports for types (`import type { Foo } from ...`) —
  enforced by `@typescript-eslint/consistent-type-imports` in
  `eslint.config.mjs`.
- Always import from a package's public entrypoint (`@xo/logger`), never
  a deep path into another package's `src/` or `dist/`.
